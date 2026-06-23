/**
 * enrollWindowsDevice 落庫整合測試（device_group_id 寫入路徑）
 *
 * Windows enrollment 路由 group / non-group 分流靠 Hono path param 上層處理；
 * 此處只測 service 層的 deviceGroupId 寫庫 / 重 enroll 保留行為。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { deviceGroups, tenants } from "~/db/schema/tenants.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { enrollWindowsDevice } from "./devices.ts";

async function withFixtures<T>(
  fn: (ctx: {
    tenantId: string;
    selfMdmConfigId: string;
    groupAId: string;
    groupBId: string;
  }) => Promise<T>,
): Promise<T> {
  const slug = `dev-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [tenant] = await db
    .insert(tenants)
    .values({ slug, displayName: "device-enroll-it" })
    .returning({ id: tenants.id });
  const [cfg] = await db
    .insert(selfMdmConfigs)
    .values({
      tenantId: tenant.id,
      publicBaseUrl: "https://mdm.example.com",
      caCertPem: "fake",
      isActive: true,
    })
    .returning({ id: selfMdmConfigs.id });
  const [a] = await db
    .insert(deviceGroups)
    .values({ tenantId: tenant.id, code: "school-a", displayName: "學校 A" })
    .returning({ id: deviceGroups.id });
  const [b] = await db
    .insert(deviceGroups)
    .values({ tenantId: tenant.id, code: "school-b", displayName: "學校 B" })
    .returning({ id: deviceGroups.id });
  try {
    return await fn({
      tenantId: tenant.id,
      selfMdmConfigId: cfg.id,
      groupAId: a.id,
      groupBId: b.id,
    });
  } finally {
    // cascade 會清掉所有相關 device / group / config
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }
}

Deno.test("enrollWindowsDevice: INSERT 帶 deviceGroupId 落庫", async () => {
  await withFixtures(async ({ tenantId, selfMdmConfigId, groupAId }) => {
    const winDevId = `win-it-${crypto.randomUUID()}`;
    const id = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      deviceGroupId: groupAId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    const row = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, id),
      columns: { deviceGroupId: true, tenantId: true },
    });
    assertEquals(row?.deviceGroupId, groupAId);
    assertEquals(row?.tenantId, tenantId);
  });
});

Deno.test("enrollWindowsDevice: INSERT 不帶 deviceGroupId → null（直屬 tenant）", async () => {
  await withFixtures(async ({ tenantId, selfMdmConfigId }) => {
    const winDevId = `win-it-${crypto.randomUUID()}`;
    const id = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    const row = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, id),
      columns: { deviceGroupId: true },
    });
    assertEquals(row?.deviceGroupId, null);
  });
});

Deno.test("enrollWindowsDevice: 重 enroll 傳新 deviceGroupId 會 UPDATE 為新值（移組）", async () => {
  await withFixtures(async ({ tenantId, selfMdmConfigId, groupAId, groupBId }) => {
    const winDevId = `win-it-${crypto.randomUUID()}`;
    const id1 = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      deviceGroupId: groupAId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    const id2 = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      deviceGroupId: groupBId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    assertEquals(id1, id2); // 同一行
    const row = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, id1),
      columns: { deviceGroupId: true },
    });
    assertEquals(row?.deviceGroupId, groupBId);
  });
});

Deno.test("enrollWindowsDevice: 重 enroll 省略 deviceGroupId 會保留原值（不誤清）", async () => {
  await withFixtures(async ({ tenantId, selfMdmConfigId, groupAId }) => {
    const winDevId = `win-it-${crypto.randomUUID()}`;
    const id1 = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      deviceGroupId: groupAId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    // 第二次 enroll 不傳 deviceGroupId（模擬從 non-group 路由重來）
    await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    const row = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, id1),
      columns: { deviceGroupId: true },
    });
    // 期望保留原 group，而不是被清成 null
    assertEquals(row?.deviceGroupId, groupAId);
  });
});

Deno.test("enrollWindowsDevice: 重 enroll 顯式傳 deviceGroupId=null 會清空（回直屬 tenant）", async () => {
  await withFixtures(async ({ tenantId, selfMdmConfigId, groupAId }) => {
    const winDevId = `win-it-${crypto.randomUUID()}`;
    const id1 = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      deviceGroupId: groupAId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      deviceGroupId: null, // 顯式清空
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    const row = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, id1),
      columns: { deviceGroupId: true },
    });
    assertEquals(row?.deviceGroupId, null);
  });
});

// ── route 層契約：handleEnrollmentRequest 永遠用 undefined 表示「非 group 路由 / fail-safe」──
// 模擬 windows-mdm.ts handleEnrollmentRequest 真實會傳給 service 的值組合，
// 鎖死「route 層用 undefined」這條紀律——若有人不小心改回傳 null，這組測試會掛。

Deno.test("[route 契約] 已歸組設備走非 group 路由重 enroll（undefined）→ 保留 groupA", async () => {
  await withFixtures(async ({ tenantId, selfMdmConfigId, groupAId }) => {
    const winDevId = `win-it-${crypto.randomUUID()}`;
    // 1st: PPKG /g/school-a 首次 enroll
    const id = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      deviceGroupId: groupAId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    // 2nd: 用通用 PPKG（無 group）路由重 enroll → route 傳 undefined
    await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      // deviceGroupId omitted (undefined)
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    const row = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, id),
      columns: { deviceGroupId: true },
    });
    assertEquals(row?.deviceGroupId, groupAId);
  });
});

Deno.test("[route 契約] 已歸組設備走 group 路由但 code 失效（fail-safe → undefined）→ 保留 groupA", async () => {
  await withFixtures(async ({ tenantId, selfMdmConfigId, groupAId }) => {
    const winDevId = `win-it-${crypto.randomUUID()}`;
    const id = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      deviceGroupId: groupAId,
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    // 模擬 handleEnrollmentRequest 走 group 路由但 getDeviceGroupByTenantAndCode 拋錯
    // catch 後 deviceGroupId 保持 undefined（修 #1 後的新行為）
    await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      // deviceGroupId omitted (fail-safe path)
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    const row = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, id),
      columns: { deviceGroupId: true },
    });
    assertEquals(row?.deviceGroupId, groupAId);
  });
});

Deno.test("[route 契約] 首次 enroll 非 group 路由（undefined）→ INSERT 落 DB default null", async () => {
  await withFixtures(async ({ tenantId, selfMdmConfigId }) => {
    const winDevId = `win-it-${crypto.randomUUID()}`;
    const id = await enrollWindowsDevice({
      tenantId,
      selfMdmConfigId,
      // deviceGroupId omitted
      udid: `windows-${winDevId}`,
      windowsDeviceId: winDevId,
    });
    const row = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, id),
      columns: { deviceGroupId: true },
    });
    assertEquals(row?.deviceGroupId, null);
  });
});
