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
 * Microsoft Edge Chromium 仍尊重 IE Security Zones，因此 Zone=4 對 Edge
 * 仍會封鎖（透過 Windows Security Zones 機制），不需要 ADMX ingestion 即
 * 可達成「網站黑名單」教育場景需求。
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

/** ADMX value 屬性內字串需 escape 的字元（&、<、"） */
function escapeAdmxValue(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}
