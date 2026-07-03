/**
 * Firewall service（PRD §5.4）
 *
 * 兩層規則並集：tenant base rules（device_group_id NULL）∪ 設備所屬 device_group rules
 * 派發策略：全量替換 —— 每次 apply 都 Delete 上次全部 + Add 新 effective rules；
 *          用 ruleSetHash 快速判斷「無變化 skip」避免 unchanged 重派。
 */
import { createHash } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import {
  mdmDeviceFirewallState,
  mdmFirewallRules,
  type MdmFirewallRule,
} from "~/db/schema/firewall.ts";
import { AppError } from "~/lib/errors.ts";
import {
  buildFirewallRulesDiff,
  type FirewallRuleInput,
} from "~/services/mdm/windows/csp-firewall-rules.ts";
import { buildFirewallPolicy } from "~/services/mdm/windows/csp.ts";
import { enqueueWindowsCommandsBatch } from "~/services/mdm/windows/command.ts";

/**
 * 計算某設備的最終生效規則集：tenant base（device_group_id IS NULL）∪ 所屬 group rules。
 * 只回 enabled=true 的規則；disabled 規則保留在 DB 但不下發到設備。
 */
export async function computeEffectiveRules(
  tenantId: string,
  deviceGroupId: string | null,
): Promise<MdmFirewallRule[]> {
  const groupFilter = deviceGroupId
    ? or(
      isNull(mdmFirewallRules.deviceGroupId),
      eq(mdmFirewallRules.deviceGroupId, deviceGroupId),
    )
    : isNull(mdmFirewallRules.deviceGroupId);
  return db
    .select()
    .from(mdmFirewallRules)
    .where(
      and(
        eq(mdmFirewallRules.tenantId, tenantId),
        eq(mdmFirewallRules.enabled, true),
        groupFilter!,
      ),
    );
}

