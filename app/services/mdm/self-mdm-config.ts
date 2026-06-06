/**
 * 自建 MDM 配置（self_mdm_configs）存取 helper。
 *
 * 一個 tenant 一份 self_mdm_config（unique tenantId），存 per-tenant CA +
 * APNS/WNS 配置 + 對外 publicBaseUrl。Windows / Apple enrollment 流程都從這
 * 取得簽發 device cert 的 CA。
 *
 * MVP（W2 Day 1）：enrollment URL 不帶 tenant，handler 查唯一 active config。
 * 多租戶 URL 路由（baseUrl 帶 /t/{tenantId}）後續 additive 增強，不破壞此 helper。
 */

import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { type CaKeyPair, loadCa } from "~/services/mdm/crypto.ts";
import { decryptSecret } from "~/lib/secrets.ts";
import { type SelfMdmConfig, selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { tenants } from "~/db/schema/tenants.ts";

/**
 * 取唯一 active 的 self_mdm_config（MVP 單租戶 enrollment 入口）。
 * @throws Error 若沒有 active config（enrollment 無法進行）
 */
export async function getActiveSelfMdmConfig(): Promise<SelfMdmConfig> {
  const config = await db.query.selfMdmConfigs.findFirst({
    where: eq(selfMdmConfigs.isActive, true),
  });
  if (!config) {
    throw new Error(
      "No active self_mdm_config found — run `deno task db:seed` to create one",
    );
  }
  return config;
}

/**
 * 按 tenant slug 取 self_mdm_config（多租戶 enrollment 路由用）。
 * @throws Error 若 slug 不存在或無 active config
 */
export async function getSelfMdmConfigByTenantSlug(
  slug: string,
): Promise<SelfMdmConfig> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.slug, slug),
    columns: { id: true },
  });
  if (!tenant) {
    throw new Error(`Tenant slug "${slug}" not found`);
  }
  const config = await db.query.selfMdmConfigs.findFirst({
    where: and(
      eq(selfMdmConfigs.tenantId, tenant.id),
      eq(selfMdmConfigs.isActive, true),
    ),
  });
  if (!config) {
    throw new Error(`No active self_mdm_config for tenant slug "${slug}"`);
  }
  return config;
}

/**
 * 從 self_mdm_config 載入 CA 金鑰對（decrypt caKeyPemEnc → loadCa）。
 * @throws Error 若 config 缺 caCertPem / caKeyPemEnc
 */
export function loadCaFromConfig(config: SelfMdmConfig): CaKeyPair {
  const caKeyPem = decryptSecret(config.caKeyPemEnc);
  if (!config.caCertPem || !caKeyPem) {
    throw new Error(
      `self_mdm_config ${config.id} missing caCertPem / caKeyPemEnc`,
    );
  }
  return loadCa(config.caCertPem, caKeyPem);
}
