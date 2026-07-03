/**
 * Windows MDM CSP (Configuration Service Provider) 命令封裝
 *
 * 高階 API → SyncML 命令物件，由 syncml.ts 序列化為 XML。
 * CSP 路徑速查（本案 MVP 用到的）：
 *   - RemoteWipe/doWipe                          清除設備
 *   - EnterpriseModernAppManagement/AppInstallation/<PFN>/StoreInstall   安裝 MSIX
 *   - EnterpriseModernAppManagement/AppInventoryQuery   應用清單查詢
 *   - DMClient/Provider/<ProviderID>/Push        推播設定（PFN/ChannelURI）
 */

import type { SyncMLCommand } from "./syncml.ts";

// ============================================================
// 遠端清除（RemoteWipe）
// ============================================================

/** RemoteWipe 動作 */
export type WipeAction = "doWipe" | "doWipeProtected" | "doWipePersistProvisionedData";

/**
 * 建立遠端清除命令
 * - doWipe                          一般清除
 * - doWipeProtected                 受保護清除（會在重置後重新進入 OOBE）
 * - doWipePersistProvisionedData    保留預配資料（適合 Autopilot 重設）
 */
export function buildRemoteWipe(action: WipeAction = "doWipe"): SyncMLCommand {
  return {
    cmdId: "0", // 由 buildSyncML 填入真實值
    verb: "Exec",
    target: `./Device/Vendor/MSFT/RemoteWipe/${action}`,
  };
}

// ============================================================
// MDM Unenroll（遠端移除 MDM 管控）
// ============================================================

/**
 * 遠端觸發設備移除 MDM enrollment。
 *
 * Exec ./Device/Vendor/MSFT/DMClient/Unenroll
 * data = providerId（通常 "MS DM Server"，與 enrollment 時一致）
 *
 * 設備收到後會移除 enrollment + 清除 MDM 下發的策略。
 * 注意：EDA-CSP 安裝的 MSI 不會被自動移除，需提前下發 MSI uninstall。
 */
export function buildUnenroll(providerId = "MS DM Server"): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Exec",
    target: `./Device/Vendor/MSFT/DMClient/Unenroll`,
    format: "chr",
    data: providerId,
  };
}

// ============================================================
// RemoteLock 說明（桌面無即時鎖屏 CSP → 走 Agent + Registry 信箱）
// ============================================================
//
// **Windows 10/11 Pro 沒有「立即鎖屏」標準 CSP**（RemoteLock CSP 僅 Mobile/Phone）。
// MS-docs 列出的相關 CSP 都是策略型（Policy DeviceLock/idle 策略、SurfaceHub、RemoteFind）。
//
// **方案（見 [[windows-lock-design]]）**：真鎖屏由 Agent App 實現。服務端用 Registry CSP
// 把鎖定狀態寫進設備 Registry 當「信箱」，Agent 監聽（RegNotifyChangeKeyValue）後彈全螢幕
// 鎖定窗 + 顯示聯絡訊息。`buildLockState`（見本檔 Registry CSP 段）負責投遞鎖定狀態，
// 復用 WNS push + SyncML + Registry CSP 鏈路（已真機驗證）。
//
// LOCK / ENABLE_LOST_MODE → buildLockState(enabled:true)；DISABLE_LOST_MODE → enabled:false。
// 加固：鎖定期間同時設 DisableTaskMgr=1 禁用任務管理器，堵死殺進程逃逸。
// 不再用 Reboot 替代 LOCK（Reboot 保留為獨立 REBOOT 命令）。

// ============================================================
// Reboot（遠端重啟）
// ============================================================

/**
 * 遠端重啟設備。Exec ./Device/Vendor/MSFT/Reboot/RebootNow（或 Schedule/Single）。
 *
 * 路徑：
 *   - RebootNow            立即重啟（會通知用戶 5 分鐘倒數）
 *   - Schedule/Single      指定時間重啟（datetime ISO 8601）
 *   - Schedule/DailyRecurrent  每日重複
 *
 * 真機回應：命令排隊 → push 觸發 SyncML session → 設備 ack →
 * 約 5 分鐘倒數 → 系統重啟。
 */
export type RebootMode = "RebootNow" | "ScheduleSingle" | "ScheduleDailyRecurrent";

export function buildReboot(mode: RebootMode = "RebootNow", scheduledTime?: string): SyncMLCommand {
  if (mode === "RebootNow") {
    return {
      cmdId: "0",
      verb: "Exec",
      target: "./Device/Vendor/MSFT/Reboot/RebootNow",
    };
  }
  if (mode === "ScheduleSingle") {
    if (!scheduledTime) {
      throw new Error("buildReboot: ScheduleSingle 需提供 scheduledTime (ISO 8601)");
    }
    return {
      cmdId: "0",
      verb: "Exec",
      target: "./Device/Vendor/MSFT/Reboot/Schedule/Single",
      format: "chr",
      data: scheduledTime,
    };
  }
  if (mode === "ScheduleDailyRecurrent") {
    if (!scheduledTime) {
      throw new Error(
        "buildReboot: ScheduleDailyRecurrent 需提供 scheduledTime (ISO 8601，每日該時間)",
      );
    }
    return {
      cmdId: "0",
      verb: "Exec",
      target: "./Device/Vendor/MSFT/Reboot/Schedule/DailyRecurrent",
      format: "chr",
      data: scheduledTime,
    };
  }
  throw new Error(`buildReboot: unknown mode ${mode}`);
}

// ============================================================
// MSIX 應用安裝（EnterpriseModernAppManagement）
// ============================================================

/** MSIX 安裝參數 */
export interface MsixInstallParams {
  /** Package Family Name，例：Microsoft.WindowsCalculator_8wekyb3d8bbwe */
  packageFamilyName: string;
  /** 簽署過的 .msix / .msixbundle / .appx HTTPS URL（XSD 中 PackageUri 屬性） */
  contentUri: string;
  /**
   * SHA-256 雜湊（hex 字串）
   * @deprecated XSD 不含 Hash 欄位；HTTPS 場景下 device 信任 MSIX 自身簽名。
   * 保留欄位避免破壞舊呼叫方，但本實作不再傳給 device。
   */
  hashHex?: string;
  /**
   * isLOB=true 走 HostedInstall（從我們的 HTTPS 拉，自家簽署的 LOB 應用，預設）
   * isLOB=false 走 StoreInstall（從 Microsoft Store 拉，需提供 PackageIdentityName/Publisher，本實作未支援）
   */
  isLOB?: boolean;
  /** 強制升級到任意版本（可降版） */
  forceUpdateToAnyVersion?: boolean;
  /** 強制關閉正在運行的應用以完成安裝/升級 */
  forceApplicationShutdown?: boolean;
  /** 延遲註冊（在應用關閉後才註冊新版本，平滑升級體驗） */
  deferRegistration?: boolean;
  /** 額外依賴包 URI（XSD 中 <Dependencies><Dependency PackageUri="..."/></Dependencies>） */
  dependencyUris?: string[];
}

/**
 * EnterpriseModernAppManagement HostedInstall DeploymentOptions 位掩碼
 *
 * Spec 公開的 attribute 是 unsignedByte，但具體位含義 Microsoft 未公開列出。
 * 以下對應為社區 / Intune 抓包逆向常用值，未經官方文檔確認。
 */
const DEPLOYMENT_OPT_FORCE_APP_SHUTDOWN = 0x01;
const DEPLOYMENT_OPT_DEV_MODE = 0x02;
const DEPLOYMENT_OPT_INSTALL_ALL_RESOURCES = 0x04;
const DEPLOYMENT_OPT_FORCE_TARGET_APP_SHUTDOWN = 0x08;
const DEPLOYMENT_OPT_FORCE_UPDATE_TO_ANY_VERSION = 0x40;
const DEPLOYMENT_OPT_DEFER_REGISTRATION = 0x80;

/**
 * 建立 AppInstallation/{PFN} 節點的 Add 命令
 *
 * Spec 要求：要安裝新 LOB MSIX 必須先 Add 創建 PFN entity，再 Exec HostedInstall。
 * 跳過 Add 直接 Exec → device 回 404 Not Found（真機驗證確認）。
 * Update 場景下 PFN 節點已存在，不需要 Add，可以直接 Exec HostedInstall（含 ForceUpdateToAnyVersion）。
 */
export function buildMsixInstallAddNode(
  packageFamilyName: string
): SyncMLCommand {
  const encodedPfn = encodeURIComponent(packageFamilyName);
  return {
    cmdId: "0",
    verb: "Add",
    target:
      `./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/${encodedPfn}`,
    format: "node",
  };
}

/**
 * 建立 MSIX 安裝/升級的 Exec HostedInstall 命令
 *
 * EnterpriseModernAppManagement CSP HostedInstall 用於從 LOB HTTPS source 拉取
 * 自簽 MSIX 套件。同 PFN 高版本即覆蓋升級；強制覆蓋（含降版）需 forceUpdateToAnyVersion=true。
 *
 * 路徑：./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/<PFN>/HostedInstall
 * Format=xml；Data 是 <HostedInstallAction> XML。
 *
 * 首次 install 場景必須先用 buildMsixInstallAddNode() 創建節點，再呼叫此函數。
 * Update 場景可直接呼叫此函數（節點已存在）。
 */
