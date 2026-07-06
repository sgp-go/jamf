/**
 * Browser / 網站黑名單 CSP（W4）
 *
 * 走 Internet Explorer Policy CSP 的 SiteToZoneAssignmentList，把 host
 * 派到對應 Security Zone：
 *   1 = Intranet
 *   2 = Trusted Sites
 *   3 = Internet
 *   4 = Restricted Sites（瀏覽器封鎖 / 強制 SmartScreen）
 *
 * ⚠️ 2026-07-03 真機驗證：**IE Zone 4 不封鎖 Edge Chromium 的 URL 訪問**
 * （只影響 IE Mode / ActiveX / cookie 一類「安全區域功能」）。Edge Chromium
 * 走 `HKLM\Software\Policies\Microsoft\Edge\URLBlocklist` 這個獨立 hive，
 * 只認 Chromium URLBlocklist policy。所以真正封 Edge Chromium 靠下半段的
 * `buildEdgeUrlBlocklist`（ADMX-backed），IE Site Zone 4 保留是為了 IE 11 /
 * IE Mode / ActiveX 場景。pushBlockedSitesToDevice 端點會兩層一起派。
 *
 * MS 官方 schema（policy-csp-internetexplorer）：
 *   - LocURI：./Device/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList
 *   - Format：chr / text/plain
 *   - Data id：IZ_ZonemapPrompt
 *   - Value：host1zone1host2zone2...（U+F000 是分隔符）
 */
import type { SyncMLCommand } from "./syncml.ts";

export type SecurityZone = 1 | 2 | 3 | 4;

export interface ZonedSite {
  /** host 或完整 URL（如 "example.com" 或 "https://*.example.com"） */
  host: string;
  /** 1=Intranet / 2=Trusted / 3=Internet / 4=Restricted */
  zone: SecurityZone;
}

export interface BrowserSiteZoneInput {
  /** 站點清單；同一 helper 內可混合不同 zone */
  sites: ZonedSite[];
  /** target 範圍，預設 device（全裝置生效） */
  scope?: "device" | "user";
}

const ZONE_LIST_LOCURI_DEVICE =
  "./Device/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList";
const ZONE_LIST_LOCURI_USER =
  "./User/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList";

const ZONE_SEPARATOR = "";

/**
 * 將多筆 site→zone 對應寫入 IE Site Zone Assignment List。
 *
 * ADMX-backed 政策只接受單一 Replace 命令，data 內以 U+F000 作為分隔符
 * 串接所有 site/zone pair（與 MS docs SyncML 範例一致）。
 *
 * 注意：host 中若含 U+F000 視為非法（會破壞分隔結構），主動拋錯。
 */
export function buildIESiteZoneAssignment(
  input: BrowserSiteZoneInput,
): SyncMLCommand {
  if (!Array.isArray(input.sites) || input.sites.length === 0) {
    throw new Error("buildIESiteZoneAssignment: sites 不可為空");
  }
  for (const s of input.sites) {
    if (!s.host || typeof s.host !== "string") {
      throw new Error(`buildIESiteZoneAssignment: 非法 host ${JSON.stringify(s.host)}`);
    }
    if (s.host.includes(ZONE_SEPARATOR)) {
      throw new Error(
        `buildIESiteZoneAssignment: host 不可含 U+F000 分隔字元 (${s.host})`,
      );
    }
    if (![1, 2, 3, 4].includes(s.zone)) {
      throw new Error(
        `buildIESiteZoneAssignment: 非法 zone ${s.zone}，必須為 1/2/3/4`,
      );
    }
  }

  const pairs: string[] = [];
  for (const s of input.sites) {
    pairs.push(s.host, String(s.zone));
  }
  const value = pairs.join(ZONE_SEPARATOR);

  return {
    cmdId: "0",
    verb: "Replace",
    target: input.scope === "user" ? ZONE_LIST_LOCURI_USER : ZONE_LIST_LOCURI_DEVICE,
    format: "chr",
    type: "text/plain",
    data: `<enabled/><data id="IZ_ZonemapPrompt" value="${escapeAdmxValue(value)}"/>`,
  };
}

/**
 * 便捷 wrapper：將一組 host 全部派到 Restricted Sites（Zone 4），即「封鎖」。
 *
 * 適用最常見的教育場景（管理員只想列封鎖網站，不關心 trusted/intranet）。
 */
export function buildBlockedSites(
  hosts: string[],
  scope: "device" | "user" = "device",
): SyncMLCommand {
  return buildIESiteZoneAssignment({
    sites: hosts.map((host) => ({ host, zone: 4 })),
    scope,
  });
}

/**
 * 清空 IE Site Zone Assignment List（解除全部 device-managed 站點分派）。
 *
 * ADMX-backed disabled 模式：Data 改為 <disabled/>，CSP 視為「政策不啟用」，
 * 由本機原有 Zone Map 接管。
 */
export function buildIESiteZoneClear(
  scope: "device" | "user" = "device",
): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: scope === "user" ? ZONE_LIST_LOCURI_USER : ZONE_LIST_LOCURI_DEVICE,
    format: "chr",
    type: "text/plain",
    data: "<disabled/>",
  };
}

