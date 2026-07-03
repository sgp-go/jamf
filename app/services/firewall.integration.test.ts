/**
 * firewall service 整合測試（PRD §5.4）
 *
 * 覆蓋：
 *   - computeEffectiveRules 並集：tenant base ∪ device_group rules
 *   - disabled rule 不進 effective set
 *   - applyFirewallToDevice：全量替換 + hash skip
 *   - enforce-enabled 命令一起派
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import {
  mdmDeviceFirewallState,
  mdmFirewallRules,
} from "~/db/schema/firewall.ts";
import { deviceGroups, tenants } from "~/db/schema/tenants.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import {
  applyFirewallToDevice,
  computeEffectiveRules,
  computeRuleSetHash,
} from "./firewall.ts";
import { mdmCommands } from "~/db/schema/devices.ts";

async function withFixture<T>(
  fn: (ctx: {
    tenantId: string;
    groupAId: string;
    groupBId: string;
    deviceInGroupAId: string;
    deviceInGroupAUdid: string;
    deviceNoGroupId: string;
    deviceNoGroupUdid: string;
  }) => Promise<T>,
): Promise<T> {
  const slug = `fw-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [t] = await db
    .insert(tenants)
    .values({ slug, displayName: "fw-it" })
    .returning({ id: tenants.id });
  const [cfg] = await db
    .insert(selfMdmConfigs)
    .values({
      tenantId: t.id,
      publicBaseUrl: "https://example.test",
    })
    .returning({ id: selfMdmConfigs.id });
  const [gA] = await db
    .insert(deviceGroups)
    .values({ tenantId: t.id, code: "A", displayName: "School A" })
    .returning({ id: deviceGroups.id });
  const [gB] = await db
    .insert(deviceGroups)
    .values({ tenantId: t.id, code: "B", displayName: "School B" })
    .returning({ id: deviceGroups.id });

  const [dA] = await db
    .insert(mdmDevices)
    .values({
      tenantId: t.id,
      selfMdmConfigId: cfg.id,
      deviceGroupId: gA.id,
      platform: "windows",
      udid: `windows-${crypto.randomUUID()}`,
      serialNumber: `FW-A-${Math.random().toString(36).slice(2, 7)}`,
      enrollmentStatus: "enrolled",
    })
    .returning({ id: mdmDevices.id, udid: mdmDevices.udid });

  const [dN] = await db
    .insert(mdmDevices)
    .values({
      tenantId: t.id,
      selfMdmConfigId: cfg.id,
      platform: "windows",
      udid: `windows-${crypto.randomUUID()}`,
      serialNumber: `FW-N-${Math.random().toString(36).slice(2, 7)}`,
      enrollmentStatus: "enrolled",
    })
    .returning({ id: mdmDevices.id, udid: mdmDevices.udid });

  try {
    return await fn({
      tenantId: t.id,
      groupAId: gA.id,
      groupBId: gB.id,
      deviceInGroupAId: dA.id,
      deviceInGroupAUdid: dA.udid!,
      deviceNoGroupId: dN.id,
      deviceNoGroupUdid: dN.udid!,
    });
  } finally {
    await db.delete(tenants).where(eq(tenants.id, t.id));
  }
}

async function insertRule(opts: {
  tenantId: string;
  deviceGroupId?: string | null;
  name: string;
  enabled?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(mdmFirewallRules)
    .values({
      tenantId: opts.tenantId,
      deviceGroupId: opts.deviceGroupId ?? null,
      name: opts.name,
      direction: "out",
      action: "block",
      protocol: "tcp",
      enabled: opts.enabled ?? true,
    })
    .returning({ id: mdmFirewallRules.id });
  return row.id;
}

Deno.test("computeEffectiveRules: 只回 tenant base + 所屬 group rules（不含其他 group）", async () => {
  await withFixture(async (ctx) => {
    const base = await insertRule({ tenantId: ctx.tenantId, name: "base-1" });
    const gA1 = await insertRule({
      tenantId: ctx.tenantId,
      deviceGroupId: ctx.groupAId,
      name: "A-1",
    });
    await insertRule({
      tenantId: ctx.tenantId,
      deviceGroupId: ctx.groupBId,
      name: "B-1",
    });

    const effective = await computeEffectiveRules(ctx.tenantId, ctx.groupAId);
    const ids = effective.map((r) => r.id).sort();
    assertEquals(ids, [base, gA1].sort());
  });
});

Deno.test("computeEffectiveRules: 設備無 group（NULL）→ 只回 tenant base rules", async () => {
  await withFixture(async (ctx) => {
    const base = await insertRule({ tenantId: ctx.tenantId, name: "base-only" });
    await insertRule({
      tenantId: ctx.tenantId,
      deviceGroupId: ctx.groupAId,
      name: "A-only",
    });

    const effective = await computeEffectiveRules(ctx.tenantId, null);
    assertEquals(effective.map((r) => r.id), [base]);
  });
});

Deno.test("computeEffectiveRules: enabled=false 的 rule 不在 effective set", async () => {
  await withFixture(async (ctx) => {
    const enabled = await insertRule({ tenantId: ctx.tenantId, name: "on" });
    await insertRule({
      tenantId: ctx.tenantId,
      name: "off",
      enabled: false,
    });
    const effective = await computeEffectiveRules(ctx.tenantId, null);
    assertEquals(effective.map((r) => r.id), [enabled]);
  });
});

Deno.test("computeRuleSetHash: 順序穩定（rules 順序不影響 hash）", async () => {
  await withFixture(async (ctx) => {
    const r1 = await insertRule({ tenantId: ctx.tenantId, name: "R1" });
    const r2 = await insertRule({ tenantId: ctx.tenantId, name: "R2" });
    const list1 = await computeEffectiveRules(ctx.tenantId, null);
    const reversed = [...list1].reverse();
    // 至少 2 條才能驗順序穩定
    assertEquals(list1.length, 2);
    assertEquals(list1.map((r) => r.id).sort(), [r1, r2].sort());
    assertEquals(computeRuleSetHash(list1), computeRuleSetHash(reversed));
  });
});

Deno.test("applyFirewallToDevice: 首次派發 → 生成 enforce + Add 命令、寫入 state", async () => {
  await withFixture(async (ctx) => {
    await insertRule({ tenantId: ctx.tenantId, name: "base" });
    await insertRule({
      tenantId: ctx.tenantId,
      deviceGroupId: ctx.groupAId,
      name: "A",
    });

    const result = await applyFirewallToDevice({
      deviceId: ctx.deviceInGroupAId,
      enforceEnabled: true,
    });
    assertEquals(result.skipped, false);
    assertEquals(result.effectiveRuleCount, 2);
    // 至少：enforce 3 profile x 3 field = 9 + rules 2 * ~7 field ≈ 20+
    assertEquals(result.commandUuids.length >= 10, true);

    const state = await db.query.mdmDeviceFirewallState.findFirst({
      where: eq(mdmDeviceFirewallState.deviceId, ctx.deviceInGroupAId),
    });
    assertEquals(state?.appliedRuleIds.length, 2);
    assertEquals(state?.ruleSetHash, result.ruleSetHash);
    assertEquals(state?.enforceEnabledAt !== null, true);

    // 命令實際 enqueue 進 mdm_commands
    const cmds = await db
      .select({ id: mdmCommands.id, commandType: mdmCommands.commandType })
      .from(mdmCommands)
      .where(eq(mdmCommands.deviceId, ctx.deviceInGroupAId));
    const cmdTypes = cmds.map((c) => c.commandType);
    assertEquals(cmdTypes.includes("FirewallEnforceEnabled"), true);
    assertEquals(cmdTypes.includes("FirewallRuleReplace"), true);
  });
});

Deno.test("applyFirewallToDevice: 同 rule set 再次呼叫 → skipped=rule_set_unchanged", async () => {
  await withFixture(async (ctx) => {
    await insertRule({ tenantId: ctx.tenantId, name: "R" });

    const first = await applyFirewallToDevice({
      deviceId: ctx.deviceInGroupAId,
      enforceEnabled: true,
    });
    assertEquals(first.skipped, false);

    const second = await applyFirewallToDevice({
      deviceId: ctx.deviceInGroupAId,
      enforceEnabled: true,
    });
    assertEquals(second.skipped, true);
    assertEquals(second.reason, "rule_set_unchanged");
    assertEquals(second.commandUuids.length, 0);
  });
});

Deno.test("applyFirewallToDevice: rule 集變化 → 舊 id 進 Delete、新 id 進 Add", async () => {
  await withFixture(async (ctx) => {
    const r1 = await insertRule({ tenantId: ctx.tenantId, name: "R1" });
    // 首次 apply
    await applyFirewallToDevice({
      deviceId: ctx.deviceInGroupAId,
      enforceEnabled: false,
    });
    // 刪 R1、加 R2
    await db.delete(mdmFirewallRules).where(eq(mdmFirewallRules.id, r1));
    const r2 = await insertRule({ tenantId: ctx.tenantId, name: "R2" });

    const result = await applyFirewallToDevice({
      deviceId: ctx.deviceInGroupAId,
      enforceEnabled: false,
    });
    assertEquals(result.skipped, false);
    assertEquals(result.effectiveRuleCount, 1);

    // state 現在只有 r2
    const state = await db.query.mdmDeviceFirewallState.findFirst({
      where: eq(mdmDeviceFirewallState.deviceId, ctx.deviceInGroupAId),
    });
    assertEquals(state?.appliedRuleIds, [r2]);
  });
});

Deno.test("applyFirewallToDevice: 空 rule 集 + enforceEnabled=true → 只派 enforce 命令", async () => {
  await withFixture(async (ctx) => {
    const result = await applyFirewallToDevice({
      deviceId: ctx.deviceNoGroupId,
      enforceEnabled: true,
    });
    assertEquals(result.skipped, false);
    assertEquals(result.effectiveRuleCount, 0);
    // 只有 enforce-enabled 命令（3 profile x 3 field = 9）
    assertEquals(result.commandUuids.length, 9);
  });
});