export function buildMsixInstall(params: MsixInstallParams): SyncMLCommand {
  const {
    packageFamilyName,
    contentUri,
    isLOB = true,
    forceUpdateToAnyVersion,
    forceApplicationShutdown,
    deferRegistration,
    dependencyUris,
  } = params;
  if (!isLOB) {
    throw new Error(
      "buildMsixInstall: isLOB=false (StoreInstall) 未支援；本實作專做 LOB HostedInstall"
    );
  }
  const encodedPfn = encodeURIComponent(packageFamilyName);
  const cspPath =
    `./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/${encodedPfn}/HostedInstall`;

  // 真機 XSD（GitHub MicrosoftDocs/windows-itpro-docs）：
  //   <Application PackageUri="https://..." DeploymentOptions="N">
  //     <Dependencies><Dependency PackageUri="..."/></Dependencies>
  //   </Application>
  // 沒有 <HostedInstallAction>，沒有 <Hash>。Hash 不需要（HTTPS 信任 MSIX 簽名）。
  let deploymentOptions = 0;
  if (forceApplicationShutdown) deploymentOptions |= DEPLOYMENT_OPT_FORCE_APP_SHUTDOWN;
  if (forceUpdateToAnyVersion) {
    deploymentOptions |= DEPLOYMENT_OPT_FORCE_UPDATE_TO_ANY_VERSION;
  }
  if (deferRegistration) deploymentOptions |= DEPLOYMENT_OPT_DEFER_REGISTRATION;

  const attrs = [`PackageUri="${escapeAttr(contentUri)}"`];
  if (deploymentOptions) {
    attrs.push(`DeploymentOptions="${deploymentOptions}"`);
  }
  let innerXml = `<Application ${attrs.join(" ")}`;
  if (dependencyUris && dependencyUris.length > 0) {
    const deps = dependencyUris
      .map((uri) => `<Dependency PackageUri="${escapeAttr(uri)}" />`)
      .join("");
    innerXml += `><Dependencies>${deps}</Dependencies></Application>`;
  } else {
    innerXml += " />";
  }

  return {
    cmdId: "0",
    verb: "Exec",
    target: cspPath,
    format: "xml",
    data: innerXml,
  };
}

/**
 * 建立 MSIX 升級命令（薄封裝）
 *
 * 同 install 入參，自動帶 forceUpdateToAnyVersion=true 確保新版本能覆蓋舊版（甚至降版）。
 * 默認不關閉運行中的應用（需要可傳 forceApplicationShutdown=true）。
 */
export function buildMsixUpdate(
  params: Omit<MsixInstallParams, "forceUpdateToAnyVersion">
): SyncMLCommand {
  return buildMsixInstall({ ...params, forceUpdateToAnyVersion: true });
}

/**
 * 建立 UpdateScan Exec 命令
 *
 * 觸發設備掃描所有可升級的 MSIX 應用（針對之前透過 HostedInstall 部署過的）。
 * 設備按結果與後續策略自動拉取新版本，不需指定特定 PFN。
 *
 * 路徑：./Device/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/UpdateScan
 */
export function buildUpdateScan(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Exec",
    target:
      "./Device/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/UpdateScan",
  };
}

// ============================================================
// EnterpriseDesktopAppManagement (EDA) — Win32 .msi 派發
// ============================================================
//
// 與 EnterpriseModernAppManagement (MSIX) 對照：
//   ─────────────────────┬───────────────────┬─────────────────────────────
//   能力                  MSIX                .msi (EDA)
//   ─────────────────────┼───────────────────┼─────────────────────────────
//   Entity key            PFN                ProductCode {GUID}
//   Install verb / format Exec / xml          Add / chr
//   Install LocURI 末段    /HostedInstall     /DownloadInstall
//   Install data XML root <Application ...>  <MsiInstallJob ...>
//   Uninstall             Delete /AppStore   Exec /{ProductID}/Uninstall
//   Status                透過 inventory     /{ProductID}/Status
//
// 參考：https://learn.microsoft.com/en-us/windows/client-management/mdm/enterprisedesktopappmanagement-csp

/** MSI ProductCode GUID 格式校驗（含或不含大括號皆允許輸入；helper 內部統一帶括號）*/
const MSI_PRODUCT_ID_REGEX =
  /^\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$/;

/**
 * 正規化 ProductCode：大寫 + 帶大括號，符合 MSI ProductCode 標準寫法。
 * 例：`b91cf9b4-1234-5678-9abc-def012345678` → `{B91CF9B4-1234-5678-9ABC-DEF012345678}`
 */
function normalizeProductId(productId: string): string {
  if (!MSI_PRODUCT_ID_REGEX.test(productId)) {
    throw new TypeError(
      `Invalid MSI ProductCode "${productId}"；需 GUID 格式（含/不含大括號）`,
    );
  }
  const upper = productId.toUpperCase();
  return upper.startsWith("{") ? upper : `{${upper}}`;
}

/**
 * MSI 派發單個依賴包描述。
 *
 * MsiInstallJob 規範下每個 Product 也可以是依賴，但實務上多個依賴需各自獨立
 * 完整 install command 派發；本介面僅保留必要欄位給呼叫端參考。
 */
export interface MsiDependency {
  /** 依賴 MSI 的 ProductCode（GUID 格式）*/
  productId: string;
  /** 依賴 MSI 的 Version */
  productVersion: string;
  /** 依賴 MSI 的下載 URL */
  contentUri: string;
  /** SHA-256 hex 雜湊（選填）*/
  fileHashHex?: string;
}

/** MSI 派發參數 */
export interface MsiInstallParams {
  /**
   * MSI ProductCode（GUID）。對應 .msi 內 `Property` 表的 ProductCode 欄位。
   * 可用 `msiexec /a /qb /lvx*` 或 PowerShell `Get-Package` 取出。
   */
  productId: string;
  /** MSI 版本字串，對應 .msi `ProductVersion` 屬性（如 "1.0.0.0" / "2.3"）*/
  productVersion: string;
  /** 簽署過的 .msi HTTPS URL */
  contentUri: string;
  /**
   * SHA-256 雜湊（hex 字串，不含大括號或前綴）。
   * 強烈建議帶上：device 會用此 hash 校驗下載完整性，避免中間人替換。
   * HTTPS 場景下也可省略（device 信任 TLS 通道），但保險起見預設要求。
   */
  fileHashHex?: string;
  /** msiexec 命令行；預設 "/quiet /norestart"（無互動 + 不重啟）*/
  commandLine?: string;
  /** 安裝整體超時（分鐘），到期未完成視為失敗。預設 10 */
  timeOutMinutes?: number;
  /** 下載失敗重試次數。預設 3 */
  retryCount?: number;
  /** 重試間隔（分鐘）。預設 5 */
  retryIntervalMinutes?: number;
  /**
   * 安裝範圍：
   *   - "Device"（預設）：per-machine 安裝，所有用戶都能用，需 system 權限
   *   - "User"：per-user 安裝，僅當前登入用戶（罕用）
   */
  installContext?: "Device" | "User";
  /** 依賴包描述（資訊性質；目前 helper 不自動派發依賴）*/
  dependencies?: MsiDependency[];
}

/** EDA-CSP base path（依 installContext 不同對應 ./Device 或 ./User）*/
function edaBase(context: "Device" | "User" = "Device"): string {
  return `./${context}/Vendor/MSFT/EnterpriseDesktopAppManagement/MSI`;
}

/**
 * 組裝 MsiInstallJob XML（DownloadInstall 命令的 data）。
 *
 * 結構（依 EDA-CSP spec）：
 *   <MsiInstallJob id="{GUID}">
 *     <Product Version="...">
 *       <Download>
 *         <ContentURLList>
 *           <ContentURL>https://...</ContentURL>
 *         </ContentURLList>
 *       </Download>
 *       <Validation>
 *         <FileHash>hex</FileHash>
 *       </Validation>
 *       <Enforcement>
 *         <CommandLine>/quiet /norestart</CommandLine>
 *         <TimeOut>10</TimeOut>
 *         <RetryCount>3</RetryCount>
 *         <RetryInterval>5</RetryInterval>
 *       </Enforcement>
 *     </Product>
 *   </MsiInstallJob>
 *
 * 注意：data 是 chr 格式（不是 xml），整個 XML 字串會被 SyncML 層用 CDATA 包起來。
 */
