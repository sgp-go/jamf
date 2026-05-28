import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { AppError } from "~/lib/errors.ts";

/**
 * 生成 Windows Provisioning Package customizations.xml（USB PPKG 用，W3 主軸 4）。
 *
 * Schema 來源：2026-05-28 SSH Win10 跑 ICD GUI 直接吐出的真實樣本（見
 * agent-app/scripts/ppkg/README.md「Schema 查證工作流」節）。MS docs 沒公開
 * 完整 customizations.xml sample，我們從 GUI 反向工程拿到權威格式。
 *
 * 設計取捨（MVP）：
 * - admin 自帶 enrollment 凭据（upn + secret query），server 不持久化
 *   enrollment_secrets 表（避免引入新表 + 驗證流；admin 全責憑據生命週期）
 * - server 只填本 tenant 的 publicBaseUrl（從 self_mdm_configs 讀）+ slug
 *   作為 PPKG Name
 * - AuthPolicy 固定 OnPremise（其餘 Certificate / Federated 留後段擴展）
 *
 * 返回 XML 字串。caller 把它寫進 HTTP response（Content-Type: application/xml +
 * Content-Disposition: attachment）。
 *
 * 對接流程：
 *   1. admin 拿到 .xml → SCP 到 Win10 工具機
 *   2. 跑 agent-app/scripts/ppkg/build-ppkg.ps1 ICD build 出 .ppkg
 *   3. .ppkg 插 USB 進新設備觸發 zero-touch enrollment
 */

export interface GeneratePpkgInput {
  tenantId: string;
  /** Enrollment 服務帳號 UPN（如 enrollment@school.local） */
  upn: string;
  /** OnPremise 密碼 / Certificate thumbprint / Federated token；取決於 AuthPolicy */
  secret: string;
}

export interface GeneratePpkgResult {
  /** 完整 customizations.xml 字串 */
  xml: string;
  /** 建議的下載檔名 */
  filename: string;
}

export async function generatePpkgCustomizations(
  input: GeneratePpkgInput,
): Promise<GeneratePpkgResult> {
  if (!input.upn || !input.upn.includes("@")) {
    throw new AppError(
      400,
      "invalid_upn",
      "upn must be a UPN-format string (user@domain)",
    );
  }
  if (!input.secret) {
    throw new AppError(400, "invalid_secret", "secret required");
  }

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, input.tenantId),
    columns: { id: true, slug: true, displayName: true },
  });
  if (!tenant) {
    throw new AppError(404, "tenant_not_found", "Tenant not found");
  }

  const cfg = await db.query.selfMdmConfigs.findFirst({
    where: eq(selfMdmConfigs.tenantId, input.tenantId),
    columns: { publicBaseUrl: true, isActive: true },
  });
  if (!cfg || !cfg.isActive) {
    throw new AppError(
      409,
      "self_mdm_not_configured",
      "Self-MDM not configured (or inactive) for this tenant; configure publicBaseUrl + certs first",
    );
  }

  const discoveryUrl =
    `${cfg.publicBaseUrl.replace(/\/+$/, "")}/EnrollmentServer/Discovery.svc`;
  const packageId = randomUUID();
  const timestamp = new Date().toISOString().slice(0, 10);
  const packageName = `cogrow-${tenant.slug}-${timestamp}`;

  // 真實 schema 來自 GUI（Common/Workplace/Enrollments/UPN[UPN+Name attrs] +
  // AuthPolicy / DiscoveryServiceFullUrl / Secret 子元素）
  const xml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<WindowsCustomizations>`,
    `  <PackageConfig xmlns="urn:schemas-Microsoft-com:Windows-ICD-Package-Config.v1.0">`,
    `    <ID>{${packageId}}</ID>`,
    `    <Name>${escapeXmlText(packageName)}</Name>`,
    `    <Version>1.0</Version>`,
    `    <OwnerType>OEM</OwnerType>`,
    `    <Rank>0</Rank>`,
    `    <Notes>CoGrow MDM bulk enrollment for tenant ${escapeXmlText(tenant.displayName ?? tenant.slug)}</Notes>`,
    `  </PackageConfig>`,
    `  <Settings xmlns="urn:schemas-microsoft-com:windows-provisioning">`,
    `    <Customizations>`,
    `      <Common>`,
    `        <Workplace>`,
    `          <Enrollments>`,
    `            <UPN UPN="${escapeXmlAttr(input.upn)}" Name="${escapeXmlAttr(input.upn)}">`,
    `              <AuthPolicy>OnPremise</AuthPolicy>`,
    `              <DiscoveryServiceFullUrl>${escapeXmlText(discoveryUrl)}</DiscoveryServiceFullUrl>`,
    `              <Secret>${escapeXmlText(input.secret)}</Secret>`,
    `            </UPN>`,
    `          </Enrollments>`,
    `        </Workplace>`,
    `      </Common>`,
    `    </Customizations>`,
    `  </Settings>`,
    `</WindowsCustomizations>`,
    ``,
  ].join("\n");

  return {
    xml,
    filename: `${packageName}-customizations.xml`,
  };
}

// ──────────────────────────────────────────────────────────────
// XML escape（user input 防破壞 XML 結構；attribute vs text 不同集合）
// ──────────────────────────────────────────────────────────────

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
