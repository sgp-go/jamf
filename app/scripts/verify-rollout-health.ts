/**
 * 真機（真實 Postgres）整合驗證：getRolloutHealth 的 DISTINCT ON 查詢 + 健康分類。
 *
 * 比單元測試更強——在真 PG 上驗證 selectDistinctOn 生成的 SQL 確實「每設備取最新上報」。
 * 關鍵場景 device E：插兩條上報（舊 2.0.0 早時間 + 新 1.0.0 近時間），DISTINCT ON 必須
 * 取新的 1.0.0 → pending；若取錯（取到舊 2.0.0）會誤判 upgraded，斷言攔住。
 *
 * 用 throwaway tenant 隔離，結束 CASCADE 清乾淨。
 * 跑：deno run -A --env-file=.env app/scripts/verify-rollout-health.ts
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { eq, like } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { apps } from "~/db/schema/apps.ts";
import { agentReports } from "~/db/schema/agent.ts";
import { enrollWindowsDevice, getMdmDevice } from "~/services/mdm/devices.ts";
import { getRolloutHealth } from "~/services/agent-rollout.ts";

const stamp = `${performance.now()}`.replace(".", "");

// 冪等：清掉先前中斷殘留的 throwaway（slug 前綴固定，CASCADE 連帶清設備/上報）
await db.delete(tenants).where(like(tenants.slug, "verify-rollout-%"));

const [tenant] = await db
  .insert(tenants)
  .values({ slug: `verify-rollout-${stamp}`, displayName: "verify-rollout" })
  .returning({ id: tenants.id });
const tenantId = tenant.id;

const [cfg] = await db
  .insert(selfMdmConfigs)
  .values({ tenantId, publicBaseUrl: "http://127.0.0.1:3000/verify" })
  .returning({ id: selfMdmConfigs.id });

const [app] = await db
  .insert(apps)
  .values({
    tenantId,
    platform: "windows",
    kind: "msi",
    displayName: "verify-agent",
    version: "2.0.0", // 目標版本
  })
  .returning({ id: apps.id });

try {
  // enroll 5 台，記 udid → 內部 deviceId
  const ids: Record<string, string> = {};
  for (const name of ["A", "B", "C", "D", "E"]) {
    const udid = `vr-${stamp}-${name}`;
    await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId: cfg.id,
      udid,
      windowsDeviceId: `vr-win-${stamp}-${name}`,
      deviceName: name,
      osVersion: "10.0.19045",
    });
    const dev = await getMdmDevice(udid);
    if (!dev) throw new Error(`enroll 後找不到 device: ${udid}`);
    ids[name] = dev.id;
  }

  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60_000);

  await db.insert(agentReports).values([
    { tenantId, deviceId: ids.A, appVersion: "2.0.0", reportedAt: ago(5) }, // = target → upgraded
    { tenantId, deviceId: ids.B, appVersion: "1.0.0", reportedAt: ago(90) }, // 舊 + 超 30min 窗 → silent
    { tenantId, deviceId: ids.C, appVersion: "1.0.0", reportedAt: ago(5) }, // 未升級但近期有報 → pending
    // D: 無上報 → neverReported
    // E: 兩條——舊 2.0.0(昨天) + 新 1.0.0(2min前)；DISTINCT ON 須取新 → pending
    { tenantId, deviceId: ids.E, appVersion: "2.0.0", reportedAt: ago(1440) },
    { tenantId, deviceId: ids.E, appVersion: "1.0.0", reportedAt: ago(2) },
  ]);

  const health = await getRolloutHealth({ tenantId, appId: app.id, windowMinutes: 30 });

  assertEquals(health.targetVersion, "2.0.0");
  assert(health.upgraded.includes(ids.A), "A 應 upgraded");
  assert(health.silent.includes(ids.B), "B 應 silent");
  assert(health.pending.includes(ids.C), "C 應 pending");
  assert(health.neverReported.includes(ids.D), "D 應 neverReported");
  // ⭐ DISTINCT ON 關鍵驗證：E 取最新 1.0.0 → pending，不得誤判 upgraded
  assert(
    health.pending.includes(ids.E),
    "E 應 pending（DISTINCT ON 取最新 1.0.0）",
  );
  assert(
    !health.upgraded.includes(ids.E),
    "E 不得 upgraded —— 若失敗代表 DISTINCT ON 取到了舊行 2.0.0（查詢錯誤）",
  );

  console.log("✅ 全部斷言通過：DISTINCT ON 每設備取最新上報 + 四分類正確");
  console.log(JSON.stringify(
    {
      targetVersion: health.targetVersion,
      upgraded: health.upgraded.length,
      silent: health.silent.length,
      pending: health.pending.length,
      neverReported: health.neverReported.length,
    },
    null,
    2,
  ));
} finally {
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  console.log("throwaway tenant 已清理");
}