function buildMsiInstallJobXml(params: MsiInstallParams): string {
  const productId = normalizeProductId(params.productId);
  const enforcement = [
    `<CommandLine>${escapeText(params.commandLine ?? "/quiet /norestart")}</CommandLine>`,
    `<TimeOut>${params.timeOutMinutes ?? 10}</TimeOut>`,
    `<RetryCount>${params.retryCount ?? 3}</RetryCount>`,
    `<RetryInterval>${params.retryIntervalMinutes ?? 5}</RetryInterval>`,
  ].join("");

  const validation = params.fileHashHex
    ? `<Validation><FileHash>${escapeText(params.fileHashHex)}</FileHash></Validation>`
    : "";

  return (
    `<MsiInstallJob id="${escapeAttr(productId)}">` +
    `<Product Version="${escapeAttr(params.productVersion)}">` +
    `<Download><ContentURLList>` +
    `<ContentURL>${escapeText(params.contentUri)}</ContentURL>` +
    `</ContentURLList></Download>` +
    validation +
    `<Enforcement>${enforcement}</Enforcement>` +
    `</Product>` +
    `</MsiInstallJob>`
  );
}

/**
 * 建立 .msi 派發命令（Add /DownloadInstall）。
 *
 * 設備收到後：
 *   1. 從 contentUri 下載 .msi（含 retry）
 *   2. （若帶 fileHash）SHA-256 校驗
 *   3. msiexec /i agent.msi {commandLine}
 *   4. 結果記錄到 ./MSI/{ProductID}/Status / LastError / LastErrorDesc
 *
 * 後端可隨時 Get /Status 查進度（用 buildMsiStatusQuery）。
 */
export function buildMsiInstall(params: MsiInstallParams): SyncMLCommand {
  const productId = normalizeProductId(params.productId);
  const context = params.installContext ?? "Device";
  return {
    cmdId: "0",
    verb: "Add",
    target: `${edaBase(context)}/${encodeURIComponent(productId)}/DownloadInstall`,
    format: "chr",
    data: buildMsiInstallJobXml(params),
  };
}

/**
 * 建立 .msi 卸載命令（Delete `MSI/{ProductID}` 整個節點）。
 *
 * Microsoft EDA-CSP MSI schema **沒有 `/Uninstall` sub-node**——標準卸載是對整個
 * `MSI/{ProductID}` 節點發 SyncML Delete，CSP 內部會觸發 `msiexec /x {ProductID} /quiet`。
 * 走錯路徑（如 `/Uninstall` Exec）會返 404 not found（2026-06-26 真機踩到）。
 *
 * 參考：https://learn.microsoft.com/en-us/windows/client-management/mdm/enterprisedesktopappmanagement-csp
 */
export function buildMsiUninstall(
  productId: string,
  context: "Device" | "User" = "Device",
): SyncMLCommand {
  const normalized = normalizeProductId(productId);
  return {
    cmdId: "0",
    verb: "Delete",
    target: `${edaBase(context)}/${encodeURIComponent(normalized)}`,
  };
}

/**
 * 查詢 MSI 安裝狀態（Get /{ProductID}/Status）。
 *
 * Status 回傳整數狀態碼（EDA-CSP spec）：
 *   10  Initialized
 *   20  Download In Progress
 *   25  Pending Download Retry
 *   30  Download Failed
 *   40  Download Completed
 *   48  Pending User Session
 *   50  Enforcement (Install) In Progress
 *   60  Enforcement Completed（成功終態）
 *   70  Enforcement Pending Retry
 *   80  Enforcement Failed（失敗終態）
 *
 * 失敗時搭配 buildMsiLastErrorQuery 拿 Win32 error code。
 */
export function buildMsiStatusQuery(
  productId: string,
  context: "Device" | "User" = "Device",
): SyncMLCommand {
  const normalized = normalizeProductId(productId);
  return {
    cmdId: "0",
    verb: "Get",
    target: `${edaBase(context)}/${encodeURIComponent(normalized)}/Status`,
  };
}

/**
 * 查詢 MSI 最後一次安裝錯誤碼（Get /{ProductID}/LastError）。
 *
 * 回傳值為 Win32 / MSI error code（hex string），例 0x80070643（MSI install failed）。
 * 對應描述用 buildMsiLastErrorDescQuery 拿（人類可讀字串）。
 */
export function buildMsiLastErrorQuery(
  productId: string,
  context: "Device" | "User" = "Device",
): SyncMLCommand {
  const normalized = normalizeProductId(productId);
  return {
    cmdId: "0",
    verb: "Get",
    target: `${edaBase(context)}/${encodeURIComponent(normalized)}/LastError`,
  };
}

/**
 * 查詢 MSI 最後一次安裝錯誤描述（Get /{ProductID}/LastErrorDesc）。
 *
 * 回傳本地化的錯誤描述字串。失敗診斷時搭配 LastError 一起取。
 */
export function buildMsiLastErrorDescQuery(
  productId: string,
  context: "Device" | "User" = "Device",
): SyncMLCommand {
  const normalized = normalizeProductId(productId);
  return {
    cmdId: "0",
    verb: "Get",
    target: `${edaBase(context)}/${encodeURIComponent(normalized)}/LastErrorDesc`,
  };
}

// ============================================================
// EnterpriseModernAppManagement (MSIX) — AppInventory 查詢
// ============================================================

/**
 * AppInventoryQuery 條件參數（按 EnterpriseModernAppManagement CSP spec）
 *
 * 預設值對齊「應用列表＋詳細資料」最常見場景：取所有 Source、含詳細欄位、
 * 排除 Framework / Resource 包。
 */
export interface AppInventoryFilter {
  /** Output 旗標（可組合，用 `|` 分隔），預設 PackageDetails */
  output?: string;
  /** Source（單選；省略=全部）：AppStore / nonStore / System */
  source?: "AppStore" | "nonStore" | "System";
  /** PackageTypeFilter（可組合 `|`），預設 Main|Bundle */
  packageTypeFilter?: string;
  /** 限定 PFN（精確匹配子串） */
  packageFamilyName?: string;
  /** 限定 Publisher */
  publisher?: string;
}

/**
 * 設定 AppInventoryQuery 條件（步驟 1/2）
 *
 * 必須在 Get AppInventoryResults 前以 Replace 寫入 `<Inventory ... />` XML。
 * 路徑必須含中間段 `AppManagement`（舊版本實作漏寫導致 device 回 400）。
 */
export function buildAppInventoryConfig(
  filter: AppInventoryFilter = {}
): SyncMLCommand {
  const {
    output = "PackageDetails",
    source,
    packageTypeFilter = "Main|Bundle",
    packageFamilyName,
    publisher,
  } = filter;
  const attrs: string[] = [`Output="${escapeAttr(output)}"`];
  if (source) attrs.push(`Source="${escapeAttr(source)}"`);
  if (packageTypeFilter) {
    attrs.push(`PackageTypeFilter="${escapeAttr(packageTypeFilter)}"`);
  }
  if (packageFamilyName) {
    attrs.push(`PackageFamilyName="${escapeAttr(packageFamilyName)}"`);
  }
  if (publisher) attrs.push(`Publisher="${escapeAttr(publisher)}"`);
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/AppInventoryQuery",
    format: "xml",
    data: `<Inventory ${attrs.join(" ")} />`,
  };
}

/**
 * 拉取 AppInventoryResults（步驟 2/2）
 *
 * 設備回應為 SyncML <Results>，根據 Replace 設定的條件返回應用清單。
 * 必須在 buildAppInventoryConfig 之後執行。
 */
export function buildAppInventoryFetch(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Get",
    target:
      "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/AppInventoryResults",
  };
}

/**
 * 建立移除 MSIX 命令
 */
export function buildMsixUninstall(packageFamilyName: string): SyncMLCommand {
  const encodedPfn = encodeURIComponent(packageFamilyName);
  return {
    cmdId: "0",
    verb: "Delete",
    target: `./User/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/AppStore/${encodedPfn}`,
  };
}

// ============================================================
// DMClient Push (WNS) 配置
// ============================================================

/**
 * 設置 device 的 push 接收 PFN
 *
 * device 收到此 Replace 後 DMClient 服務會去 WNS 注册 push channel（通過 OS API），
 * 注册成功後可從 ./Push/ChannelURI 節點 Get 拿到 URI。
 *
 * ⚠️ 前置：該 PFN 對應的 MSIX 必須已裝在 device 上且實作了 push notification background task，
 * 否則 Replace 會失敗或 ChannelURI 拿不到值。
 */
export function buildSetPushPfn(
  pfn: string,
  providerId = "MS DM Server"
): SyncMLCommand {
  const provider = encodeURIComponent(providerId);
  return {
    cmdId: "0",
    verb: "Replace",
    target: `./Vendor/MSFT/DMClient/Provider/${provider}/Push/PFN`,
    format: "chr",
    data: pfn,
  };
}

/**
 * 拉取 device 注冊到 WNS 的 push channel URI
 *
 * 路徑：./Vendor/MSFT/DMClient/Provider/<ProviderID>/Push/ChannelURI
 * 結果為 https://*.notify.windows.com/... 字串，server 入庫後即可 send raw notification。
 */
export function buildGetPushChannelUri(
  providerId = "MS DM Server"
): SyncMLCommand {
  const provider = encodeURIComponent(providerId);
  return {
    cmdId: "0",
    verb: "Get",
    target: `./Vendor/MSFT/DMClient/Provider/${provider}/Push/ChannelURI`,
  };
}

// ============================================================
// DMClient Polling 配置
// ============================================================