/**
 * ADMX list-encoded value 元素分隔符（U+F000）。
 * 官方 encoding：`key1<F000>value1<F000>key2<F000>value2...`
 */
const ADMX_LIST_SEP = String.fromCharCode(0xF000);

/** ADMX value 屬性內字串需 escape 的字元（&、<、"） */
function escapeAdmxValue(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// Edge Chromium URLBlocklist（ADMX-backed）
// ============================================================
//
// Edge Chromium 只認 `HKLM\Software\Policies\Microsoft\Edge\URLBlocklist`
// 這個獨立 hive 裡的 policy，跟 IE Zone 機制完全獨立。走 ADMX-backed Policy
// CSP：我們自寫一份最小 ADMX（跟 CoGrowLostMode 同一 pattern），`key` 屬性
// 直接指向 Edge 那個 hive，讓 CSP 引擎把 policy value 落到 Edge 認的位置。
//
// Chromium URLBlocklist 語法：
//   - "*://example.com/*"        封整個 example.com 網域
//   - "*://*.example.com/*"      連子網域一起封
//   - 若 host 已含 scheme 或 * 前綴，helper 尊重原樣
//   - 未含則自動包成 "*://<host>/*"

const ADMX_APP = "CoGrowMDM";
const EDGE_ADMX_ID = "EdgePolicy";
const EDGE_POLICY_AREA = `${ADMX_APP}~Policy~CoGrowEdge`;
const EDGE_URL_BLOCKLIST_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${EDGE_POLICY_AREA}/EdgeUrlBlocklist`;
const EDGE_URL_ALLOWLIST_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${EDGE_POLICY_AREA}/EdgeUrlAllowlist`;
const EDGE_BROWSER_SIGNIN_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${EDGE_POLICY_AREA}/EdgeBrowserSignin`;

/**
 * ADMX 定義 URLBlocklist + BrowserSignin 兩條 Edge policy：
 *   - URLBlocklist：list 元素落到 URLBlocklist hive（1, 2, 3... 依序）
 *   - BrowserSignin：decimal 元素落到 Edge hive `BrowserSignin` REG_DWORD
 *     0=disabled / 1=enable / 2=force sign-in
 *
 * key 屬性統一指 Edge Chromium hive，CSP 引擎依此決定 policy value 寫入位置。
 */
const EDGE_ADMX_XML = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="cogrowedge" namespace="CoGrow.MDM.EdgePolicies" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="CoGrowEdge" displayName="CoGrow Edge" />
  </categories>
  <policies>
    <policy name="EdgeUrlBlocklist" class="Machine" displayName="Edge URL Blocklist" explainText="Chromium Edge URLBlocklist" key="Software\\Policies\\Microsoft\\Edge">
      <parentCategory ref="CoGrowEdge" />
      <elements>
        <list id="URLBlocklistDesc" key="Software\\Policies\\Microsoft\\Edge\\URLBlocklist" valuePrefix="" />
      </elements>
    </policy>
    <policy name="EdgeUrlAllowlist" class="Machine" displayName="Edge URL Allowlist" explainText="Chromium Edge URLAllowlist (Kiosk 白名單)" key="Software\\Policies\\Microsoft\\Edge">
      <parentCategory ref="CoGrowEdge" />
      <elements>
        <list id="URLAllowlistDesc" key="Software\\Policies\\Microsoft\\Edge\\URLAllowlist" valuePrefix="" />
      </elements>
    </policy>
    <policy name="EdgeBrowserSignin" class="Machine" displayName="Edge Browser Signin" explainText="Chromium Edge BrowserSignin: 0=Disable / 1=Enable / 2=Force" key="Software\\Policies\\Microsoft\\Edge" valueName="BrowserSignin">
      <parentCategory ref="CoGrowEdge" />
      <elements>
        <decimal id="BrowserSigninValue" valueName="BrowserSignin" minValue="0" maxValue="2" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>`;

/**
 * Edge Chromium ADMX ingest（idempotent Replace，跟 Lost Mode 一致）。
 */
export function buildEdgeAdmxInstall(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${ADMX_APP}/Policy/${EDGE_ADMX_ID}`,
    format: "chr",
    data: EDGE_ADMX_XML,
  };
}

/**
 * host / URL pattern → Chromium URLBlocklist 語法
 *
 * Chromium URL filter format：`[scheme://][.]host[:port][/path][@query]`
 *   - `tiktok.com`           → 匹配 tiktok.com **及所有 subdomain**（含 www.tiktok.com）
 *   - `.tiktok.com`（前綴 .）→ 只 exact host（不含 subdomain）
 *   - `mail.tiktok.com`      → 只該 subdomain 及其下級
 *   - `*`                     → 全部封鎖
 *
 * ⚠️ **陷阱**：`/*` 在此語法裡是 literal path「`/*`」，不是通配任意 path。
 * 把 host 包成 `*://tiktok.com/*` 反而 **不會匹配** `https://www.tiktok.com/`
 * （path 是 `/`）。所以純 host **直接原樣**返回，Chromium 引擎自己處理
 * scheme / port / path 通配（無指定 = match 全部）。
 *
 * 轉譯規則：
 *   - "tiktok.com"           → "tiktok.com"（match host + subdomains）
 *   - "*.tiktok.com"         → "tiktok.com"（Chromium URL filter 語法沒有 *.x 前綴；
 *                                            用 bare host 語意等價）
 *   - ".tiktok.com"          → 原樣（admin 顯式禁用 subdomain 匹配）
 *   - "https://foo.com/bar"  → 原樣（含 scheme / path，admin 自訂 pattern）
 *   - "mail.example.com/x"   → 原樣
 *
 * Ref: https://support.google.com/chrome/a/answer/9942583
 */
export function hostToUrlBlockPattern(host: string): string {
  const trimmed = host.trim();
  if (trimmed.length === 0) throw new Error("hostToUrlBlockPattern: 空 host");
  if (trimmed.startsWith("*.")) return trimmed.slice(2);
  return trimmed;
}

/**
 * 對 Edge Chromium 派下 URLBlocklist policy（單條 ADMX Replace 承載整份清單）。
 *
 * hosts 可混合純 host、`*.foo.com` 子網域、含 scheme URL；helper 統一正規化。
 * 重推 = 覆蓋，不 append。
 */
export function buildEdgeUrlBlocklist(hosts: string[]): SyncMLCommand {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error("buildEdgeUrlBlocklist: hosts 不可為空");
  }
  const pairs: string[] = [];
  hosts.forEach((h, i) => {
    pairs.push(String(i + 1));
    pairs.push(escapeAdmxValue(hostToUrlBlockPattern(h)));
  });
  // ADMX list encoding：`key1<F000>value1<F000>key2<F000>value2`
  const value = pairs.join("");
  return {
    cmdId: "0",
    verb: "Replace",
    target: EDGE_URL_BLOCKLIST_TARGET,
    format: "chr",
    data: `<enabled/><data id="URLBlocklistDesc" value="${value}"/>`,
  };
}

/**
 * 清除 Edge URLBlocklist（送 <disabled/> 使 policy 不啟用）。
 */
export function buildEdgeUrlBlocklistClear(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: EDGE_URL_BLOCKLIST_TARGET,
    format: "chr",
    data: "<disabled/>",
  };
}

/**
 * 對 Edge Chromium 派下 URLAllowlist policy（白名單，Kiosk 專用）。
 *
 * **語義**：一旦 URLAllowlist 有值，**只有**名單內的 URL 才准訪問，
 * 其他一律 blocked（比 URLBlocklist 更嚴，適合考試場景）。
 * URLAllowlist 也 override URLBlocklist：白名單 + 黑名單同時存在時，
 * 白名單優先允許，其他被 block。
 *
 * urls 語法同 Chromium URLBlocklist（見 hostToUrlBlockPattern 註解）：
 * bare host 匹配 host + subdomains，帶 scheme/path 則原樣。
 *
 * 重推 = 覆蓋，不 append。
 */
export function buildEdgeUrlAllowlist(urls: string[]): SyncMLCommand {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("buildEdgeUrlAllowlist: urls 不可為空");
  }
  const pairs: string[] = [];
  urls.forEach((u, i) => {
    pairs.push(String(i + 1));
    pairs.push(escapeAdmxValue(hostToUrlBlockPattern(u)));
  });
  // ADMX list encoding：U+F000 作為 key/value 及元素之間的分隔（同 URLBlocklist）
  const value = pairs.join("");
  return {
    cmdId: "0",
    verb: "Replace",
    target: EDGE_URL_ALLOWLIST_TARGET,
    format: "chr",
    data: `<enabled/><data id="URLAllowlistDesc" value="${value}"/>`,
  };
}

