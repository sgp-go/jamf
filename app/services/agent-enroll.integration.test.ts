/**
 * agent-enroll — 設備自助註冊（Intune 共存）整合測試。
 *
 * 覆蓋：共享密鑰驗證（正確 / 錯誤 / 未開啟）、windows agent_only 設備建立、
 * per-device token 簽發、同序號重入重簽、generate → enroll → revoke 端到端。
 */

import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@^1";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { AppError } from "~/lib/errors.ts";
import {
  clearAgentEnrollmentSecret,
  enrollAgentDevice,
  generateAgentEnrollmentSecret,
} from "./agent-enroll.ts";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** 建 tenant + self_mdm_config（secret 為明文，null = 不開啟自助註冊）；結束 cascade 清理。 */
async function withTenantConfig(
  secret: string | null,
  fn: (tenantId: string) => Promise<void>,
): Promise<void> {
  const slug = `enroll-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [t] = await db
    .insert(tenants)
    .values({ slug, displayName: "enroll-it" })
    .returning({ id: tenants.id });
  try {
    await db.insert(selfMdmConfigs).values({
      tenantId: t.id,
      publicBaseUrl: "https://test.example.com",
      agentEnrollmentSecretHash: secret ? hash(secret) : null,
    });
    await fn(t.id);
  } finally {
    // tenant cascade 刪 self_mdm_configs + mdm_devices（onDelete cascade）。
    await db.delete(tenants).where(eq(tenants.id, t.id));
  }
}

Deno.test("enrollAgentDevice: 正確密鑰建 windows agent_only 設備並簽發 token", async () => {
  await withTenantConfig("sekret", async (tenantId) => {
    const r = await enrollAgentDevice({
      tenantId,
      serialNumber: "SN-1",
      enrollmentSecret: "sekret",
    });
    assertEquals(r.agentToken.length, 64, "token = 32 bytes hex");

    const dev = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, r.deviceId),
      columns: {
        platform: true,
        enrollmentType: true,
        selfMdmManaged: true,
        serialNumber: true,
        agentTokenHash: true,
      },
    });
    assertEquals(dev?.platform, "windows");
    assertEquals(dev?.enrollmentType, "agent_only");
    assertEquals(dev?.selfMdmManaged, false, "遙測-only：不宣稱管理面");
    assertEquals(dev?.serialNumber, "SN-1");
    assertEquals(dev?.agentTokenHash, hash(r.agentToken), "DB 存 hash 非明文");
  });
});

Deno.test("enrollAgentDevice: 錯誤密鑰拋 401", async () => {
  await withTenantConfig("correct", async (tenantId) => {
    const err = await assertRejects(
      () => enrollAgentDevice({ tenantId, serialNumber: "SN-2", enrollmentSecret: "wrong" }),
      AppError,
    );
    assertEquals((err as AppError).status, 401);
    assertEquals((err as AppError).code, "enrollment_secret_invalid");
  });
});

Deno.test("enrollAgentDevice: 未開啟自助註冊拋 403", async () => {
  await withTenantConfig(null, async (tenantId) => {
    const err = await assertRejects(
      () => enrollAgentDevice({ tenantId, serialNumber: "SN-3", enrollmentSecret: "any" }),
      AppError,
    );
    assertEquals((err as AppError).status, 403);
    assertEquals((err as AppError).code, "agent_enroll_disabled");
  });
});

Deno.test("enrollAgentDevice: 同序號重入重用 row 並重簽 token", async () => {
  await withTenantConfig("s", async (tenantId) => {
    const r1 = await enrollAgentDevice({ tenantId, serialNumber: "SN-4", enrollmentSecret: "s" });
    const r2 = await enrollAgentDevice({ tenantId, serialNumber: "SN-4", enrollmentSecret: "s" });

    assertEquals(r1.deviceId, r2.deviceId, "同一 device row（不建重複）");
    assertNotEquals(r1.agentToken, r2.agentToken, "token 重簽（舊 token 失效）");

    const dev = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, r2.deviceId),
      columns: { agentTokenHash: true },
    });
    assertEquals(dev?.agentTokenHash, hash(r2.agentToken), "hash = 最新 token");
  });
});

Deno.test("generateAgentEnrollmentSecret → enroll → revoke 端到端", async () => {
  await withTenantConfig(null, async (tenantId) => {
    const gen = await generateAgentEnrollmentSecret({ tenantId });
    assertEquals(gen.enrollmentSecret.length, 48, "24 bytes hex");

    // 用生成的明文密鑰註冊成功
    const r = await enrollAgentDevice({
      tenantId,
      serialNumber: "SN-5",
      enrollmentSecret: gen.enrollmentSecret,
    });
    assertEquals(r.agentToken.length, 64);

    // 撤銷後同密鑰再註冊 → 403
    await clearAgentEnrollmentSecret({ tenantId });
    const err = await assertRejects(
      () =>
        enrollAgentDevice({
          tenantId,
          serialNumber: "SN-6",
          enrollmentSecret: gen.enrollmentSecret,
        }),
      AppError,
    );
    assertEquals((err as AppError).code, "agent_enroll_disabled");
  });
});

Deno.test("generateAgentEnrollmentSecret: 無 self_mdm_config → 404", async () => {
  const slug = `enroll-it-nocfg-${Date.now()}`;
  const [t] = await db
    .insert(tenants)
    .values({ slug, displayName: "enroll-it-nocfg" })
    .returning({ id: tenants.id });
  try {
    const err = await assertRejects(
      () => generateAgentEnrollmentSecret({ tenantId: t.id }),
      AppError,
    );
    assertEquals((err as AppError).status, 404);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, t.id));
  }
});