/**
 * Polling 配置參數
 *
 * Win10 默認 polling 間隔很長（IntervalForFirstSetOfRetries 預設 15 分鐘僅前 8 次，
 * 之後切到 IntervalForRemainingScheduledRetries 預設 480 分鐘=8 小時）。
 * 為讓命令能在 1-5 分鐘內到達 device，需顯式 Replace 這些節點。
 *
 * 推薦生產配置：
 *   - intervalFirst=5（前 8 次，密集 retry 5 分鐘一次）
 *   - countFirst=8
 *   - intervalRest=15（之後 15 分鐘一次，平衡及時性 vs 耗電）
 *   - countRest=0（0=無限）
 */
export interface PollConfig {
  /** 前 N 次 retry 的間隔（分鐘）。預設 5。 */
  intervalFirst?: number;
  /** 前段 retry 次數。預設 8。 */
  countFirst?: number;
  /** 後續 retry 的間隔（分鐘）。預設 15。 */
  intervalRest?: number;
  /** 後段 retry 次數（0=無限）。預設 0。 */
  countRest?: number;
  /** 用戶登入時是否觸發 poll。預設 true。 */
  pollOnLogin?: boolean;
  /** ProviderID。MS-MDE2 自建 enrollment 用 magic name "MS DM Server"。 */
  providerId?: string;
}

/**
 * 建立 DMClient polling 配置命令序列（多條 Replace）
 *
 * 路徑：./Vendor/MSFT/DMClient/Provider/<ProviderID>/Poll/{IntervalForFirstSetOfRetries|...}
 * Format=int / bool。
 *
 * 注意：ProviderID 在 URI 中需 URL encode（含空格的 "MS DM Server" → "MS%20DM%20Server"）。
 */
export function buildSetPollInterval(opts: PollConfig = {}): SyncMLCommand[] {
  const {
    intervalFirst = 5,
    countFirst = 8,
    intervalRest = 15,
    countRest = 0,
    pollOnLogin = true,
    providerId = "MS DM Server",
  } = opts;
  const provider = encodeURIComponent(providerId);
  const base =
    `./Vendor/MSFT/DMClient/Provider/${provider}/Poll`;
  return [
    intReplace(`${base}/IntervalForFirstSetOfRetries`, intervalFirst),
    intReplace(`${base}/NumberOfFirstRetries`, countFirst),
    intReplace(`${base}/IntervalForRemainingScheduledRetries`, intervalRest),
    intReplace(`${base}/NumberOfRemainingScheduledRetries`, countRest),
    boolReplace(`${base}/PollOnLogin`, pollOnLogin),
  ];
}

function intReplace(target: string, value: number): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target,
    format: "int",
    data: String(value),
  };
}

function boolReplace(target: string, value: boolean): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target,
    format: "bool",
    data: value ? "true" : "false",
  };
}

// ============================================================
// Registry CSP（任意註冊表讀寫）
// ============================================================

/**
 * Registry CSP 對應的 Windows hive。
 * MDM 場景幾乎只用 HKLM（HKCU 限當前登入用戶 session）。
 * 完整 hive 對應：
 *   - HKLM = HKEY_LOCAL_MACHINE
 *   - HKCU = HKEY_CURRENT_USER
 *   - HKU  = HKEY_USERS
 *   - HKCR = HKEY_CLASSES_ROOT
 *   - HKCC = HKEY_CURRENT_CONFIG
 */
export type RegistryHive = "HKLM" | "HKCU" | "HKU" | "HKCR" | "HKCC";

/**
 * Registry value 類型對應的 SyncML Format。
 *   - string       → REG_SZ        Format=chr
 *   - expandString → REG_EXPAND_SZ Format=chr  含環境變數的字串
 *   - int          → REG_DWORD     Format=int
 *   - binary       → REG_BINARY    Format=b64  二進制資料以 base64 編碼
 */
export type RegistryValueType = "string" | "expandString" | "int" | "binary";

/** 單一 registry value 寫入規格 */
export interface RegistryEntry {
  /** Value 名稱（注意：寫入 hive 的 default value 不適用 Registry CSP）*/
  name: string;
  /** Value 類型 */
  type: RegistryValueType;
  /**
   * Value 內容：
   *   - string / expandString：UTF-16 字串
   *   - int：32-bit 無正負號整數
   *   - binary：原始 bytes（Uint8Array）；helper 內部 base64 編碼
   */
  value: string | number | Uint8Array;
}

/**
 * 將 Windows 註冊表路徑正規化為 Registry CSP 用的 LocURI 片段。
 * 例：`SOFTWARE\Policies\CoGrowMDM\Agent` → `SOFTWARE/Policies/CoGrowMDM/Agent`
 *
 * 規範：
 *   - 反斜杠統一改成正斜杠
 *   - 去掉前後多餘的 `/`
 *   - 不做 URL encode（CSP path 內各層級允許空格與大部分字符）
 */
function normalizeRegistryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * 組裝 Registry CSP 的 LocURI。
 *
 * Format：`./Device/Vendor/MSFT/Registry/{HIVE}/{SubPath}/{ValueName}`
 *
 * 若 valueName 省略則指向整個 key（用於 Delete 整 key、或 Get 列舉子值）。
 *
 * 參考：
 *   https://learn.microsoft.com/en-us/windows/client-management/mdm/registry-csp
 */
function buildRegistryTarget(opts: {
  hive: RegistryHive;
  path: string;
  valueName?: string;
}): string {
  const subPath = normalizeRegistryPath(opts.path);
  const base = `./Device/Vendor/MSFT/Registry/${opts.hive}/${subPath}`;
  return opts.valueName ? `${base}/${opts.valueName}` : base;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Deno + Node 18+ 都有全域 btoa；用 chunk 避免 stack 爆掉
  let s = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(s);
}

function encodeRegistryValue(entry: RegistryEntry): { data: string; format: string } {
  switch (entry.type) {
    case "string":
    case "expandString":
      if (typeof entry.value !== "string") {
        throw new TypeError(
          `Registry entry "${entry.name}" type=${entry.type} requires string value`,
        );
      }
      return { data: entry.value, format: "chr" };

    case "int":
      if (typeof entry.value !== "number" || !Number.isInteger(entry.value)) {
        throw new TypeError(
          `Registry entry "${entry.name}" type=int requires integer value`,
        );
      }
      if (entry.value < 0 || entry.value > 0xffffffff) {
        throw new RangeError(
          `Registry entry "${entry.name}" type=int out of REG_DWORD range (0..2^32-1)`,
        );
      }
      return { data: String(entry.value), format: "int" };

    case "binary":
      if (!(entry.value instanceof Uint8Array)) {
        throw new TypeError(
          `Registry entry "${entry.name}" type=binary requires Uint8Array value`,
        );
      }
      return { data: bytesToBase64(entry.value), format: "b64" };
  }
}

/**
 * 寫入單一註冊表值（Replace 動作；不存在時 device 會自動建立 key + value）。
 *
 * Replace 對 Registry CSP 等同 upsert：value 不存在新建、存在則覆寫。
 * MDM 場景下幾乎所有寫入都用 Replace（Add 也可但語意較嚴格）。
 */
export function buildRegistrySet(opts: {
  hive: RegistryHive;
  path: string;
  entry: RegistryEntry;
}): SyncMLCommand {
  const { data, format } = encodeRegistryValue(opts.entry);
  return {
    cmdId: "0",
    verb: "Replace",
    target: buildRegistryTarget({
      hive: opts.hive,
      path: opts.path,
      valueName: opts.entry.name,
    }),
    format,
    data,
  };
}

/**
 * 批次寫入同一 key 下的多個 value。
 * 回傳多條 Replace 命令，由 buildSyncML 同輪下發。
 *
 * 典型用途：注入 Agent App 配置
 *   buildRegistrySetBatch({
 *     hive: "HKLM",
 *     path: "SOFTWARE/Policies/CoGrowMDM/Agent",
 *     entries: [
 *       { name: "device_id",   type: "string", value: "windows-..." },
 *       { name: "agent_token", type: "string", value: "at_..." },
 *       { name: "api_endpoint", type: "string", value: "https://..." },
 *     ],
 *   });
 */
export function buildRegistrySetBatch(opts: {
  hive: RegistryHive;
  path: string;
  entries: RegistryEntry[];
}): SyncMLCommand[] {
  return opts.entries.map((entry) =>
    buildRegistrySet({ hive: opts.hive, path: opts.path, entry }),
  );
}

/**
 * 讀取單一註冊表值。
 *
 * 回應透過 Results 元素返回，由 command.ts 解析。Format 由 device 決定。
 * 若 valueName 省略則 Get 整個 key（device 回傳子節點列表，需另行解析）。
 */
export function buildRegistryGet(opts: {
  hive: RegistryHive;
  path: string;
  valueName?: string;
}): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Get",
    target: buildRegistryTarget(opts),
  };
}

/**
 * 刪除註冊表值或整個 key。
 *
 * - 帶 valueName：刪除單一 value（key 保留）
 * - 省略 valueName：刪除整個 key（含底下所有 value 與子 key）
 */
