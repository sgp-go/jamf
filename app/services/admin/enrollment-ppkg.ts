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
 * - 預設 AuthPolicy=OnPremise（教育場景已驗證真機可用）
 *
 * 擴展（W4 骨架，待 Win10 ICD GUI 反向工程拿真 schema 後填實）：
 * - authPolicy="Certificate" → 走 Certificate-based enrollment（schema 段名稱
 *   推測為 <Certificate Thumbprint="..."/> 之類，但 GUI 沒驗證前不渲染）
 * - wifi[]   → ConnectivityProfiles/WLANSetting
 * - localAccounts[] → Accounts/<X>
 *
 * 三段 helper 已留簽名但 throw 501，避免 admin 誤用未驗證 schema 出非預期 PPKG。
 *
 * 返回 XML 字串。caller 把它寫進 HTTP response（Content-Type: application/xml +
 * Content-Disposition: attachment）。
 */

export type AuthPolicy = "OnPremise" | "Certificate";

export interface WifiCustomization {
  ssid: string;
  password?: string;
  /** WPA2-PSK 預設；open WiFi 設 type="open" */
  authType?: "WPA2PSK" | "open";
  autoConnect?: boolean;
  nonBroadcast?: boolean;
}

export interface LocalAccountCustomization {
  username: string;
  /** 明文密碼；ICD GUI 出的 XML 是 hash 或明文需 Win10 驗證 */
  password: string;
  /** 是否加入 Administrators 群組 */
  isAdmin?: boolean;
  /** 開機自動登入此帳號（Kiosk 場景常用） */
  autoLogon?: boolean;
}

export interface GeneratePpkgInput {
  tenantId: string;
  /** Enrollment 服務帳號 UPN（如 enrollment@school.local） */
  upn: string;
  /** OnPremise=password / Certificate=thumbprint；對應 authPolicy */
  secret: string;
  /** 預設 OnPremise；Certificate 需 W4 後續真機驗證 schema */
  authPolicy?: AuthPolicy;
  /** WiFi profile 清單（PPKG 安裝後預配）；schema 待 GUI 反向工程 */
  wifi?: WifiCustomization[];
  /** 本機帳號（學生 standard + admin）；schema 待 GUI 反向工程 */
  localAccounts?: LocalAccountCustomization[];
}

export interface GeneratePpkgResult {
  /** 完整 customizations.xml 字串 */
  xml: string;
  /** 建議的下載檔名 */
  filename: string;
}

export interface RenderContext {
  tenant: { slug: string; displayName: string | null };
  cfg: { publicBaseUrl: string };
  /** 完整 input（含 upn / secret / authPolicy / wifi / localAccounts） */
  input: GeneratePpkgInput;
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

  const timestamp = new Date().toISOString().slice(0, 10);
  const packageName = `cogrow-${tenant.slug}-${timestamp}`;

  const xml = renderCustomizationsXml({
    tenant: { slug: tenant.slug, displayName: tenant.displayName },
    cfg: { publicBaseUrl: cfg.publicBaseUrl },
    input,
  });

  return {
    xml,
    filename: `${packageName}-customizations.xml`,
  };
}

/**
 * 純函式：把已查好的 tenant + cfg + input 渲染成 customizations.xml。
 *
 * 拆出來方便 unit test 不依賴 DB（且未來 admin UI 用 dry-run preview 也好對接）。
 */
