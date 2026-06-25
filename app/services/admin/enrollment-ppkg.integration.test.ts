/**
 * generatePpkgCustomizations DB 整合測試
 *
 * 覆蓋 service 入口的 tenant / self_mdm_config / device_group 三段查詢 + 校驗，
 * 補 enrollment-ppkg.test.ts 純函式測試覆蓋不到的 DB 路徑。
 *
 * 真機 enroll 落庫（device_group_id 寫入）的部分留真機驗證跑。
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { deviceGroups, tenants } from "~/db/schema/tenants.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { AppError } from "~/lib/errors.ts";
import { generatePpkgCustomizations } from "./enrollment-ppkg.ts";

async function withTenantAndMdmConfig<T>(
  fn: (ctx: { tenantId: string; selfMdmConfigId: string }) => Promise<T>,
): Promise<T> {
  const slug = `ppkg-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [tenant] = await db
    .insert(tenants)
    .values({ slug, displayName: "ppkg-integration-test" })
    .returning({ id: tenants.id });
  const [cfg] = await db
    .insert(selfMdmConfigs)
    .values({
      tenantId: tenant.id,
      publicBaseUrl: "https://mdm.example.com",
      caCertPem: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
      isActive: true,
    })
    .returning({ id: selfMdmConfigs.id });
  try {
    return await fn({ tenantId: tenant.id, selfMdmConfigId: cfg.id });
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }
}

async function withGroup<T>(
  tenantId: string,
  code: string,
  displayName: string,
  fn: (groupId: string) => Promise<T>,
): Promise<T> {
  const [g] = await db
    .insert(deviceGroups)
    .values({ tenantId, code, displayName })
    .returning({ id: deviceGroups.id });
  try {
    return await fn(g.id);
  } finally {
    await db.delete(deviceGroups).where(eq(deviceGroups.id, g.id));
  }
}

Deno.test("generatePpkgCustomizations: 不帶 deviceGroupId → DiscoveryUrl 不含 /g/，檔名不含 group", async () => {
  await withTenantAndMdmConfig(async ({ tenantId }) => {
    const { xml, filename } = await generatePpkgCustomizations({
      tenantId,
      upn: "enrollment@school.local",
      secret: "P@ss",
      wifi: [{ ssid: "Test-WiFi", securityKey: "test-pass" }],
    });
    assertStringIncludes(xml, "/EnrollmentServer/Discovery.svc");
    assertEquals(xml.includes("/g/"), false);
    assertEquals(filename.includes("/g/"), false);
    // 檔名 cogrow-{slug}-{date}-customizations.xml
    assertEquals(/^cogrow-ppkg-it-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-customizations\.xml$/.test(filename), true);
  });
});

Deno.test("generatePpkgCustomizations: 帶合法 deviceGroupId → DiscoveryUrl 含 /g/{code}，檔名含 group code", async () => {
  await withTenantAndMdmConfig(async ({ tenantId }) => {
    await withGroup(tenantId, "guangfu-es", "光復國小", async (groupId) => {
      const { xml, filename } = await generatePpkgCustomizations({
        tenantId,
        deviceGroupId: groupId,
        upn: "enrollment@school.local",
        secret: "P@ss",
        wifi: [{ ssid: "Test-WiFi", securityKey: "test-pass" }],
      });
      assertStringIncludes(xml, "/g/guangfu-es/EnrollmentServer/Discovery.svc");
      assertStringIncludes(filename, "-guangfu-es-");
      assertStringIncludes(xml, "光復國小</Notes>");
    });
  });
});

async function expectAppErrorCode(
  call: () => Promise<unknown>,
  expectedCode: string,
  expectedStatus?: number,
): Promise<void> {
  try {
    await call();
    throw new Error(`期望 throw AppError(code=${expectedCode})，但成功返回`);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    assertEquals(e.code, expectedCode);
    if (expectedStatus !== undefined) assertEquals(e.status, expectedStatus);
  }
}

Deno.test("generatePpkgCustomizations: deviceGroupId 跨 tenant → 404 device_group_not_found", async () => {
  await withTenantAndMdmConfig(async ({ tenantId: t1 }) => {
    await withTenantAndMdmConfig(async ({ tenantId: t2 }) => {
      await withGroup(t2, "other-school", "另一所學校", async (foreignGroupId) => {
        await expectAppErrorCode(
          () =>
            generatePpkgCustomizations({
              tenantId: t1,
              deviceGroupId: foreignGroupId, // 屬於 t2 的 group，但用 t1 生成 PPKG
              upn: "enrollment@school.local",
              secret: "P@ss",
              wifi: [{ ssid: "Test-WiFi", securityKey: "test-pass" }],
            }),
          "device_group_not_found",
          404,
        );
      });
    });
  });
});

Deno.test("generatePpkgCustomizations: deviceGroupId 不存在 → 404 device_group_not_found", async () => {
  await withTenantAndMdmConfig(async ({ tenantId }) => {
    await expectAppErrorCode(
      () =>
        generatePpkgCustomizations({
          tenantId,
          deviceGroupId: "00000000-0000-0000-0000-000000000000",
          upn: "enrollment@school.local",
          secret: "P@ss",
          wifi: [{ ssid: "Test-WiFi", securityKey: "test-pass" }],
        }),
      "device_group_not_found",
      404,
    );
  });
});

Deno.test("generatePpkgCustomizations: group.code 含非 URL-safe 字符 → 400 device_group_code_not_url_safe", async () => {
  await withTenantAndMdmConfig(async ({ tenantId }) => {
    // 注意：device_group create schema 在 service 層沒卡字符集（只卡長度 1-64），
    // 所以可以建出帶非法 code 的 group。PPKG 生成才 throw。
    await withGroup(tenantId, "Has Space", "含空格的學校", async (groupId) => {
      await expectAppErrorCode(
        () =>
          generatePpkgCustomizations({
            tenantId,
            deviceGroupId: groupId,
            upn: "enrollment@school.local",
            secret: "P@ss",
            wifi: [{ ssid: "Test-WiFi", securityKey: "test-pass" }],
          }),
        "device_group_code_not_url_safe",
        400,
      );
    });
  });
});