/** 穩定序列化計算 hash（不依賴屬性順序） */
export function computeRuleSetHash(rules: readonly MdmFirewallRule[]): string {
  const sorted = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  const payload = sorted.map((r) => ({
    id: r.id,
    n: r.name,
    d: r.direction,
    a: r.action,
    p: r.protocol,
    lp: r.localPortRanges,
    rp: r.remotePortRanges,
    la: r.localAddressRanges,
    ra: r.remoteAddressRanges,
    fp: r.appFilePath,
    pf: r.appPackageFamilyName,
    pr: r.profiles,
  }));
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function ruleToCspInput(r: MdmFirewallRule): FirewallRuleInput {
  return {
    ruleId: r.id,
    name: r.name,
    description: r.description,
    direction: r.direction,
    action: r.action,
    protocol: r.protocol,
    localPortRanges: r.localPortRanges,
    remotePortRanges: r.remotePortRanges,
    localAddressRanges: r.localAddressRanges,
    remoteAddressRanges: r.remoteAddressRanges,
    appFilePath: r.appFilePath,
    appPackageFamilyName: r.appPackageFamilyName,
    profiles: r.profiles,
    enabled: r.enabled,
  };
}

export interface ApplyFirewallResult {
  deviceId: string;
  skipped: boolean;
  reason?: string;
  effectiveRuleCount: number;
  commandUuids: string[];
  ruleSetHash: string;
}

/**
 * 派發 firewall rules 到單台設備（全量替換 + hash 判斷 skip）。
 * 同時可選 `enforceEnabled=true` 一起推「保持三 profile 開啟」政策。
 */
export async function applyFirewallToDevice(opts: {
  deviceId: string;
  /** 一併派 enforce-enabled（三 profile enable）。預設 true —— PRD 語義：保持防火牆開著 */
  enforceEnabled?: boolean;
}): Promise<ApplyFirewallResult> {
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.id, opts.deviceId),
    columns: {
      id: true,
      tenantId: true,
      deviceGroupId: true,
      udid: true,
      platform: true,
    },
  });
  if (!device) {
    throw new AppError(404, "device_not_found", `Device ${opts.deviceId} not found`);
  }
  if (device.platform !== "windows") {
    throw new AppError(
      400,
      "platform_unsupported",
      `Firewall CSP 僅支援 Windows；device platform=${device.platform}`,
    );
  }
  if (!device.udid) {
    throw new AppError(
      400,
      "device_no_udid",
      `Device ${opts.deviceId} 無 udid，尚未完成 enrollment`,
    );
  }

  const effectiveRules = await computeEffectiveRules(
    device.tenantId,
    device.deviceGroupId,
  );
  const newHash = computeRuleSetHash(effectiveRules);
  const newRuleIds = effectiveRules.map((r) => r.id);
  const enforceEnabled = opts.enforceEnabled ?? true;

  const state = await db.query.mdmDeviceFirewallState.findFirst({
    where: eq(mdmDeviceFirewallState.deviceId, device.id),
  });

  // Skip 判斷：rule set 無變且 enforce-enabled 已推過 → 完全 no-op
  if (
    state?.ruleSetHash === newHash &&
    (!enforceEnabled || state.enforceEnabledAt !== null)
  ) {
    return {
      deviceId: device.id,
      skipped: true,
      reason: "rule_set_unchanged",
      effectiveRuleCount: effectiveRules.length,
      commandUuids: [],
      ruleSetHash: newHash,
    };
  }

  const oldRuleIds = state?.appliedRuleIds ?? [];
  const toAdd = effectiveRules.map(ruleToCspInput);
  const diffCmds = buildFirewallRulesDiff(oldRuleIds, toAdd);

  // 可選：三 profile enforce-enabled 命令
  const enforceCmds = enforceEnabled ? buildFirewallPolicy({ enabled: true }) : [];

  const allCommands = [
    ...enforceCmds.map((c) => ({ commandType: "FirewallEnforceEnabled", command: c })),
    ...diffCmds.map((c) => ({
      commandType: c.verb === "Delete" ? "FirewallRuleDelete" : "FirewallRuleAdd",
      command: c,
    })),
  ];

  if (allCommands.length === 0) {
    // enforce-enabled 也已 apply 過、rules 也無變化 → skip
    return {
      deviceId: device.id,
      skipped: true,
      reason: "nothing_to_send",
      effectiveRuleCount: effectiveRules.length,
      commandUuids: [],
      ruleSetHash: newHash,
    };
  }

  const commandUuids = await enqueueWindowsCommandsBatch({
    deviceUdid: device.udid,
    commands: allCommands,
  });

  // Upsert state
  const now = new Date();
  const enforceAt = enforceEnabled ? now : state?.enforceEnabledAt ?? null;
  await db
    .insert(mdmDeviceFirewallState)
    .values({
      deviceId: device.id,
      tenantId: device.tenantId,
      appliedRuleIds: newRuleIds,
      ruleSetHash: newHash,
      enforceEnabledAt: enforceAt,
      appliedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: mdmDeviceFirewallState.deviceId,
      set: {
        appliedRuleIds: newRuleIds,
        ruleSetHash: newHash,
        enforceEnabledAt: enforceAt,
        appliedAt: now,
        updatedAt: now,
      },
    });

  return {
    deviceId: device.id,
    skipped: false,
    effectiveRuleCount: effectiveRules.length,
    commandUuids,
    ruleSetHash: newHash,
  };
}

/**
 * 只派「保持三 profile 開啟」政策，不動 rules。適合 enrollment hook 時輕量調用。
 */
export async function enforceFirewallEnabledOnDevice(
  deviceId: string,
): Promise<{ deviceId: string; commandUuids: string[] }> {
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.id, deviceId),
    columns: { id: true, tenantId: true, udid: true, platform: true },
  });
  if (!device) {
    throw new AppError(404, "device_not_found", `Device ${deviceId} not found`);
  }
  if (device.platform !== "windows") {
    throw new AppError(400, "platform_unsupported", "Windows only");
  }
  if (!device.udid) {
    throw new AppError(400, "device_no_udid", `Device ${deviceId} 無 udid`);
  }

  const cmds = buildFirewallPolicy({ enabled: true });
  const commandUuids = await enqueueWindowsCommandsBatch({
    deviceUdid: device.udid,
    commands: cmds.map((c) => ({ commandType: "FirewallEnforceEnabled", command: c })),
  });

  const now = new Date();
  await db
    .insert(mdmDeviceFirewallState)
    .values({
      deviceId: device.id,
      tenantId: device.tenantId,
      appliedRuleIds: [],
      ruleSetHash: null,
      enforceEnabledAt: now,
      appliedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: mdmDeviceFirewallState.deviceId,
      set: { enforceEnabledAt: now, updatedAt: now },
    });

  return { deviceId: device.id, commandUuids };
}
