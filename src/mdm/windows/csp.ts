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
  /** 是否信任設備上未由 Microsoft Store 派送的 LOB 應用（自家 MSIX 必須 true） */
  isLOB?: boolean;
}

/**
 * 建立 MSIX 安裝命令
 *
 * 使用 ./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/<PFN>/StoreInstall。
 * Data 是 JSON-shaped 設定字串。
 */
export function buildMsixInstall(params: MsixInstallParams): SyncMLCommand {
  const { packageFamilyName, contentUri, hashHex, isLOB = true } = params;
  // CSP 規範要求 PFN 在路徑中經 URI-encode（保留 _ 與字母數字，特殊字元編碼）
  const encodedPfn = encodeURIComponent(packageFamilyName);
  const cspPath =
    `./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/${encodedPfn}/StoreInstall`;

  // EnterpriseModernAppManagement StoreInstall 的 Data 是 XML 配置字串
  const innerXml = [
    "<Application",
    ' Verb="install"',
    isLOB ? ' LOB="true"' : "",
    ` ContentURL="${escapeAttr(contentUri)}"`,
    " />",
    `<Hash>${escapeText(hashHex)}</Hash>`,
  ]
    .filter(Boolean)
    .join("");

  return {
    cmdId: "0",
    verb: "Exec",
    target: cspPath,
    format: "chr",
    data: innerXml,
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
