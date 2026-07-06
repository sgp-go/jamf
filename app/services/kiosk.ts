/**
 * Kiosk Mode service（PRD Phase 3 — Windows AssignedAccess）
 *
 * 職責：
 *   - Kiosk profile CRUD
 *   - 對設備 / device_group 派發 assignment
 *   - Apply / Remove Kiosk configuration 到單台設備（Replace / Delete verb）
 *   - 對帳 kiosk_device_states
 *
 * 退出：主路徑 = 服務端 removeKioskFromDevice；應急 = breakoutSequence + ITAdmin
 * LAPS 密碼（現有 /devices/{did}/laps-password 端點查詢，本模組不重複實現）。
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import {
  kioskAssignments,
  kioskDeviceStates,
  kioskProfiles,
  type KioskAssignment,
  type KioskDeviceState,
  type KioskProfile,
  type NewKioskAssignment,
  type NewKioskProfile,
} from "~/db/schema/kiosk.ts";
import { AppError } from "~/lib/errors.ts";
import {
  buildKioskApply,
  buildKioskRemove,
  type KioskAppType,
  type KioskEdgeVariant,
} from "~/services/mdm/windows/csp-kiosk.ts";
import {
  buildEdgeAdmxInstall,
  buildEdgeUrlAllowlist,
  buildEdgeUrlAllowlistClear,
  buildEdgeUrlBlocklist,
  buildEdgeUrlBlocklistClear,
} from "~/services/mdm/windows/csp-browser.ts";
import { buildReboot } from "~/services/mdm/windows/csp.ts";
import type { SyncMLCommand } from "~/services/mdm/windows/syncml.ts";

/**
 * 何時「觸發 Kiosk 生效」：
 *   - `next_logon`：不派額外命令，靠用戶下次 sign in 觸發 AssignedAccess attach（Windows 設計）
 *   - `reboot`：apply 完 Kiosk XML 後立即派 RebootNow → 設備重啟 → AutoLogon 進 Kiosk（5min 倒數通知）
 * force_signout 尚未支援（Windows MDM 沒有標準 logoff CSP，需 Custom PowerShell）。
 */
export type KioskActivation = "next_logon" | "reboot";
import { enqueueWindowsCommandsBatch } from "~/services/mdm/windows/command.ts";

export interface KioskProfileInput {
  name: string;
  description?: string | null;
  appType: KioskAppType;
  edgeUrl?: string | null;
  edgeVariant?: KioskEdgeVariant | null;
  aumid?: string | null;
  autoLogonAccount?: string;
  breakoutSequence?: string | null;
  /** Edge URL 白名單（僅 edge_kiosk 生效）；null 或空陣列 = 不加限制 */
  allowedUrls?: string[] | null;
}

function validateProfileInput(input: KioskProfileInput): void {
  if (input.appType === "edge_kiosk") {
    if (!input.edgeUrl || !input.edgeVariant) {
      throw new AppError(
        400,
        "edge_kiosk_missing_fields",
        "edge_kiosk 需要 edgeUrl 與 edgeVariant",
      );
    }
    if (input.aumid) {
      throw new AppError(
        400,
        "edge_kiosk_extra_fields",
        "edge_kiosk 不接受 aumid（改用 edgeUrl）",
      );
    }
  } else {
    if (!input.aumid) {
      throw new AppError(400, "uwp_missing_aumid", "uwp 需要 aumid");
    }
    if (input.edgeUrl || input.edgeVariant) {
      throw new AppError(
        400,
        "uwp_extra_fields",
        "uwp 不接受 edgeUrl / edgeVariant",
      );
    }
    if (input.allowedUrls && input.allowedUrls.length > 0) {
      throw new AppError(
        400,
        "uwp_extra_fields",
        "uwp 模式不支援 allowedUrls（URL 白名單僅對 edge_kiosk 生效）",
      );
    }
  }
}

/** 正規化 allowedUrls：空陣列/undefined/null 統一為 null，減少下游判斷 */
function normalizeAllowedUrls(v: string[] | null | undefined): string[] | null {
  if (!v || v.length === 0) return null;
  return v;
}

export async function createKioskProfile(opts: {
  tenantId: string;
  input: KioskProfileInput;
  createdBy?: string;
}): Promise<KioskProfile> {
  validateProfileInput(opts.input);
  const row: NewKioskProfile = {
    tenantId: opts.tenantId,
    name: opts.input.name,
    description: opts.input.description ?? null,
    appType: opts.input.appType,
    edgeUrl: opts.input.edgeUrl ?? null,
    edgeVariant: opts.input.edgeVariant ?? null,
    aumid: opts.input.aumid ?? null,
    autoLogonAccount: opts.input.autoLogonAccount ?? "student",
    breakoutSequence: opts.input.breakoutSequence ?? null,
    allowedUrls: normalizeAllowedUrls(opts.input.allowedUrls),
    createdBy: opts.createdBy ?? null,
  };
  const [created] = await db.insert(kioskProfiles).values(row).returning();
  return created;
}

