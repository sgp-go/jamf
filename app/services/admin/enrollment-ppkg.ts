import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { deviceGroups, tenants } from "~/db/schema/tenants.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { AppError } from "~/lib/errors.ts";

/**
 * device_group.code 進 PPKG DiscoveryUrl 的 `/g/{code}` 段，必須 URL-safe。
 * 限 [a-z0-9-_]，1~64 字元。schema 層已有 length 限制，這裡再卡字符集。
 */
const DEVICE_GROUP_CODE_PATTERN = /^[a-z0-9_-]{1,64}$/;

/**
 * 生成 Windows Provisioning Package customizations.xml（USB PPKG 用，W3 主軸 4）。
 *
 * Schema 來源：2026-05-28 SSH Win10 跑 ICD GUI 直接吐出的真實樣本（見
 * win-agent-app/scripts/ppkg/README.md「Schema 查證工作流」節）。MS docs 沒公開
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
 * （見 win-agent-app/scripts/ppkg/GUI-REVERSE-CHECKLIST.md）。注意 dash 連字符 + 大寫。
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
  /**
   * 強制此帳號**首次登入時必須改密碼**。為 true 的帳號會匯入到 PPKG
   * `ProvisioningCommands/DeviceContext/CommandLine`，PPKG 套用時以 SYSTEM 跑
   * `net user <username> /logonpasswordchg:yes`。
   *
   * 教育場景常見用法：PPKG 配統一臨時密碼 + 此旗標 → 學生首次登入被迫自設密碼。
   */
  forceChangePasswordAtNextLogon?: boolean;
}