export function buildRegistryDelete(opts: {
  hive: RegistryHive;
  path: string;
  valueName?: string;
}): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Delete",
    target: buildRegistryTarget(opts),
  };
}

// ============================================================
// 遠端鎖定（Lock state，ADMX-backed Policy CSP）
// ============================================================
//
// 桌面 Windows 無即時鎖屏 CSP；真鎖屏由 Agent App 監聽 HKLM\SOFTWARE\CoGrow\Agent\Lock
// 旗標後彈全螢幕鎖定窗實現。本段只負責把鎖定狀態投遞到該 Registry。
//
// ⚠️ 投遞通道 = ADMX-backed Policy CSP，**不是** Registry CSP。
// Registry CSP（./Vendor/MSFT/Registry）是 Win10 Mobile 遺留，桌面版整體 404 不可用
// （真機 task 57 三重證據：任意 verb/path 全 404 / 同設備 EDA CSP 200 / 官方文檔頁
// 301 重定向到 Win10 Mobile EOL）。現代桌面 MDM 寫自定義註冊表的正解 = 注入自定義 ADMX
// （ADMXInstall，一次性）→ Set Policy 切換。真機驗證：ADMX key 原始路徑直接落地、未被
// 重定向到 Policies 子樹 → Agent 端 LockWatcher/LockState 讀取路徑零改動。
// 詳見 brain/wiki/admx-backed-policy-registry-write.md。
//
// 限制：① 自定義 ADMXInstall 用 `verb=Replace` 統一寫法（idempotent upsert，6/25 真機
// re-enroll demo 揭露 Add verb 對「設備曾 enroll 過、ADMX template 殘留」場景永遠 418
// Already exists，PolicyManager 半新半舊 → 後續 Set Policy 命令 ack 200 但實際不寫
// target Registry，LOCK / LAPS / BitLocker 全鏈靜默失效）。Replace 對 first-install 等同
// Add，對 re-install 等同 overwrite，故 5 個 helper 統一 Replace。
// ② DisableTaskMgr 加固走自定義 ADMX 被拒（425，Software\...\Policies\System 為系統
// 保留策略區）→ 改由 Agent 端在拉起/關閉 LockUI 時自行寫 HKLM（LocalSystem 有權限），P2。

/** Agent 監聽的鎖定狀態 Registry key（HKLM 下；ADMX policy key 原始落點）*/
export const AGENT_LOCK_REG_PATH = "SOFTWARE/CoGrow/Agent/Lock";

/** ADMX ingest 的應用識別（決定 ADMXInstall LocURI 與 area 命名）*/
const LOCK_ADMX_APP = "CoGrowMDM";
const LOCK_ADMX_ID = "AgentPolicy";
/** Policy CSP area = {App}~Policy~{Category}；Category 來自 ADMX <category name> */
const LOCK_POLICY_AREA = `${LOCK_ADMX_APP}~Policy~CoGrowLock`;
const LOCK_POLICY_NAME = "LockState";
const LOCK_POLICY_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${LOCK_POLICY_AREA}/${LOCK_POLICY_NAME}`;

/**
 * 自定義 ADMX：定義 LockState 策略，落 HKLM\Software\CoGrow\Agent\Lock\{Enabled,Message,Phone}。
 * 省略 ADML / presentation（MDM 不顯示 UI，已真機驗證可 ingest）。displayName 用字面值。
 */
const LOCK_ADMX_XML = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="cogrowmdm" namespace="CoGrow.MDM.Policies" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="CoGrowLock" displayName="CoGrow Lock" />
  </categories>
  <policies>
    <policy name="LockState" class="Machine" displayName="Lock State" explainText="CoGrow remote lock" key="Software\\CoGrow\\Agent\\Lock" valueName="Enabled">
      <parentCategory ref="CoGrowLock" />
      <enabledValue><decimal value="1" /></enabledValue>
      <disabledValue><decimal value="0" /></disabledValue>
      <elements>
        <text id="EnterMessage" valueName="Message" />
        <text id="EnterPhone" valueName="Phone" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>`;

export interface LockStateInput {
  /** true=鎖定；false=解鎖 */
  enabled: boolean;
  /** 鎖定窗顯示訊息（聯絡學校等）；僅 enabled 時寫入 */
  message?: string;
  /** 鎖定窗顯示電話；僅 enabled 時寫入 */
  phone?: string;
}

/**
 * ADMX ingest 命令（Replace ./.../Policy/ConfigOperations/ADMXInstall/{App}/Policy/{Id}）。
 *
 * 用 Replace 是 idempotent upsert：第一次等同 Add，後續 re-enroll 等同 overwrite。6/25
 * 真機 demo 驗證：Add verb 對 re-enroll 設備永遠 418 Already exists，導致 PolicyManager
 * state 不一致 → 後續 LockState Replace ack 200 但實際不寫 target Registry。
 */
export function buildLockAdmxInstall(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${LOCK_ADMX_APP}/Policy/${LOCK_ADMX_ID}`,
    format: "chr",
    data: LOCK_ADMX_XML,
  };
}

/**
 * 建構「遠端鎖定/解鎖」命令（單條 Set Policy，ADMX-backed）。
 *
 * enable  → Replace LockState = `<enabled/>` + Message/Phone（OS 寫 Enabled=1 + 字串值）
 * disable → Replace LockState = `<disabled/>`（OS 寫 Enabled=0）
 *
 * data 是內嵌 XML 片段（format=chr），會被 syncml.ts escapeXml 二次轉義嵌入 SyncML <Data>，
 * 設備端 Policy CSP 解析。message/phone 先 escapeAttr（內層 XML 屬性），避免破壞片段結構。
 *
 * 前置：設備須已 ingest LOCK_ADMX_XML（見 buildLockAdmxInstall）；否則回 404/500。
 * 回傳陣列（保留與舊簽名一致，呼叫端按序 enqueue）；ADMX 單策略一次切換到位，無順序顧慮。
 */
export function buildLockState(input: LockStateInput): SyncMLCommand[] {
  let data: string;
  if (input.enabled) {
    const msg = escapeAttr(input.message ?? "");
    const phone = escapeAttr(input.phone ?? "");
    data = `<enabled/>` +
      `<data id="EnterMessage" value="${msg}"/>` +
      `<data id="EnterPhone" value="${phone}"/>`;
  } else {
    data = `<disabled/>`;
  }
  return [{
    cmdId: "0",
    verb: "Replace",
    target: LOCK_POLICY_TARGET,
    format: "chr",
    data,
  }];
}

// ============================================================
// LAPS-like 密碼託管（ADMX-backed Policy CSP，獨立 ADMX ID）
// ============================================================
//
// 與 Lock 同一 ADMX App（CoGrowMDM），但用獨立 Policy ID（LapsPolicy），
// 避免修改已部署的 Lock ADMX。落點 HKLM\Software\CoGrow\Agent\Laps，
// Agent 端 LapsWatcher 輪詢讀取後執行本機帳號密碼變更。

export const AGENT_LAPS_REG_PATH = "SOFTWARE/CoGrow/Agent/Laps";

const LAPS_ADMX_ID = "LapsPolicy";
const LAPS_POLICY_AREA = `${LOCK_ADMX_APP}~Policy~CoGrowLaps`;
const LAPS_POLICY_NAME = "LapsRotation";
const LAPS_POLICY_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${LAPS_POLICY_AREA}/${LAPS_POLICY_NAME}`;

const LAPS_ADMX_XML = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="cogrowlaps" namespace="CoGrow.MDM.LapsPolicies" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="CoGrowLaps" displayName="CoGrow LAPS" />
  </categories>
  <policies>
    <policy name="LapsRotation" class="Machine" displayName="LAPS Rotation" explainText="CoGrow LAPS password rotation" key="Software\\CoGrow\\Agent\\Laps" valueName="Pending">
      <parentCategory ref="CoGrowLaps" />
      <enabledValue><decimal value="1" /></enabledValue>
      <disabledValue><decimal value="0" /></disabledValue>
      <elements>
        <text id="NewPassword" valueName="NewPassword" />
        <text id="AdminAccount" valueName="AdminAccount" />
        <text id="RotationId" valueName="RotationId" />
        <text id="RequireChange" valueName="RequireChange" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>`;

/**
 * LAPS ADMX ingest（與 Lock ADMX 獨立）。用 Replace 統一 idempotent — 見
 * buildLockAdmxInstall 註解。
 */
export function buildLapsAdmxInstall(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${LOCK_ADMX_APP}/Policy/${LAPS_ADMX_ID}`,
    format: "chr",
    data: LAPS_ADMX_XML,
  };
}

export interface LapsRotationInput {
  newPassword: string;
  adminAccount: string;
  rotationId: string;
  /**
   * true = 附帶 RequireChange=1，Agent 改密後額外跑 `net user <acct> /logonpasswordchg:yes`
   * 強制帳號下次登入必須改密（教育場景學生自訂密碼）。
   * 預設 false（LAPS admin 自動輪換不強制改密）。
   */
  requireChangeOnFirstLogon?: boolean;
}