export async function updateKioskProfile(opts: {
  tenantId: string;
  profileId: string;
  input: KioskProfileInput;
}): Promise<KioskProfile> {
  validateProfileInput(opts.input);
  const [updated] = await db
    .update(kioskProfiles)
    .set({
      name: opts.input.name,
      description: opts.input.description ?? null,
      appType: opts.input.appType,
      edgeUrl: opts.input.edgeUrl ?? null,
      edgeVariant: opts.input.edgeVariant ?? null,
      aumid: opts.input.aumid ?? null,
      autoLogonAccount: opts.input.autoLogonAccount ?? "student",
      breakoutSequence: opts.input.breakoutSequence ?? null,
      allowedUrls: normalizeAllowedUrls(opts.input.allowedUrls),
      version: sql`${kioskProfiles.version} + 1`,
    })
    .where(
      and(
        eq(kioskProfiles.id, opts.profileId),
        eq(kioskProfiles.tenantId, opts.tenantId),
      ),
    )
    .returning();
  if (!updated) {
    throw new AppError(404, "kiosk_profile_not_found", "Kiosk profile not found");
  }
  return updated;
}

export async function deleteKioskProfile(opts: {
  tenantId: string;
  profileId: string;
}): Promise<void> {
  const result = await db
    .delete(kioskProfiles)
    .where(
      and(
        eq(kioskProfiles.id, opts.profileId),
        eq(kioskProfiles.tenantId, opts.tenantId),
      ),
    )
    .returning({ id: kioskProfiles.id });
  if (result.length === 0) {
    throw new AppError(404, "kiosk_profile_not_found", "Kiosk profile not found");
  }
}

export async function listKioskProfiles(
  tenantId: string,
): Promise<KioskProfile[]> {
  return db
    .select()
    .from(kioskProfiles)
    .where(eq(kioskProfiles.tenantId, tenantId));
}

export async function getKioskProfile(opts: {
  tenantId: string;
  profileId: string;
}): Promise<KioskProfile> {
  const [row] = await db
    .select()
    .from(kioskProfiles)
    .where(
      and(
        eq(kioskProfiles.id, opts.profileId),
        eq(kioskProfiles.tenantId, opts.tenantId),
      ),
    );
  if (!row) {
    throw new AppError(404, "kiosk_profile_not_found", "Kiosk profile not found");
  }
  return row;
}

// ============================================================
// Assignment
// ============================================================

export interface AssignKioskInput {
  scope: "device_group" | "device";
  targetId: string;
}

export async function assignKiosk(opts: {
  tenantId: string;
  profileId: string;
  input: AssignKioskInput;
  createdBy?: string;
}): Promise<KioskAssignment> {
  const row: NewKioskAssignment = {
    tenantId: opts.tenantId,
    profileId: opts.profileId,
    scope: opts.input.scope,
    deviceGroupId: opts.input.scope === "device_group" ? opts.input.targetId : null,
    deviceId: opts.input.scope === "device" ? opts.input.targetId : null,
    createdBy: opts.createdBy ?? null,
  };
  const [created] = await db.insert(kioskAssignments).values(row).returning();
  return created;
}

export async function unassignKiosk(opts: {
  tenantId: string;
  assignmentId: string;
}): Promise<void> {
  const result = await db
    .delete(kioskAssignments)
    .where(
      and(
        eq(kioskAssignments.id, opts.assignmentId),
        eq(kioskAssignments.tenantId, opts.tenantId),
      ),
    )
    .returning({ id: kioskAssignments.id });
  if (result.length === 0) {
    throw new AppError(404, "assignment_not_found", "Assignment not found");
  }
}

// ============================================================
// Apply / Remove
// ============================================================

export interface KioskApplyResult {
  deviceId: string;
  profileId: string;
  commandUuids: string[];
  version: number;
}

/**
 * 派 Kiosk 到單台設備：build XML → enqueue Replace → 更新 state。
 * enqueueWindowsCommandsBatch 內建 WNS push（秒級喚醒 dmwappushservice）。
 *
 * activation 決定何時生效（見 KioskActivation type）：預設 next_logon（不派 reboot）。
 */