export interface GeneratePpkgInput {
  tenantId: string;
  /**
   * 設備 enroll 後自動歸屬的 device_group UUID（學校）。省略 → 設備直屬 tenant（教育局），
   * 後續可透過 PATCH /tenants/{tid}/devices/{did} 手動分配。
   *
   * Service 會校驗 group ⊂ tenant + group.code URL-safe，並在 DiscoveryUrl 中嵌入
   * `/g/{code}` 段。Windows enrollment 路由解析這段後落庫到 mdm_devices.device_group_id。
   */
  deviceGroupId?: string;
  /** Enrollment 服務帳號 UPN（如 enrollment@school.local） */
  upn: string;
  /** OnPremise=password / Certificate=thumbprint；對應 authPolicy */
  secret: string;
  /** 預設 OnPremise；Certificate 需 W4 後續真機驗證 schema */
  authPolicy?: AuthPolicy;
  /**
   * WiFi profile 清單（PPKG 安裝後預配）。**必填且至少 1 個**——OOBE 階段裝置在
   * 套用 PPKG 之前是斷網的，沒 WiFi 就無法跑 enrollment（Discovery / Policy /
   * Enrollment 三段都打不到後端）。2026-06-25 真機驗證確認過：少 wifi 段直接
   * 出「註冊管理設備失敗」彈窗。
   *
   * 桌機 / 有線網路場景目前不支援——下次有需求時加一個 `allowNoWifi: true`
   * 旗標單獨開放（YAGNI 先不做）。
   */
  wifi: WifiCustomization[];
  /** 本機帳號（學生 standard + admin）；schema 待 GUI 反向工程 */
  localAccounts?: LocalAccountCustomization[];
  /**
   * 啟用 PPKG `OOBE/Desktop/HideOobe=True`，套用時隱藏 OOBE 互動畫面。
   *
   * ⚠️ Win10 22H2 上 HideOobe 並不等同完全 bypass OOBE — 不保證能跳過「設備設定方式」
   * 等畫面。完整 bypass OOBE 在 MS 官方流程靠 unattend.xml 不靠 PPKG。設此旗標只能減
   * 少互動，仍需真機驗證效果。
   */
  skipOobe?: boolean;
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
  /** 校驗通過的 device_group（code 已驗 URL-safe），null = 直屬 tenant */
  deviceGroup: { code: string; displayName: string | null } | null;
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
  if (!input.wifi || input.wifi.length === 0) {
    throw new AppError(
      400,
      "wifi_required",
      "wifi must contain at least 1 SSID. OOBE 階段裝置在套 PPKG 前是斷網的，沒 WiFi 段 enrollment 必失敗（2026-06-25 真機驗證）",
    );
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
    columns: { publicBaseUrl: true, isActive: true, caCertPem: true },
  });
  if (!cfg || !cfg.isActive) {
    throw new AppError(
      409,
      "self_mdm_not_configured",
      "Self-MDM not configured (or inactive) for this tenant; call POST /admin/tenants/{tid}/mdm-config first",
    );
  }
  if (!cfg.caCertPem) {
    throw new AppError(
      409,
      "ca_not_configured",
      "CA 根憑證未配置。POST /admin/tenants/{tid}/mdm-config 會自動生成，或手動上傳。設備 enrollment 需要 CA 簽發憑證。",
    );
  }

  // device_group 校驗：必須屬於同一 tenant，且 code 必須 URL-safe（會進 DiscoveryUrl path）
  let deviceGroup: { code: string; displayName: string | null } | null = null;
  if (input.deviceGroupId) {
    const row = await db.query.deviceGroups.findFirst({
      where: and(
        eq(deviceGroups.id, input.deviceGroupId),
        eq(deviceGroups.tenantId, input.tenantId),
      ),
      columns: { code: true, displayName: true },
    });
    if (!row) {
      throw new AppError(
        404,
        "device_group_not_found",
        "Device group not found in this tenant",
      );
    }
    if (!DEVICE_GROUP_CODE_PATTERN.test(row.code)) {
      throw new AppError(
        400,
        "device_group_code_not_url_safe",
        `device_group.code "${row.code}" 含非 URL-safe 字符（限 [a-z0-9_-]，需先 PATCH 更新 code 才能用於 PPKG）`,
      );
    }
    deviceGroup = { code: row.code, displayName: row.displayName };
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  // group 帶上時檔名含 group code，方便 IT 區分多份 PPKG
  const packageName = deviceGroup
    ? `cogrow-${tenant.slug}-${deviceGroup.code}-${timestamp}`
    : `cogrow-${tenant.slug}-${timestamp}`;

  const xml = renderCustomizationsXml({
    tenant: { slug: tenant.slug, displayName: tenant.displayName },
    cfg: { publicBaseUrl: cfg.publicBaseUrl },
    deviceGroup,
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
  const { tenant, cfg, deviceGroup, input } = ctx;

  const groupSegment = deviceGroup ? `/g/${deviceGroup.code}` : "";
  const discoveryUrl =
    `${cfg.publicBaseUrl.replace(/\/+$/, "")}/t/${tenant.slug}${groupSegment}/EnrollmentServer/Discovery.svc`;
  const packageId = randomUUID();
  const timestamp = new Date().toISOString().slice(0, 10);
  const packageName = deviceGroup
    ? `cogrow-${tenant.slug}-${deviceGroup.code}-${timestamp}`
    : `cogrow-${tenant.slug}-${timestamp}`;
  const tenantLabel = tenant.displayName ?? tenant.slug;
  const notesTarget = deviceGroup
    ? `${tenantLabel} / ${deviceGroup.displayName ?? deviceGroup.code}`
    : tenantLabel;

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

  // WiFi 必填（2026-06-25 改）——pure-function 內也擋一道，防 TS `as any` 繞過 type
  if (!input.wifi || input.wifi.length === 0) {
    throw new AppError(
      400,
      "wifi_required",
      "wifi must contain at least 1 SSID. OOBE 階段裝置斷網，沒 WiFi 段 enrollment 必失敗",
    );
  }
  lines.push(renderWifiSection(input.wifi));

  // 可選本機帳號
  if (input.localAccounts && input.localAccounts.length > 0) {
    lines.push(renderAccountsSection(input.localAccounts));
  }

  // 可選 OOBE skip
  if (input.skipOobe) {
    lines.push(renderOobeSection());
  }

  // ProvisioningCommands —— 永遠輸出：
  // 1. dmwappushservice keepalive scheduled task（每 1 min 拉起，Agent 裝完後 keepalive
  //    service 接管並刪掉此 task）——覆蓋首次 enroll 期間 Agent 未裝的窗口，避免
  //    BITS 下載 agent MSI 時 dmwapp 被 SCM 停導致 callback 丟、job 卡 Status=20
  //    （2026-07-02 真機 PF5XSMN1 root cause，見 brain [[dmwappushservice-keepalive-hack]]）。
  // 2. 帶 forceChangePasswordAtNextLogon=true 的 localAccount → net user 強制改密。
  //
  // ICD schema 限制：DeviceContext 下 CommandLine 只能有一條，故合併成一行 cmd batch。
  const forcedAccounts =
    input.localAccounts?.filter((a) => a.forceChangePasswordAtNextLogon) ?? [];
  lines.push(renderProvisioningCommandsSection(forcedAccounts));

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
      "authPolicy=Certificate schema 未經 Win10 ICD GUI 反向工程驗證；先在 Win10 ICD GUI 設 Certificate 模式 export customizations.xml，再實作此段（見 win-agent-app/scripts/ppkg/README.md）",
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

/**
 * OOBE skip 段 — 2026-06-25 Win10 ICD GUI export 反向工程 schema：
 *
 *   <OOBE>
 *     <Desktop>
 *       <HideOobe>True</HideOobe>            <!-- 注意 "Oobe" 小寫 obe -->
 *     </Desktop>
 *   </OOBE>
 *
 * ICD GUI 在 `OOBE/Desktop` 段下只暴露 `HideOobe` 與 `EnableCortanaVoice` 兩個布林，
 * 沒有 SkipMachineOOBE / SkipUserOOBE。HideOobe 只能隱藏部分 OOBE 互動，**不保證**
 * 完全 bypass 帳號類型選擇頁。真機驗證後若仍卡 OOBE 需走 unattend.xml 方案。
 */
function renderOobeSection(): string {
  return [
    `        <OOBE>`,
    `          <Desktop>`,
    `            <HideOobe>True</HideOobe>`,
    `          </Desktop>`,
    `        </OOBE>`,
  ].join("\n");
}

/**
 * Windows 本機帳號 username 安全字符集 —— 為了讓 username 進 PPKG ProvisioningCommands
 * `cmd /c net user <username> /logonpasswordchg:yes` 命令安全，限制為純字母數字 + 三個
 * 標點符號（`. _ -`），長度 1~20（Windows 本機帳號上限）。
 *
 * 為什麼要在此重新校驗：ProvisioningCommands CommandLine 是進 batch shell 的字串，
 * username 帶 `& | < > " ^ %` 等字符會 shell injection。Accounts/Users 段的 username
 * 走 XML escape 沒這風險，但批次命令 escape 規則跟 XML 不同，分開校驗更穩。
 */
const SAFE_NET_USER_NAME = /^[A-Za-z0-9._-]{1,20}$/;

/**
 * ProvisioningCommands 段 — 2026-06-25 Win10 ICD GUI export 反向工程 schema：
 *
 *   <ProvisioningCommands>
 *     <DeviceContext>
 *       <CommandLine>cmd /c &lt;batch&gt;</CommandLine>
 *     </DeviceContext>
 *   </ProvisioningCommands>
 *
 * DeviceContext 段下 ICD 只暴露 `CommandFiles` 與 `CommandLine` 兩個葉子節點
 * （不是列表，每個 PPKG 一條），CommandLine 以 SYSTEM 身分執行，OOBE 完成前跑。
 *
 * 命令拼接規則：
 * - dmwapp keepalive 段用 `&`（失敗不阻斷後續）：schtasks 已存在時 /F 會覆蓋，
 *   sc start 若服務已在跑會回非零，都不算問題。
 * - net user 之間用 `&&`（前一條失敗後續不跑；教育場景失敗應暴露）。
 * - keepalive 段和 net user 段之間也用 `&`（互相獨立）。
 */
function renderProvisioningCommandsSection(
  forcedAccounts: LocalAccountCustomization[],
): string {
  for (const a of forcedAccounts) {
    if (!SAFE_NET_USER_NAME.test(a.username)) {
      throw new AppError(
        400,
        "invalid_username_for_provisioning_command",
        `username "${a.username}" 含非安全字符（限 [A-Za-z0-9._-]，長度 1~20），無法安全進 PPKG ProvisioningCommands CommandLine`,
      );
    }
  }

  // dmwapp keepalive：先 start 一次覆蓋當下 enrollment 窗口，再建 1min scheduled
  // task 覆蓋 BITS 下載 agent MSI 期間（Agent 未裝所以 keepalive service 不存在）。
  // Agent 裝完首次啟動時 DmwappushKeepaliveService 會刪掉此 task 接管。
  const keepaliveCmds = [
    `sc start dmwappushservice`,
    `schtasks /Create /TN CoGrowDmwappKeepalive /TR "sc start dmwappushservice" /SC MINUTE /MO 1 /RU SYSTEM /F`,
  ].join(" & ");

  const netUserCmds = forcedAccounts
    .map((a) => `net user ${a.username} /logonpasswordchg:yes`)
    .join(" && ");

  const batchParts = [keepaliveCmds];
  if (netUserCmds) batchParts.push(netUserCmds);
  const commandLine = `cmd /c ${batchParts.join(" & ")}`;

  return [
    `        <ProvisioningCommands>`,
    `          <DeviceContext>`,
    `            <CommandLine>${escapeXmlText(commandLine)}</CommandLine>`,
    `          </DeviceContext>`,
    `        </ProvisioningCommands>`,
  ].join("\n");
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