/**
 * 下發 LAPS 改密指令：啟用 LapsRotation 策略，Agent 讀到 Pending=1 後執行。
 *
 * 值落 HKLM\Software\CoGrow\Agent\Laps\{Pending=1, NewPassword, AdminAccount, RotationId, RequireChange}。
 * Agent 改完密碼後清 NewPassword + 設 Pending=0，並透過 report 帶 rotationId 確認。
 *
 * ⚠️ ADMX required elements 語意（見 memory [[admx_required_elements]]）：
 * data 段**必須**送 4 個 elements（NewPassword/AdminAccount/RotationId/RequireChange），
 * 缺任一 → SyncML 500 + Event 856。RequireChange 用 "0"/"1" 對應 boolean。
 */
export function buildLapsRotation(input: LapsRotationInput): SyncMLCommand[] {
  const pwd = escapeAttr(input.newPassword);
  const account = escapeAttr(input.adminAccount);
  const rotId = escapeAttr(input.rotationId);
  const requireChange = input.requireChangeOnFirstLogon ? "1" : "0";
  const data = `<enabled/>` +
    `<data id="NewPassword" value="${pwd}"/>` +
    `<data id="AdminAccount" value="${account}"/>` +
    `<data id="RotationId" value="${rotId}"/>` +
    `<data id="RequireChange" value="${requireChange}"/>`;
  return [{
    cmdId: "0",
    verb: "Replace",
    target: LAPS_POLICY_TARGET,
    format: "chr",
    data,
  }];
}

/**
 * 清除 LAPS 策略（disabled）：Agent 確認改密後由後端下發，清除 registry 殘留。
 */
export function buildLapsClear(): SyncMLCommand[] {
  return [{
    cmdId: "0",
    verb: "Replace",
    target: LAPS_POLICY_TARGET,
    format: "chr",
    data: `<disabled/>`,
  }];
}

// ============================================================
// 預配套件移除（ADMX-backed Policy CSP）
// ============================================================

const PPKG_ADMX_ID = "PpkgPolicy";
const PPKG_POLICY_AREA = `${LOCK_ADMX_APP}~Policy~CoGrowPpkg`;
const PPKG_POLICY_NAME = "PpkgRemoval";
const PPKG_POLICY_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${PPKG_POLICY_AREA}/${PPKG_POLICY_NAME}`;

const PPKG_ADMX_XML = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="cogrowppkg" namespace="CoGrow.MDM.PpkgPolicies" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="CoGrowPpkg" displayName="CoGrow PPKG" />
  </categories>
  <policies>
    <policy name="PpkgRemoval" class="Machine" displayName="PPKG Removal" explainText="CoGrow provisioning package removal" key="Software\\CoGrow\\Agent\\RemovePpkg" valueName="Pending">
      <parentCategory ref="CoGrowPpkg" />
      <enabledValue><decimal value="1" /></enabledValue>
      <disabledValue><decimal value="0" /></disabledValue>
      <elements>
        <text id="PackageNameFilter" valueName="PackageNameFilter" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>`;

/** PPKG removal ADMX ingest。用 Replace 統一 idempotent — 見 buildLockAdmxInstall 註解。 */
export function buildPpkgRemovalAdmxInstall(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${LOCK_ADMX_APP}/Policy/${PPKG_ADMX_ID}`,
    format: "chr",
    data: PPKG_ADMX_XML,
  };
}

/**
 * 下發預配套件移除指令。Agent 讀到 Pending=1 後移除匹配的 PPKG。
 * @param packageNameFilter 套件名稱過濾（如 "cogrow"），空字串 = 移除所有非系統 PPKG
 */
export function buildPpkgRemoval(packageNameFilter = ""): SyncMLCommand[] {
  const filter = escapeAttr(packageNameFilter);
  return [{
    cmdId: "0",
    verb: "Replace",
    target: PPKG_POLICY_TARGET,
    format: "chr",
    data: `<enabled/><data id="PackageNameFilter" value="${filter}"/>`,
  }];
}

export function buildPpkgRemovalClear(): SyncMLCommand[] {
  return [{
    cmdId: "0",
    verb: "Replace",
    target: PPKG_POLICY_TARGET,
    format: "chr",
    data: `<disabled/>`,
  }];
}

// ============================================================
// Agent 自卸載（ADMX-backed Policy CSP）
// ============================================================

const SELF_UNINSTALL_ADMX_ID = "SelfUninstallPolicy";
const SELF_UNINSTALL_POLICY_AREA = `${LOCK_ADMX_APP}~Policy~CoGrowSelfUninstall`;
const SELF_UNINSTALL_POLICY_NAME = "AgentSelfUninstall";
const SELF_UNINSTALL_POLICY_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${SELF_UNINSTALL_POLICY_AREA}/${SELF_UNINSTALL_POLICY_NAME}`;

const SELF_UNINSTALL_ADMX_XML = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="cogrowuninstall" namespace="CoGrow.MDM.SelfUninstallPolicies" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="CoGrowSelfUninstall" displayName="CoGrow Self Uninstall" />
  </categories>
  <policies>
    <policy name="AgentSelfUninstall" class="Machine" displayName="Agent Self Uninstall" explainText="CoGrow Agent self-uninstall" key="Software\\CoGrow\\Agent\\SelfUninstall" valueName="Pending">
      <parentCategory ref="CoGrowSelfUninstall" />
      <enabledValue><decimal value="1" /></enabledValue>
      <disabledValue><decimal value="0" /></disabledValue>
    </policy>
  </policies>
</policyDefinitions>`;

/** Self-uninstall ADMX ingest。用 Replace 統一 idempotent — 見 buildLockAdmxInstall 註解。 */
export function buildSelfUninstallAdmxInstall(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${LOCK_ADMX_APP}/Policy/${SELF_UNINSTALL_ADMX_ID}`,
    format: "chr",
    data: SELF_UNINSTALL_ADMX_XML,
  };
}

export function buildSelfUninstall(): SyncMLCommand[] {
  return [{
    cmdId: "0",
    verb: "Replace",
    target: SELF_UNINSTALL_POLICY_TARGET,
    format: "chr",
    data: `<enabled/>`,
  }];
}

// ============================================================
// WiFi Profile（./Vendor/MSFT/WiFi/Profile/<SSID>/WlanXml）
// ============================================================
//
// 派發 WLAN profile：Add ./Vendor/MSFT/WiFi/Profile/<SSID>/WlanXml，
// data 是符合 MS WLANProfile schema v1 的 XML 字串（format=chr，由
// syncml.ts 二次 escape 嵌入 SyncML <Data>）。
//
// SSID 含特殊字元時 URL-encode 進 LocURI 路徑；XML 內部 escape SSID/密碼
// 防破壞 profile XML 結構。
//
// 限制：MVP 只支援 open / WPA2-PSK（AES）。WPA3 / 802.1X 企業認證留待後續
// 按需擴展（authEncryption 區塊與 EAP profile 結構差異較大）。

export type WiFiAuth =
  | { type: "open" }
  | { type: "WPA2PSK"; password: string };

export interface WiFiProfileInput {
  ssid: string;
  auth: WiFiAuth;
  /** 自動連線（預設 true） */
  autoConnect?: boolean;
  /** 隱藏 SSID（非廣播，預設 false） */
  nonBroadcast?: boolean;
}

export function buildWiFiProfile(input: WiFiProfileInput): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Add",
    target: `./Vendor/MSFT/WiFi/Profile/${encodeURIComponent(input.ssid)}/WlanXml`,
    format: "chr",
    data: buildWlanProfileXml(input),
  };
}

export function buildWiFiRemove(ssid: string): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Delete",
    target: `./Vendor/MSFT/WiFi/Profile/${encodeURIComponent(ssid)}`,
  };
}

function buildWlanProfileXml(input: WiFiProfileInput): string {
  const ssidName = escapeText(input.ssid);
  const ssidHex = stringToHex(input.ssid);
  const connectionMode = input.autoConnect === false ? "manual" : "auto";
  const nonBroadcast = input.nonBroadcast ? "true" : "false";

  let auth = "open";
  let encryption = "none";
  let sharedKeyXml = "";
  if (input.auth.type === "WPA2PSK") {
    auth = "WPA2PSK";
    encryption = "AES";
    sharedKeyXml =
      `<sharedKey>` +
      `<keyType>passPhrase</keyType>` +
      `<protected>false</protected>` +
      `<keyMaterial>${escapeText(input.auth.password)}</keyMaterial>` +
      `</sharedKey>`;
  }

  return (
    `<?xml version="1.0"?>` +
    `<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">` +
    `<name>${ssidName}</name>` +
    `<SSIDConfig>` +
    `<SSID><hex>${ssidHex}</hex><name>${ssidName}</name></SSID>` +
    `<nonBroadcast>${nonBroadcast}</nonBroadcast>` +
    `</SSIDConfig>` +
    `<connectionType>ESS</connectionType>` +
    `<connectionMode>${connectionMode}</connectionMode>` +
    `<MSM><security>` +
    `<authEncryption>` +
    `<authentication>${auth}</authentication>` +
    `<encryption>${encryption}</encryption>` +
    `<useOneX>false</useOneX>` +
    `</authEncryption>` +
    sharedKeyXml +
    `</security></MSM>` +
    `</WLANProfile>`
  );
}

function stringToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

// ============================================================
// 密碼政策（Policy CSP DeviceLock/*）
// ============================================================
//
// 每個 policy 一條 Replace 命令；輸入只填想設置的欄位，其餘留空不動。
// 所有 policy 路徑都在 ./Device/Vendor/MSFT/Policy/Config/DeviceLock/。
//
// 注意：DevicePasswordEnabled 是 MS 反邏輯欄位（0=啟用，1=停用）；其餘
// 欄位都是直觀正向值。helper 對外暴露 boolean，內部翻譯成正確的 0/1。

export interface PasswordPolicyInput {
  /** 啟用密碼要求 */
  enabled?: boolean;
  /** 最小長度（4-16） */
  minLength?: number;
  /**
   * 複雜度（MinDevicePasswordComplexCharacters）：
   *   1=僅數字 / 2=數字+小寫 / 3=字母數字 / 4=字母數字+特殊字元
   */
  complexity?: 1 | 2 | 3 | 4;
  /** 允許簡單密碼（123456 / aaaa 等） */
  allowSimple?: boolean;
  /** 連續失敗多少次後鎖定 / Wipe */
  maxFailedAttempts?: number;
  /** 閒置自動鎖屏（分鐘，0=禁用此策略） */
  maxInactivityMinutes?: number;
  /** 密碼歷史長度（防重複使用近 N 次密碼） */
  history?: number;
  /** 密碼過期天數（0=永不過期） */
  expirationDays?: number;
}

export function buildPasswordPolicy(input: PasswordPolicyInput): SyncMLCommand[] {
  const cmds: SyncMLCommand[] = [];
  const policy = (name: string, value: number): SyncMLCommand => ({
    cmdId: "0",
    verb: "Replace",
    target: `./Device/Vendor/MSFT/Policy/Config/DeviceLock/${name}`,
    format: "int",
    data: String(value),
  });

  // MS 反邏輯：0=enabled, 1=disabled
  if (input.enabled !== undefined) {
    cmds.push(policy("DevicePasswordEnabled", input.enabled ? 0 : 1));
  }
  if (input.minLength !== undefined) {
    cmds.push(policy("MinDevicePasswordLength", input.minLength));
  }
  if (input.complexity !== undefined) {
    cmds.push(policy("MinDevicePasswordComplexCharacters", input.complexity));
  }
  if (input.allowSimple !== undefined) {
    cmds.push(policy("AllowSimpleDevicePassword", input.allowSimple ? 1 : 0));
  }
  if (input.maxFailedAttempts !== undefined) {
    cmds.push(policy("MaxDevicePasswordFailedAttempts", input.maxFailedAttempts));
  }
  if (input.maxInactivityMinutes !== undefined) {
    cmds.push(policy("MaxInactivityTimeDeviceLock", input.maxInactivityMinutes));
  }
  if (input.history !== undefined) {
    cmds.push(policy("DevicePasswordHistory", input.history));
  }
  if (input.expirationDays !== undefined) {
    cmds.push(policy("DevicePasswordExpiration", input.expirationDays));
  }
  return cmds;
}

// ============================================================
// USB 存儲管控（Policy CSP Storage/Removable*）
// ============================================================
//
// MVP 用 Storage CSP（簡單且廣泛支援）：
//   - RemovableDiskDenyWriteAccess  禁止 USB 存儲寫入
//   - RemovableDiskDenyReadAccess   禁止 USB 存儲讀取
//
// 更徹底的「按設備類別 / 設備 ID 全黑名單」需走 DeviceInstallation CSP
// （PreventInstallationOfMatchingDeviceClasses / DeviceIDs），需要 caller
// 知道具體 USB Setup Class GUID 或 HardwareID，複雜度高，留 W3/W4 擴展。

export interface UsbPolicyInput {
  /** 禁止 USB 存儲寫入（true=禁寫） */
  denyWriteAccess?: boolean;
  /** 禁止 USB 存儲讀取（true=禁讀；通常與 denyWriteAccess 一起設） */
  denyReadAccess?: boolean;
}

export function buildUsbPolicy(input: UsbPolicyInput): SyncMLCommand[] {
  const cmds: SyncMLCommand[] = [];
  const policy = (name: string, value: boolean): SyncMLCommand => ({
    cmdId: "0",
    verb: "Replace",
    target: `./Device/Vendor/MSFT/Policy/Config/Storage/${name}`,
    format: "int",
    data: value ? "1" : "0",
  });

  if (input.denyWriteAccess !== undefined) {
    cmds.push(policy("RemovableDiskDenyWriteAccess", input.denyWriteAccess));
  }
  if (input.denyReadAccess !== undefined) {
    cmds.push(policy("RemovableDiskDenyReadAccess", input.denyReadAccess));
  }
  return cmds;
}

// ============================================================
// AppLocker（./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/...）
// ============================================================
//
// AppLocker 限制設備上能執行的應用。LocURI 結構：
//   ./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions
//     /Grouping/{group}/{EXE|MSI|Script|StoreApps|DLL}/Policy
//
// Policy 數據是 <RuleCollection> XML（format=chr）。每個 RuleCollection 含一組
// 規則（FilePathRule 按路徑 / FilePublisherRule 按簽名者）+ EnforcementMode。
//
// **MS 坑：LocURI 段名 ≠ XML Type 屬性**
//   LocURI 'EXE' → XML Type "Exe"
//   LocURI 'MSI' → XML Type "Msi"
//   LocURI 'StoreApps' → XML Type "Appx"
//   LocURI 'DLL' → XML Type "Dll"
//   LocURI 'Script' → XML Type "Script"
// helper 接受 LocURI 段名，內部做映射。
//
// 限制（W3 後段擴展）：
// - 未實作 FileHashRule（按 SHA-256 哈希）
// - 未實作 FilePublisherRule 的 Exceptions（只 FilePathRule 支 Exceptions）

/** AppLocker RuleCollection 類型（LocURI 段名） */
export type AppLockerRuleCollection =
  | "EXE"
  | "MSI"
  | "Script"
  | "StoreApps"
  | "DLL";

/** AppLocker 強制模式 */
export type AppLockerEnforcementMode =
  | "Enabled"
  | "AuditOnly"
  | "NotConfigured";

export type AppLockerAction = "Allow" | "Deny";

/** S-1-1-0 = Everyone（最常用）；其它可給特定 user/group SID */
export const APPLOCKER_SID_EVERYONE = "S-1-1-0";

export interface AppLockerFilePathRule {
  type: "path";
  /** UUID 字串，AppLocker 用此識別規則（更新時保持不變） */
  id: string;
  name: string;
  description?: string;
  action: AppLockerAction;
  /** 預設 S-1-1-0 Everyone */
  userOrGroupSid?: string;
  /** 路徑模式，支援 *（如 "*\\notepad.exe" 或 "C:\\Windows\\System32\\*"）*/
  path: string;
  /** 例外路徑（規則命中後在 exception 內再排除） */
  exceptions?: { path: string }[];
}

export interface AppLockerFilePublisherRule {
  type: "publisher";
  id: string;
  name: string;
  description?: string;
  action: AppLockerAction;
  userOrGroupSid?: string;
  /** 簽名者 X.500 DN，如 "O=Microsoft Corporation, L=Redmond, S=Washington, C=US" */
  publisherName: string;
  /** 預設 "*"（所有產品） */
  productName?: string;
  /** 預設 "*"（所有 binary） */
  binaryName?: string;
  /** 版本範圍，預設 "*"-"*"（所有版本） */
  versionRange?: { low: string; high: string };
}

export type AppLockerRule = AppLockerFilePathRule | AppLockerFilePublisherRule;

/**
 * 派發一組 AppLocker 規則。
 *
 * @param grouping 任意 group 識別符（如 "default" / "school-policy"），對應
 *   LocURI 的 Grouping 段；同 group 多次派發會覆蓋
 * @param ruleCollection 規則集類型（決定哪類檔案被約束）
 * @param enforcementMode 預設 Enabled；AuditOnly 只記錄不阻止
 * @param rules 規則列表
 */
export function buildAppLockerPolicy(opts: {
  grouping: string;
  ruleCollection: AppLockerRuleCollection;
  enforcementMode?: AppLockerEnforcementMode;
  rules: AppLockerRule[];
}): SyncMLCommand {
  const xmlType = ruleCollectionToXmlType(opts.ruleCollection);
  const mode = opts.enforcementMode ?? "Enabled";
  const rulesXml = opts.rules.map(ruleToXml).join("");
  const policyXml =
    `<RuleCollection Type="${xmlType}" EnforcementMode="${mode}">` +
    rulesXml +
    `</RuleCollection>`;

  return {
    cmdId: "0",
    verb: "Add",
    target:
      `./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/Grouping/${encodeURIComponent(opts.grouping)}/${opts.ruleCollection}/Policy`,
    format: "chr",
    data: policyXml,
  };
}

