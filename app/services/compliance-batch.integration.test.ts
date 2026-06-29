/**
 * compliance-batch 整合測試 — DB 持久化評估歷史。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { AppError } from "~/lib/errors.ts";
import {
  batchEvaluatePolicy,
  createPolicy,
  deletePolicy,
  getDeviceHistory,
  listLatestResults,
  listPolicies,
  updatePolicy,
} from "./compliance-batch.ts";

async function withTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const slug = `comp-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [t] = await db
    .insert(tenants)
    .values({ slug, displayName: "comp-it" })
    .returning({ id: tenants.id });
  try {
    return await fn(t.id);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, t.id));
  }
}

async function insertDevice(opts: {
  tenantId: string;
  osVersion?: string | null;
  lastSeenAt?: Date | null;
}) {
  const [row] = await db
    .insert(mdmDevices)
    .values({
      tenantId: opts.tenantId,
      platform: "windows",
      osVersion: opts.osVersion ?? null,
      lastSeenAt: opts.lastSeenAt ?? null,
    })
    .returning({ id: mdmDevices.id });
  return row.id;
}

Deno.test("createPolicy: 至少一條規則,否則 400", async () => {
  await withTenant(async (tenantId) => {
    const err = await assertRejects(
      () => createPolicy({ tenantId, input: { name: "empty" } }),
      AppError,
    );
    assertEquals(err.code, "empty_policy");
  });
});

Deno.test("createPolicy + listPolicies + getPolicy 流程", async () => {
  await withTenant(async (tenantId) => {
    const p = await createPolicy({
      tenantId,
      input: { name: "Win11 基線", minOSVersion: "10.0.26100" },
    });
    assertEquals(p.name, "Win11 基線");
    assertEquals(p.minOSVersion, "10.0.26100");
    assertEquals(p.maxOfflineDays, null);
    assertEquals(p.isActive, true);

    const all = await listPolicies({ tenantId });
    assertEquals(all.length, 1);
  });
});

Deno.test("updatePolicy: 三態 patch", async () => {
  await withTenant(async (tenantId) => {
    const p = await createPolicy({
      tenantId,
      input: { name: "P1", minOSVersion: "10.0.0", maxOfflineDays: 5 },
    });
    const updated = await updatePolicy({
      tenantId,
      policyId: p.id,
      patch: { maxOfflineDays: null, isActive: false },
    });
    assertEquals(updated.maxOfflineDays, null); // 清空
    assertEquals(updated.minOSVersion, "10.0.0"); // 未動
    assertEquals(updated.isActive, false);
  });
});

Deno.test("deletePolicy: cascade 清歷史 + 二次刪 404", async () => {
  await withTenant(async (tenantId) => {
    const p = await createPolicy({
      tenantId,
      input: { name: "ToDelete", minOSVersion: "10.0.0" },
    });
    await insertDevice({ tenantId, osVersion: "9.0.0" });
    await batchEvaluatePolicy({ tenantId, policyId: p.id });
    const history = await listLatestResults({ tenantId, policyId: p.id });
    assertEquals(history.length, 1);

    await deletePolicy({ tenantId, policyId: p.id });

    // results cascade 已清:查不到 results 也不報錯,回空陣列
    const afterDelete = await listLatestResults({ tenantId, policyId: p.id });
    assertEquals(afterDelete.length, 0);

    // 二次刪 → 404
    const err = await assertRejects(
      () => deletePolicy({ tenantId, policyId: p.id }),
      AppError,
    );
    assertEquals(err.code, "policy_not_found");
  });
});

Deno.test("batchEvaluatePolicy: 評估 + 持久化 + 統計正確", async () => {
  await withTenant(async (tenantId) => {
    const policy = await createPolicy({
      tenantId,
      input: { name: "Win11 24H2", minOSVersion: "10.0.26100" },
    });
    // 合規:OS=26200
    const d1 = await insertDevice({ tenantId, osVersion: "10.0.26200" });
    // 不合規:OS 太舊
    const d2 = await insertDevice({ tenantId, osVersion: "10.0.19045" });
    // 不合規:OS 未知
    const d3 = await insertDevice({ tenantId, osVersion: null });

    const summary = await batchEvaluatePolicy({ tenantId, policyId: policy.id });
    assertEquals(summary.total, 3);
    assertEquals(summary.compliant, 1);
    assertEquals(summary.nonCompliant, 2);

    const all = await listLatestResults({ tenantId, policyId: policy.id });
    assertEquals(all.length, 3);

    const nonCompliant = await listLatestResults({
      tenantId,
      policyId: policy.id,
      onlyNonCompliant: true,
    });
    assertEquals(nonCompliant.length, 2);
    assertEquals(nonCompliant.every((r) => !r.compliant), true);

    // 確認 d1 那筆是合規
    const d1Result = all.find((r) => r.deviceId === d1)!;
    assertEquals(d1Result.compliant, true);
    assertEquals(d1Result.violations.length, 0);
  });
});

Deno.test("batchEvaluatePolicy: isActive=false 拒絕評估", async () => {
  await withTenant(async (tenantId) => {
    const p = await createPolicy({
      tenantId,
      input: { name: "Paused", minOSVersion: "10.0.0", isActive: false },
    });
    const err = await assertRejects(
      () => batchEvaluatePolicy({ tenantId, policyId: p.id }),
      AppError,
    );
    assertEquals(err.code, "policy_inactive");
  });
});

Deno.test("listLatestResults: 多次評估只回最新一筆 per device", async () => {
  await withTenant(async (tenantId) => {
    const p = await createPolicy({
      tenantId,
      input: { name: "Multi", minOSVersion: "10.0.0" },
    });
    const dev = await insertDevice({ tenantId, osVersion: "10.0.0" });

    // 第一次評估
    await batchEvaluatePolicy({ tenantId, policyId: p.id });
    await new Promise((r) => setTimeout(r, 5)); // 確保 evaluatedAt 有差距
    // 設備 OS 降級成不合規
    await db.update(mdmDevices).set({ osVersion: "9.0.0" }).where(eq(mdmDevices.id, dev));
    await batchEvaluatePolicy({ tenantId, policyId: p.id });

    // listLatest 只回 1 筆(最新),且應是不合規(reflecting 最新 osVersion)
    const latest = await listLatestResults({ tenantId, policyId: p.id });
    assertEquals(latest.length, 1);
    assertEquals(latest[0].compliant, false);

    // history 回 2 筆(時序倒序)
    const history = await getDeviceHistory({ tenantId, deviceId: dev });
    assertEquals(history.length, 2);
    assertEquals(history[0].compliant, false); // 最新
    assertEquals(history[1].compliant, true); // 第一次
  });
});

Deno.test("getDeviceHistory: limit 上限 500", async () => {
  await withTenant(async (tenantId) => {
    const p = await createPolicy({
      tenantId,
      input: { name: "H", minOSVersion: "10.0.0" },
    });
    const dev = await insertDevice({ tenantId, osVersion: "10.0.0" });
    await batchEvaluatePolicy({ tenantId, policyId: p.id });

    // limit=1000 → 應裁到 500
    const rows = await getDeviceHistory({ tenantId, deviceId: dev, limit: 1000 });
    // 只插一筆;主要驗 limit 不會 throw
    assertEquals(rows.length, 1);
  });
});
