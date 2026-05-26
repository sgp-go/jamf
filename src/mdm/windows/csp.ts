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