function ruleCollectionToXmlType(rc: AppLockerRuleCollection): string {
  switch (rc) {
    case "EXE":
      return "Exe";
    case "MSI":
      return "Msi";
    case "Script":
      return "Script";
    case "StoreApps":
      return "Appx";
    case "DLL":
      return "Dll";
  }
}

function ruleToXml(rule: AppLockerRule): string {
  const sid = rule.userOrGroupSid ?? APPLOCKER_SID_EVERYONE;
  const baseAttrs =
    `Id="${escapeAttr(rule.id)}" ` +
    `Name="${escapeAttr(rule.name)}" ` +
    `Action="${rule.action}" ` +
    `UserOrGroupSid="${escapeAttr(sid)}"`;
  const descAttr = rule.description
    ? ` Description="${escapeAttr(rule.description)}"`
    : "";

  if (rule.type === "path") {
    const exceptions = rule.exceptions && rule.exceptions.length > 0
      ? `<Exceptions>` +
        rule.exceptions
          .map((e) => `<FilePathCondition Path="${escapeAttr(e.path)}"/>`)
          .join("") +
        `</Exceptions>`
      : "";
    return (
      `<FilePathRule ${baseAttrs}${descAttr}>` +
      `<Conditions><FilePathCondition Path="${escapeAttr(rule.path)}"/></Conditions>` +
      exceptions +
      `</FilePathRule>`
    );
  }

  const productName = rule.productName ?? "*";
  const binaryName = rule.binaryName ?? "*";
  const versionLow = rule.versionRange?.low ?? "*";
  const versionHigh = rule.versionRange?.high ?? "*";
  return (
    `<FilePublisherRule ${baseAttrs}${descAttr}>` +
    `<Conditions>` +
    `<FilePublisherCondition ` +
    `PublisherName="${escapeAttr(rule.publisherName)}" ` +
    `ProductName="${escapeAttr(productName)}" ` +
    `BinaryName="${escapeAttr(binaryName)}">` +
    `<BinaryVersionRange ` +
    `LowSection="${escapeAttr(versionLow)}" ` +
    `HighSection="${escapeAttr(versionHigh)}"/>` +
    `</FilePublisherCondition>` +
    `</Conditions>` +
    `</FilePublisherRule>`
  );
}

// ============================================================
// PersonalizationCSP（桌布 / 鎖屏圖）
// ============================================================
//
// LocURI：
//   ./Vendor/MSFT/Personalization/DesktopImageUrl       Replace（覆蓋式）
//   ./Vendor/MSFT/Personalization/LockScreenImageUrl    Replace
//   ./Vendor/MSFT/Personalization/DesktopImageStatus    Get（唯讀；1=已套用）
//   ./Vendor/MSFT/Personalization/LockScreenImageStatus Get
//
// 圖片來源支援：HTTPS URL（設備拉取）/ 本地路徑（C:\\...）/ file:// URL
// 格式：JPG/JPEG/PNG/BMP/GIF/TIFF/WMP/JXR
//
// **版本限制（plan §3 line 244-245 已記）**：
//   - 支援版本：Win10/11 Education / Enterprise / Pro 1703+
//   - **Pro 22H2 以下可能回失敗**，發現後平台應顯示「該設備不支援」
//   - Home 版完全不支援
// helper 不做版本判斷；caller 透過 GET *ImageStatus 觀察套用結果。

export interface PersonalizationInput {
  /** 桌布圖 URL（HTTPS / file:// / 本地路徑） */
  desktopImageUrl?: string;
  /** 鎖屏圖 URL（同 desktopImageUrl 格式） */
  lockScreenImageUrl?: string;
}

export function buildPersonalization(
  input: PersonalizationInput,
): SyncMLCommand[] {
  const cmds: SyncMLCommand[] = [];
  if (input.desktopImageUrl !== undefined) {
    cmds.push({
      cmdId: "0",
      verb: "Replace",
      target: "./Vendor/MSFT/Personalization/DesktopImageUrl",
      format: "chr",
      data: input.desktopImageUrl,
    });
  }
  if (input.lockScreenImageUrl !== undefined) {
    cmds.push({
      cmdId: "0",
      verb: "Replace",
      target: "./Vendor/MSFT/Personalization/LockScreenImageUrl",
      format: "chr",
      data: input.lockScreenImageUrl,
    });
  }
  return cmds;
}

/**
 * 查詢桌布或鎖屏圖的套用狀態。
 * 回應 data：1 = 套用成功；其他值代表各種失敗（含「該設備不支援」）。
 */
export function buildPersonalizationStatusQuery(
  target: "desktop" | "lockScreen",
): SyncMLCommand {
  const node = target === "desktop" ? "DesktopImageStatus" : "LockScreenImageStatus";
  return {
    cmdId: "0",
    verb: "Get",
    target: `./Vendor/MSFT/Personalization/${node}`,
  };
}

// ============================================================
// Camera 禁用（Policy CSP Camera/AllowCamera）
// ============================================================
//
// 0 = 禁用內建相機；1 = 允許（系統預設）。
// 適用考試 / 機密場景。Win10 1607+ 起所有版本(Home/Pro/Edu/Ent)皆支援。

export function buildCameraPolicy(allow: boolean): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: "./Device/Vendor/MSFT/Policy/Config/Camera/AllowCamera",
    format: "int",
    data: allow ? "1" : "0",
  };
}

// ============================================================
// 防火牆（Firewall CSP MdmStore/{Global,DomainProfile,PrivateProfile,PublicProfile}）
// ============================================================
//
// LocURI：./Vendor/MSFT/Firewall/MdmStore/{scope}/{prop}
// MVP 只覆蓋「強制啟用 + 不允許關閉」的核心欄位：
//   - EnableFirewall：對應 GUI「Windows Defender 防火牆狀態」
//   - DisableStealthMode：0=啟用隱形（推薦）
//   - DisableInboundNotifications：1=不顯示阻擋通知（避免學生關閉）
//
// scope=Global 設總開關；DomainProfile/PrivateProfile/PublicProfile 各自獨立，
// 強制三 profile 同時啟用最穩。

export type FirewallProfileScope =
  | "Global"
  | "DomainProfile"
  | "PrivateProfile"
  | "PublicProfile";

export interface FirewallPolicyInput {
  /** 強制啟用三個 profile (Domain/Private/Public)。預設 true */
  enabled?: boolean;
  /** 啟用隱形模式（拒絕未請求的入站連線）。預設 true */
  stealthMode?: boolean;
  /** 顯示防火牆阻擋通知。預設 false（學校場景關通知） */
  showNotifications?: boolean;
}

export function buildFirewallPolicy(input: FirewallPolicyInput): SyncMLCommand[] {
  const enabled = input.enabled ?? true;
  const stealth = input.stealthMode ?? true;
  const notify = input.showNotifications ?? false;
  const cmds: SyncMLCommand[] = [];

  const setBool = (scope: FirewallProfileScope, prop: string, val: boolean) => {
    cmds.push({
      cmdId: "0",
      verb: "Replace",
      target: `./Vendor/MSFT/Firewall/MdmStore/${scope}/${prop}`,
      format: "bool",
      data: val ? "true" : "false",
    });
  };

  for (const scope of ["DomainProfile", "PrivateProfile", "PublicProfile"] as const) {
    setBool(scope, "EnableFirewall", enabled);
    // MS 反邏輯：DisableStealthMode=false 代表「啟用隱形」
    setBool(scope, "DisableStealthMode", !stealth);
    // MS 反邏輯：DisableInboundNotifications=true 代表「不顯示通知」
    setBool(scope, "DisableInboundNotifications", !notify);
  }
  return cmds;
}

// ============================================================
// 自動設備命名（Accounts CSP ComputerName）
// ============================================================
//
// LocURI：./Device/Vendor/MSFT/Accounts/ComputerName
// MVP 直接派發已組好的最終名稱字串；模板替換（學校代碼 / 序號）由 service 層
// 完成,CSP 不關心。
//
// 限制：
// - Windows ComputerName 規範：最多 15 字元、不含空白與保留符號
// - 變更後設備需重啟才生效（CSP 套用本身不會立即觸發 reboot）

const COMPUTER_NAME_MAX_LENGTH = 15;
const COMPUTER_NAME_INVALID = /[\s\\/:*?"<>|`'~!@#$%^&()=+[\]{};,.]/;

export function buildSetComputerName(name: string): SyncMLCommand {
  if (!name || name.length === 0) {
    throw new Error("buildSetComputerName: name 不可為空");
  }
  if (name.length > COMPUTER_NAME_MAX_LENGTH) {
    throw new Error(
      `buildSetComputerName: 超過 ${COMPUTER_NAME_MAX_LENGTH} 字元上限 (${name})`,
    );
  }
  if (COMPUTER_NAME_INVALID.test(name)) {
    throw new Error(
      `buildSetComputerName: 含非法字元（空白 / 保留符號）: ${name}`,
    );
  }
  return {
    cmdId: "0",
    verb: "Replace",
    target: "./Device/Vendor/MSFT/Accounts/ComputerName",
    format: "chr",
    data: name,
  };
}

// ============================================================
// 內部工具
// ============================================================

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
