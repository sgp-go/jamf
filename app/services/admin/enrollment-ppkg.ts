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

/**
 * SecurityType 真實字面值來自 2026-05-28 Win10 ICD GUI export 的 customizations.xml
 * （見 agent-app/scripts/ppkg/GUI-REVERSE-CHECKLIST.md）。注意 dash 連字符 + 大寫。
 */
export type WifiSecurityType = "Open" | "WEP" | "WPA2-Personal";

export interface WifiCustomization {
  ssid: string;
  /** 預設 WPA2-Personal；Open 不需 securityKey */
  securityType?: WifiSecurityType;
  /** WPA2-Personal / WEP 必填；Open 忽略 */
  securityKey?: string;
  autoConnect?: boolean;
  /** SSID 是否隱藏（不廣播）；對應 export XML 的 HiddenNetwork */
  hidden?: boolean;
}

export interface LocalAccountCustomization {
  username: string;
  /** ICD export 的 XML 是明文 <Password>。安全責任在 admin 不洩漏 customizations.xml */
  password: string;
  /** 是否加入 Administrators 群組（預設 false=Standard Users） */
  isAdmin?: boolean;
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
 * WiFi profile 段 — 2026-05-28 Win10 ICD GUI Advanced provisioning (All Windows
 * desktop editions) export 出的權威 schema：
 *
 *   <ConnectivityProfiles>
 *     <WLAN>
 *       <WLANSetting>                              <!-- 單數，不是 WLANSettings -->
 *         <WLANConfig SSID="..." Name="...">       <!-- 兩個 attr 同值 -->
 *           <WLANXmlSettings>                       <!-- 真實存在的 wrapper -->
 *             <AutoConnect>True</AutoConnect>       <!-- True/False 首字母大寫 -->
 *             <HiddenNetwork>False</HiddenNetwork>
 *             <SecurityKey>...</SecurityKey>
 *             <SecurityType>WPA2-Personal</SecurityType>
 *           </WLANXmlSettings>
 *         </WLANConfig>
 *         ...（多個 SSID 並列）
 *       </WLANSetting>
 *     </WLAN>
 *   </ConnectivityProfiles>
 *
 * Open SSID 不需要 <SecurityKey>。我們依然渲染但留空 — ICD GUI export 也是這樣做的
 * （沒填密碼時節點不出現）。
 */
function renderWifiSection(profiles: WifiCustomization[]): string {
  const lines: string[] = [
    `        <ConnectivityProfiles>`,
    `          <WLAN>`,
    `            <WLANSetting>`,
  ];

  for (const p of profiles) {
    const securityType: WifiSecurityType = p.securityType ?? "WPA2-Personal";
    const autoConnect = p.autoConnect ?? true;
    const hidden = p.hidden ?? false;

    if (securityType !== "Open" && !p.securityKey) {
      throw new AppError(
        400,
        "invalid_wifi_profile",
        `WiFi SSID="${p.ssid}" securityType=${securityType} 需要 securityKey`,
      );
    }

    lines.push(
      `              <WLANConfig SSID="${escapeXmlAttr(p.ssid)}" Name="${escapeXmlAttr(p.ssid)}">`,
      `                <WLANXmlSettings>`,
      `                  <AutoConnect>${autoConnect ? "True" : "False"}</AutoConnect>`,
      `                  <HiddenNetwork>${hidden ? "True" : "False"}</HiddenNetwork>`,
    );
    if (securityType !== "Open") {
      lines.push(
        `                  <SecurityKey>${escapeXmlText(p.securityKey!)}</SecurityKey>`,
      );
    }
    lines.push(
      `                  <SecurityType>${securityType}</SecurityType>`,
      `                </WLANXmlSettings>`,
      `              </WLANConfig>`,
    );
  }

  lines.push(
    `            </WLANSetting>`,
    `          </WLAN>`,
    `        </ConnectivityProfiles>`,
  );

  return lines.join("\n");
}

/**
 * UserGroup 字面值來自 2026-05-28 Win10 ICD GUI export 樣本（兩個 enum 都真機驗證）：
 * - "Standard Users"（複數 Users）
 * - "Administrators"（複數 s）
 *
 * 兩者都是 Windows local group 標準命名（複數）。
 */
const USER_GROUP_STANDARD = "Standard Users";
const USER_GROUP_ADMIN = "Administrators";

/**
 * 本機帳號段 — 2026-05-28 Win10 ICD GUI export schema：
 *
 *   <Accounts>
 *     <Users>
 *       <User UserName="..." Name="...">           <!-- 兩個 attr 同值 -->
 *         <Password>明文</Password>
 *         <UserGroup>Standard Users</UserGroup>   <!-- 注意 "Users" 複數 -->
 *       </User>
 *       ...（多個 user 並列）
 *     </Users>
 *   </Accounts>
 *
 * Password 是明文。安全責任在 admin 保護生成的 .ppkg / customizations.xml 不外洩。
 */
function renderAccountsSection(accounts: LocalAccountCustomization[]): string {
  const lines: string[] = [
    `        <Accounts>`,
    `          <Users>`,
  ];

  for (const a of accounts) {
    const group = a.isAdmin ? USER_GROUP_ADMIN : USER_GROUP_STANDARD;
    lines.push(
      `            <User UserName="${escapeXmlAttr(a.username)}" Name="${escapeXmlAttr(a.username)}">`,
      `              <Password>${escapeXmlText(a.password)}</Password>`,
      `              <UserGroup>${group}</UserGroup>`,
      `            </User>`,
    );
  }

  lines.push(
    `          </Users>`,
    `        </Accounts>`,
  );

  return lines.join("\n");
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