export async function applyKioskToDevice(opts: {
  tenantId: string;
  deviceId: string;
  profileId: string;
  activation?: KioskActivation;
}): Promise<KioskApplyResult> {
  const device = await db.query.mdmDevices.findFirst({
    where: and(
      eq(mdmDevices.id, opts.deviceId),
      eq(mdmDevices.tenantId, opts.tenantId),
    ),
    columns: { id: true, tenantId: true, udid: true, platform: true },
  });
  if (!device) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  if (device.platform !== "windows") {
    throw new AppError(
      400,
      "platform_unsupported",
      "Kiosk CSP 僅支援 Windows",
    );
  }
  if (!device.udid) {
    throw new AppError(400, "device_no_udid", "Device 尚未 enrollment");
  }

  const profile = await getKioskProfile({
    tenantId: opts.tenantId,
    profileId: opts.profileId,
  });

  // 切換 profile 需要先 Delete 再 Replace：真機教訓（PF5XSMN1 2026-07-06）
  // 直接對 active kiosk Replace 換另一個 profileId 會 SyncML 500。
  // 同一 profile 重派（例如 version 升）不用 Delete，Replace 是 idempotent 的。
  const existing = await db
    .select()
    .from(kioskDeviceStates)
    .where(eq(kioskDeviceStates.deviceId, device.id));
  const existingState = existing[0];
  const needsClearFirst = existingState?.status === "active" &&
    existingState.profileId !== profile.id;

  const applyCmd = buildKioskApply({
    appType: profile.appType,
    edgeUrl: profile.edgeUrl ?? undefined,
    edgeVariant: profile.edgeVariant ?? undefined,
    aumid: profile.aumid ?? undefined,
    autoLogonAccount: profile.autoLogonAccount,
    breakoutSequence: profile.breakoutSequence,
  });

  // Edge URL policy 派發（僅 edge_kiosk 且 allowedUrls 非空時）
  //
  // ⚠️ Chromium URLAllowlist **單獨無效**：官方語義是「白名單覆蓋 URLBlocklist」，
  // 必須同時派 `URLBlocklist=["*"]`（block 所有）+ URLAllowlist（允許例外），
  // Edge 才會鎖到只准白名單內 URL。單派 URLAllowlist 等同「無 policy」——
  // 這是真機 PF5XSMN1 2026-07-06 驗證的坑（allowedUrls=[bing.com] 但新分頁還能開任意網址）。
  //
  // ADMX ingest 每次都帶（Replace idempotent，補新版 URLAllowlist policy 定義）
  const allowedUrls = profile.allowedUrls ?? [];
  const edgePolicyCmds: { commandType: string; command: SyncMLCommand }[] = [];
  if (profile.appType === "edge_kiosk") {
    edgePolicyCmds.push({
      commandType: "EdgeAdmxInstall",
      command: buildEdgeAdmxInstall(),
    });
    if (allowedUrls.length > 0) {
      edgePolicyCmds.push({
        commandType: "EdgeUrlBlocklist",
        command: buildEdgeUrlBlocklist(["*"]),
      });
      edgePolicyCmds.push({
        commandType: "EdgeUrlAllowlist",
        command: buildEdgeUrlAllowlist(allowedUrls),
      });
    } else {
      edgePolicyCmds.push({
        commandType: "EdgeUrlBlocklistClear",
        command: buildEdgeUrlBlocklistClear(),
      });
      edgePolicyCmds.push({
        commandType: "EdgeUrlAllowlistClear",
        command: buildEdgeUrlAllowlistClear(),
      });
    }
  } else {
    // UWP 模式派 clear 防止之前 edge_kiosk 遺留的白/黑名單影響 Edge 訪問桌面環境
    edgePolicyCmds.push({
      commandType: "EdgeUrlBlocklistClear",
      command: buildEdgeUrlBlocklistClear(),
    });
    edgePolicyCmds.push({
      commandType: "EdgeUrlAllowlistClear",
      command: buildEdgeUrlAllowlistClear(),
    });
  }

  const activation = opts.activation ?? "next_logon";
  // KioskReboot 必須另一個 batch 派：跟 KioskApply Replace 放同 SyncML session
  // 內會相互干擾（真機 PF5XSMN1 觀測到 KioskApply 500 + KioskReboot 200 的怪
  // 現象），分批避免 side effect。
  const commands: { commandType: string; command: SyncMLCommand }[] = [
    ...(needsClearFirst
      ? [{ commandType: "KioskRemove", command: buildKioskRemove() }]
      : []),
    { commandType: "KioskApply", command: applyCmd },
    ...edgePolicyCmds,
  ];

  const commandUuids = await enqueueWindowsCommandsBatch({
    deviceUdid: device.udid,
    commands,
  });
  // KioskApply 在 commands 陣列的 index：needsClearFirst 時 [Remove, Apply, ...] index=1，否則 [Apply, ...] index=0
  const kioskApplyCmdUuid = commandUuids[needsClearFirst ? 1 : 0] ?? null;

  // activation=reboot：延遲 5s 後 fire-and-forget 派 RebootNow
  // 立即派會跟 apply batch 的 SyncML session 撞（真機觀測 Apply 500/516 +
  // Reboot 200，即使分兩批發也一樣）。延遲 5s 讓設備完整處理 apply session
  // 再收 reboot push。5s 內若 backend 重啟則 reboot 丟失 —— acceptable，
  // apply 主命令已到設備，管理員可再手動派 reboot。
  if (activation === "reboot") {
    const udid = device.udid;
    setTimeout(() => {
      enqueueWindowsCommandsBatch({
        deviceUdid: udid,
        commands: [
          { commandType: "KioskReboot", command: buildReboot("RebootNow") },
        ],
      }).catch((e) => {
        console.error(
          `[Kiosk] delayed reboot enqueue failed for device=${opts.deviceId}:`,
          e,
        );
      });
    }, 5000);
  }

  const now = new Date();
  await db
    .insert(kioskDeviceStates)
    .values({
      deviceId: device.id,
      tenantId: device.tenantId,
      profileId: profile.id,
      status: "pending",
      appliedVersion: null,
      lastCommandId: kioskApplyCmdUuid,
      errorDetail: null,
      deployedAt: now,
      removedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: kioskDeviceStates.deviceId,
      set: {
        profileId: profile.id,
        status: "pending",
        appliedVersion: null,
        lastCommandId: kioskApplyCmdUuid,
        errorDetail: null,
        deployedAt: now,
        removedAt: null,
        updatedAt: now,
      },
    });

  return {
    deviceId: device.id,
    profileId: profile.id,
    commandUuids,
    version: profile.version,
  };
}

