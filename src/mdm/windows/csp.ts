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
// MSIX 應用安裝（EnterpriseModernAppManagement）
// ============================================================

/** MSIX 安裝參數 */
export interface MsixInstallParams {
  /** Package Family Name，例：Microsoft.WindowsCalculator_8wekyb3d8bbwe */
  packageFamilyName: string;
  /** 簽署過的 .msix / .msixbundle / .appx HTTPS URL */
  contentUri: string;
  /** SHA-256 雜湊（hex 字串），對應 contentUri 內容 */
  hashHex: string;
  /**
   * isLOB=true 走 HostedInstall（從我們的 HTTPS 拉，自家簽署的 LOB 應用，預設）
   * isLOB=false 走 StoreInstall（從 Microsoft Store 拉，需提供 PackageIdentityName/Publisher，本實作未支援）
   */
  isLOB?: boolean;
  /**
   * 強制升級到任意版本（可降版）。升級場景請傳 true；首次安裝可省略
   */
  forceUpdateToAnyVersion?: boolean;
  /** 強制關閉正在運行的應用以完成安裝/升級 */
  forceApplicationShutdown?: boolean;
  /** 延遲註冊（在應用關閉後才註冊新版本，平滑升級體驗） */
  deferRegistration?: boolean;
}

/**
 * 建立 MSIX 安裝/升級命令（HostedInstall）
 *
 * EnterpriseModernAppManagement CSP HostedInstall 用於從 LOB HTTPS source 拉取
 * 自簽 MSIX 套件。同 PFN 高版本的 install 即覆蓋升級；要強制升級到任意版本（含降版）
 * 需傳 forceUpdateToAnyVersion=true。
 *
 * 路徑：./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/<PFN>/HostedInstall
 * Format=xml；Data 是 <HostedInstallAction> XML（spec 文件 §HostedInstall）。
 */
export function buildMsixInstall(params: MsixInstallParams): SyncMLCommand {
  const {
    packageFamilyName,
    contentUri,
    hashHex,
    isLOB = true,
    forceUpdateToAnyVersion,
    forceApplicationShutdown,
    deferRegistration,
  } = params;
  if (!isLOB) {
    // StoreInstall 需 PackageIdentityName + Publisher 而非 ContentURL/Hash，本實作專做 LOB
    throw new Error(
      "buildMsixInstall: isLOB=false (StoreInstall) 未支援；本實作專做 LOB HostedInstall"
    );
  }
  const encodedPfn = encodeURIComponent(packageFamilyName);
  const cspPath =
    `./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/${encodedPfn}/HostedInstall`;

  // HostedInstallAction XML：spec 要求 ContentURI 屬性 + Hash 子元素 + 各種 install option 子元素
  const opts: string[] = [];
  if (forceApplicationShutdown) {
    opts.push("<ForceApplicationShutdown>true</ForceApplicationShutdown>");
  }
  if (forceUpdateToAnyVersion) {
    opts.push("<ForceUpdateToAnyVersion>true</ForceUpdateToAnyVersion>");
  }
  if (deferRegistration) {
    opts.push('<DeferRegistration>1</DeferRegistration>');
  }
  const innerXml =
    "<HostedInstallAction>" +
    `<Source ContentURI="${escapeAttr(contentUri)}" />` +
    `<Hash>${escapeText(hashHex)}</Hash>` +
    opts.join("") +
    "</HostedInstallAction>";

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