export function renderCustomizationsXml(ctx: RenderContext): string {
  const { tenant, cfg, input } = ctx;

  const discoveryUrl =
    `${cfg.publicBaseUrl.replace(/\/+$/, "")}/EnrollmentServer/Discovery.svc`;
  const packageId = randomUUID();
  const timestamp = new Date().toISOString().slice(0, 10);
  const packageName = `cogrow-${tenant.slug}-${timestamp}`;
  const notesTarget = tenant.displayName ?? tenant.slug;

  const lines: string[] = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<WindowsCustomizations>`,
    `  <PackageConfig xmlns="urn:schemas-Microsoft-com:Windows-ICD-Package-Config.v1.0">`,
    `    <ID>{${packageId}}</ID>`,
    `    <Name>${escapeXmlText(packageName)}</Name>`,
    `    <Version>1.0</Version>`,
    `    <OwnerType>OEM</OwnerType>`,
    `    <Rank>0</Rank>`,
    `    <Notes>CoGrow MDM bulk enrollment for tenant ${escapeXmlText(notesTarget)}</Notes>`,
    `  </PackageConfig>`,
    `  <Settings xmlns="urn:schemas-microsoft-com:windows-provisioning">`,
    `    <Customizations>`,
    `      <Common>`,
  ];

  // Workplace/Enrollments — required（每個 PPKG 都要有 enrollment 段）
  lines.push(renderEnrollmentSection(input, discoveryUrl));

  // 可選 WiFi
  if (input.wifi && input.wifi.length > 0) {
    lines.push(renderWifiSection(input.wifi));
  }

  // 可選本機帳號
  if (input.localAccounts && input.localAccounts.length > 0) {
    lines.push(renderAccountsSection(input.localAccounts));
  }

  lines.push(`      </Common>`);
  lines.push(`    </Customizations>`);
  lines.push(`  </Settings>`);
  lines.push(`</WindowsCustomizations>`);
  lines.push(``);

  return lines.join("\n");
}

/**
 * Workplace/Enrollments — MDM 註冊段。
 *
 * OnPremise 是 2026-05-28 真機驗證過的 schema。Certificate 形態未驗證，
 * throw 501 等 Win10 ICD GUI 反向工程拿到真實 attribute 排序後再填。
 */
function renderEnrollmentSection(
  input: GeneratePpkgInput,
  discoveryUrl: string,
): string {
  const authPolicy = input.authPolicy ?? "OnPremise";

  if (authPolicy === "Certificate") {
    throw new AppError(
      501,
      "ppkg_section_not_validated",
      "authPolicy=Certificate schema 未經 Win10 ICD GUI 反向工程驗證；先在 Win10 ICD GUI 設 Certificate 模式 export customizations.xml，再實作此段（見 agent-app/scripts/ppkg/README.md）",
    );
  }

  // OnPremise（已驗證）
  return [
    `        <Workplace>`,
    `          <Enrollments>`,
    `            <UPN UPN="${escapeXmlAttr(input.upn)}" Name="${escapeXmlAttr(input.upn)}">`,
    `              <AuthPolicy>OnPremise</AuthPolicy>`,
    `              <DiscoveryServiceFullUrl>${escapeXmlText(discoveryUrl)}</DiscoveryServiceFullUrl>`,
    `              <Secret>${escapeXmlText(input.secret)}</Secret>`,
    `            </UPN>`,
    `          </Enrollments>`,
    `        </Workplace>`,
  ].join("\n");
}

/**
 * WiFi profile 段 — 推測為 ConnectivityProfiles/WLANSetting。
 *
 * 真實 schema 待 Win10 ICD GUI 步驟：
 *   New project → Common settings → ConnectivityProfiles → Add WLAN setting
 *   Export → 反向工程 attribute 順序與 nested 結構
 *
 * 直到 GUI 樣本拿到前，此 helper throw 501 防止生成壞 XML。
 */
function renderWifiSection(_profiles: WifiCustomization[]): string {
  throw new AppError(
    501,
    "ppkg_section_not_validated",
    "WiFi (ConnectivityProfiles/WLANSetting) schema 未經 Win10 ICD GUI 反向工程驗證；參考 agent-app/scripts/ppkg/README.md 的 TODO 流程",
  );
}

/**
 * 本機帳號段 — 推測為 Accounts/Users。
 *
 * 真實 schema 待 Win10 ICD GUI 步驟：
 *   New project → Common settings → Accounts → ComputerAccount / Users
 *   驗證密碼欄位是明文 / hash / SecureString
 *
 * 直到 GUI 樣本拿到前，此 helper throw 501。
 */
function renderAccountsSection(_accounts: LocalAccountCustomization[]): string {
  throw new AppError(
    501,
    "ppkg_section_not_validated",
    "LocalAccounts (Accounts/Users) schema 未經 Win10 ICD GUI 反向工程驗證；參考 agent-app/scripts/ppkg/README.md 的 TODO 流程",
  );
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