export interface KioskRemoveResult {
  deviceId: string;
  commandUuids: string[];
}

/**
 * 移除 Kiosk configuration → 恢復桌面。
 * 即使 kiosk_device_states 沒紀錄也允許 Delete verb（幂等清理）。
 *
 * activation 決定何時生效（對稱 applyKioskToDevice）：
 *   - `next_logon`（預設）：只撤 config，用戶下次 sign in 才回普通桌面
 *   - `reboot`：撤 config 後 5s 延遲派 RebootNow，設備自動重啟後 AutoLogon
 *     進普通桌面（kiosk config 已清所以不進 kiosk）
 */
export async function removeKioskFromDevice(opts: {
  tenantId: string;
  deviceId: string;
  activation?: KioskActivation;
}): Promise<KioskRemoveResult> {
  const device = await db.query.mdmDevices.findFirst({
    where: and(
      eq(mdmDevices.id, opts.deviceId),
      eq(mdmDevices.tenantId, opts.tenantId),
    ),
    columns: { id: true, tenantId: true, udid: true, platform: true },
  });
  if (!device) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  if (device.platform !== "windows") {
    throw new AppError(400, "platform_unsupported", "Kiosk CSP 僅支援 Windows");
  }
  if (!device.udid) {
    throw new AppError(400, "device_no_udid", "Device 尚未 enrollment");
  }

  // 撤 kiosk 同步清 Edge URLBlocklist + URLAllowlist（防 edge_kiosk 帶的白/黑名單
  // 在 disable 後仍影響學生桌面 Edge）
  const commandUuids = await enqueueWindowsCommandsBatch({
    deviceUdid: device.udid,
    commands: [
      { commandType: "KioskRemove", command: buildKioskRemove() },
      {
        commandType: "EdgeUrlBlocklistClear",
        command: buildEdgeUrlBlocklistClear(),
      },
      {
        commandType: "EdgeUrlAllowlistClear",
        command: buildEdgeUrlAllowlistClear(),
      },
    ],
  });

  const now = new Date();
  await db
    .insert(kioskDeviceStates)
    .values({
      deviceId: device.id,
      tenantId: device.tenantId,
      profileId: null,
      status: "removed",
      lastCommandId: commandUuids[commandUuids.length - 1] ?? null,
      removedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: kioskDeviceStates.deviceId,
      set: {
        status: "removed",
        lastCommandId: commandUuids[commandUuids.length - 1] ?? null,
        removedAt: now,
        updatedAt: now,
      },
    });

  // activation=reboot：延遲 5s 派 RebootNow（跟 apply 一致，避免跟 Delete session 撞）
  if (opts.activation === "reboot") {
    const udid = device.udid;
    setTimeout(() => {
      enqueueWindowsCommandsBatch({
        deviceUdid: udid,
        commands: [
          { commandType: "KioskReboot", command: buildReboot("RebootNow") },
        ],
      }).catch((e) => {
        console.error(
          `[Kiosk] delayed reboot enqueue failed for device=${opts.deviceId}:`,
          e,
        );
      });
    }, 5000);
  }

  return { deviceId: device.id, commandUuids };
}

export async function getKioskState(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<KioskDeviceState | null> {
  const [row] = await db
    .select()
    .from(kioskDeviceStates)
    .where(
      and(
        eq(kioskDeviceStates.deviceId, opts.deviceId),
        eq(kioskDeviceStates.tenantId, opts.tenantId),
      ),
    );
  return row ?? null;
}