/**
 * 清除 Edge URLAllowlist（送 <disabled/> 讓政策不生效 → 恢復無白名單）。
 */
export function buildEdgeUrlAllowlistClear(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: EDGE_URL_ALLOWLIST_TARGET,
    format: "chr",
    data: "<disabled/>",
  };
}

/**
 * Edge BrowserSignin policy：控制 Edge 內帳號登入行為。
 *
 * 教育場景關鍵配套：**推 0 (Disable)** 禁止學生登入任何 MS 帳號到 Edge profile。
 * 原因：URLBlocklist 對 MS 個人帳號登入的 profile 免疫（MS 官方 by design），
 * 若學生登了 outlook/hotmail 帳號，URLBlocklist 直接被忽略。BrowserSignin=0
 * 從源頭防止此繞過。
 *
 * @param mode 0=Disable（禁止登入，推薦教育場景）/ 1=Enable（預設）/ 2=Force（強制登入）
 */
export function buildEdgeBrowserSignin(mode: 0 | 1 | 2): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: EDGE_BROWSER_SIGNIN_TARGET,
    format: "chr",
    data: `<enabled/><data id="BrowserSigninValue" value="${mode}"/>`,
  };
}

/**
 * 清除 Edge BrowserSignin policy（回退為預設行為 Enable=1）。
 */
export function buildEdgeBrowserSigninClear(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: EDGE_BROWSER_SIGNIN_TARGET,
    format: "chr",
    data: "<disabled/>",
  };
}
