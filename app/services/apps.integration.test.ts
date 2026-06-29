/**
 * apps service 整合測試（Group B：分類 / 授權 / metadata 更新）。
 *
 * 覆蓋:
 *   - updateAppMetadata 三態 patch（undefined=不動 / null=清空 / 值=寫入）
 *   - listAppsByTenant 帶 category 過濾
 *   - getAppLicenseUsage：licenseCount null（無限制）、licenseCount 50 未超、超限
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { apps, appAssignments } from "~/db/schema/apps.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { tenants } from "~/db/schema/tenants.ts";
import {
  getAppLicenseUsage,
  listAppsByTenant,
  updateAppMetadata,
} from "./apps.ts";

async function withTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const slug = `apps-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [t] = await db
    .insert(tenants)
    .values({ slug, displayName: "apps-it" })
    .returning({ id: tenants.id });
  try {
    return await fn(t.id);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, t.id));
  }
}

async function insertApp(opts: {
  tenantId: string;
  displayName: string;
  category?: string | null;
  licenseCount?: number | null;
}) {
  const [row] = await db
    .insert(apps)
    .values({
      tenantId: opts.tenantId,
      platform: "windows",
      kind: "msi",
      displayName: opts.displayName,
      version: "1.0.0",
      category: opts.category ?? null,
      licenseCount: opts.licenseCount ?? null,
    })
    .returning();
  return row;
}

Deno.test("updateAppMetadata: patch category + licenseCount 寫入", async () => {
  await withTenant(async (tenantId) => {
    const app = await insertApp({ tenantId, displayName: "App1" });
    const updated = await updateAppMetadata({
      tenantId,
      appId: app.id,
      patch: { category: "teaching", licenseCount: 30, licenseNotes: "PO-001" },
    });
    assertEquals(updated.category, "teaching");
    assertEquals(updated.licenseCount, 30);
    assertEquals(updated.licenseNotes, "PO-001");
  });
});

Deno.test("updateAppMetadata: 三態 — 省略不動", async () => {
  await withTenant(async (tenantId) => {
    const app = await insertApp({ tenantId, displayName: "App2", category: "office", licenseCount: 10 });
    const updated = await updateAppMetadata({
      tenantId,
      appId: app.id,
      patch: { licenseNotes: "added later" }, // 只更新 notes
    });
    assertEquals(updated.category, "office"); // 不變
    assertEquals(updated.licenseCount, 10); // 不變
    assertEquals(updated.licenseNotes, "added later");
  });
});

Deno.test("updateAppMetadata: 三態 — 傳 null 清空", async () => {
  await withTenant(async (tenantId) => {
    const app = await insertApp({ tenantId, displayName: "App3", category: "teaching", licenseCount: 99 });
    const updated = await updateAppMetadata({
      tenantId,
      appId: app.id,
      patch: { category: null, licenseCount: null },
    });
    assertEquals(updated.category, null);
    assertEquals(updated.licenseCount, null);
  });
});

Deno.test("listAppsByTenant: category 過濾", async () => {
  await withTenant(async (tenantId) => {
    await insertApp({ tenantId, displayName: "A", category: "teaching" });
    await insertApp({ tenantId, displayName: "B", category: "office" });
    await insertApp({ tenantId, displayName: "C", category: "teaching" });

    const all = await listAppsByTenant(tenantId);
    assertEquals(all.length, 3);

    const teaching = await listAppsByTenant(tenantId, { category: "teaching" });
    assertEquals(teaching.length, 2);
    assertEquals(teaching.every((r) => r.category === "teaching"), true);

    const none = await listAppsByTenant(tenantId, { category: "nonexistent" });
    assertEquals(none.length, 0);
  });
});

Deno.test("getAppLicenseUsage: licenseCount=null 視為無限制（remaining=null, overLimit=false）", async () => {
  await withTenant(async (tenantId) => {
    const app = await insertApp({ tenantId, displayName: "Unlimited", licenseCount: null });
    const usage = await getAppLicenseUsage({ tenantId, appId: app.id });
    assertEquals(usage.licenseCount, null);
    assertEquals(usage.remaining, null);
    assertEquals(usage.overLimit, false);
  });
});

Deno.test("getAppLicenseUsage: assigned/installed 數正確", async () => {
  await withTenant(async (tenantId) => {
    const app = await insertApp({ tenantId, displayName: "Counted", licenseCount: 5 });

    const [d1] = await db.insert(mdmDevices).values({ tenantId, platform: "windows" }).returning({ id: mdmDevices.id });
    const [d2] = await db.insert(mdmDevices).values({ tenantId, platform: "windows" }).returning({ id: mdmDevices.id });
    const [d3] = await db.insert(mdmDevices).values({ tenantId, platform: "windows" }).returning({ id: mdmDevices.id });

    // 註:DB 已用 partial unique (app_id, device_id) WHERE scope='device' 保證 distinct,
    // 所以這裡同 device 不能重複插。distinct 性是 schema 層而非 query 層強制。
    await db.insert(appAssignments).values([
      { tenantId, appId: app.id, scope: "device", deviceId: d1.id, status: "installed" },
      { tenantId, appId: app.id, scope: "device", deviceId: d2.id, status: "pending" },
      { tenantId, appId: app.id, scope: "device", deviceId: d3.id, status: "installed" },
    ]);

    const usage = await getAppLicenseUsage({ tenantId, appId: app.id });
    assertEquals(usage.assigned, 3);
    assertEquals(usage.installed, 2);
    assertEquals(usage.remaining, 2);
    assertEquals(usage.overLimit, false);
  });
});

Deno.test("getAppLicenseUsage: scope=device_group 派發目前不計入 assigned（MVP）", async () => {
  await withTenant(async (tenantId) => {
    const app = await insertApp({ tenantId, displayName: "GroupOnly", licenseCount: 10 });
    // group-scope assignment 沒帶 deviceId
    const { deviceGroups } = await import("~/db/schema/tenants.ts");
    const [g] = await db
      .insert(deviceGroups)
      .values({ tenantId, code: "g1", displayName: "G1" })
      .returning({ id: deviceGroups.id });
    await db.insert(appAssignments).values({
      tenantId,
      appId: app.id,
      scope: "device_group",
      deviceGroupId: g.id,
      status: "installed",
    });
    const usage = await getAppLicenseUsage({ tenantId, appId: app.id });
    // MVP 限制:group-scope 沒具體 device_id 不計入
    assertEquals(usage.assigned, 0);
    assertEquals(usage.remaining, 10);
  });
});

Deno.test("getAppLicenseUsage: 超 licenseCount → overLimit=true, remaining=0", async () => {
  await withTenant(async (tenantId) => {
    const app = await insertApp({ tenantId, displayName: "OverLimit", licenseCount: 2 });
    const devices = await Promise.all([
      db.insert(mdmDevices).values({ tenantId, platform: "windows" }).returning({ id: mdmDevices.id }),
      db.insert(mdmDevices).values({ tenantId, platform: "windows" }).returning({ id: mdmDevices.id }),
      db.insert(mdmDevices).values({ tenantId, platform: "windows" }).returning({ id: mdmDevices.id }),
    ]);
    await db.insert(appAssignments).values(
      devices.map((d) => ({
        tenantId,
        appId: app.id,
        scope: "device" as const,
        deviceId: d[0].id,
        status: "installed" as const,
      })),
    );
    const usage = await getAppLicenseUsage({ tenantId, appId: app.id });
    assertEquals(usage.assigned, 3);
    assertEquals(usage.licenseCount, 2);
    assertEquals(usage.overLimit, true);
    assertEquals(usage.remaining, 0); // max(0, 2-3) = 0
  });
});

Deno.test("getAppLicenseUsage: status=removed/failed 不計入 assigned", async () => {
  await withTenant(async (tenantId) => {
    const app = await insertApp({ tenantId, displayName: "Inactive", licenseCount: 10 });
    const [d1] = await db.insert(mdmDevices).values({ tenantId, platform: "windows" }).returning({ id: mdmDevices.id });
    const [d2] = await db.insert(mdmDevices).values({ tenantId, platform: "windows" }).returning({ id: mdmDevices.id });
    await db.insert(appAssignments).values([
      { tenantId, appId: app.id, scope: "device", deviceId: d1.id, status: "removed" },
      { tenantId, appId: app.id, scope: "device", deviceId: d2.id, status: "failed" },
    ]);
    const usage = await getAppLicenseUsage({ tenantId, appId: app.id });
    assertEquals(usage.assigned, 0);
    assertEquals(usage.installed, 0);
  });
});
