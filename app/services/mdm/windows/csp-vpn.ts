/**
 * VPNv2 CSP — VPN Profile 派發（PRD §5.2 Phase 2）
 *
 * LocURI：./Vendor/MSFT/VPNv2/{ProfileName}/ProfileXML
 * Verb：Add（同名 profile 再 Add 會覆蓋）
 * Format：chr（內含完整 VPNProfile XML，由 syncml.ts 二次 escape）
 *
 * MVP 支援 Windows 原生兩種協議：
 *   - IKEv2：現代、推薦；無需預共享密鑰，使用者首次連線時輸入帳號密碼
 *   - L2TP/IPsec PSK：兼容老舊 VPN concentrator；需在 profile 中預埋 PSK
 *
 * 不實作：
 *   - SSTP / PPTP（PPTP 已棄用）
 *   - 證書認證（EAP-TLS）：需要先派發證書，超出 MVP 範圍
 *   - PEAP / EAP-MSCHAPv2 自訂：UserMethod=MSChapv2 預設即可
 *   - Plugin profile（第三方 VPN client）
 *
 * 安全要點：
 *   - 不在 profile 中預填使用者帳號密碼（VPNv2 schema 不支援，要學生自己填）
 *   - L2TP PSK 會明文寫在 ProfileXML 中（OS 設備端會加密儲存）
 *   - 使用 RememberCredentials=true 讓設備記住 VPN 帳密（學校場景）
 *
 * MS docs schema 參考：vpnv2-profile-xsd
 */
import type { SyncMLCommand } from "./syncml.ts";

export type VpnProtocol = "IKEv2" | "L2TP";

/** SplitTunnel = 只指定流量走 VPN；ForceTunnel = 全部流量走 VPN */
export type VpnRoutingPolicy = "SplitTunnel" | "ForceTunnel";

export interface VpnProfileInput {
  /**
   * Profile 名稱（顯示於設備 VPN 設定畫面）。
   * 不可含 `/`（會破壞 LocURI 結構）；其餘 URL 安全字元會被 encode。
   */
  profileName: string;
  /** VPN 伺服器位址（FQDN 或 IP） */
  serverHost: string;
  protocol: VpnProtocol;
  /** L2TP 預共享密鑰。protocol=L2TP 時必填、protocol=IKEv2 時忽略 */
  l2tpPsk?: string;
  /** 允許設備記住使用者帳號密碼。預設 true */
  rememberCredentials?: boolean;
  /** Always-on：螢幕解鎖即自動連線。預設 false（學校場景通常按需連） */
  alwaysOn?: boolean;
  /** DNS 後綴（如 school.edu.tw），可選 */
  dnsSuffix?: string;
  /** SplitTunnel = 預設；ForceTunnel = 強制全流量走 VPN */
  routingPolicy?: VpnRoutingPolicy;
  /**
   * 信任網路 DNS 後綴清單（如校園 WiFi 域）。
   * 設備在這些網路上時不會嘗試自動連線 VPN（避免內網場景無用握手）
   */
  trustedNetworkDetection?: string[];
}

export function buildVpnProfile(input: VpnProfileInput): SyncMLCommand {
  if (!input.profileName || input.profileName.includes("/")) {
    throw new Error(
      `buildVpnProfile: profileName 不可為空且不可含 "/"（${input.profileName}）`,
    );
  }
  if (!input.serverHost) {
    throw new Error("buildVpnProfile: serverHost 為必填");
  }
  if (input.protocol === "L2TP" && !input.l2tpPsk) {
    throw new Error("buildVpnProfile: protocol=L2TP 時 l2tpPsk 為必填");
  }
  return {
    cmdId: "0",
    verb: "Add",
    target: `./Vendor/MSFT/VPNv2/${encodeURIComponent(input.profileName)}/ProfileXML`,
    format: "chr",
    data: buildVpnProfileXml(input),
  };
}

export function buildVpnRemove(profileName: string): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Delete",
    target: `./Vendor/MSFT/VPNv2/${encodeURIComponent(profileName)}`,
  };
}

function buildVpnProfileXml(input: VpnProfileInput): string {
  const remember = (input.rememberCredentials ?? true) ? "true" : "false";
  const alwaysOn = input.alwaysOn ? "true" : "false";
  const routing = input.routingPolicy ?? "SplitTunnel";

  const dnsSuffixXml = input.dnsSuffix
    ? `<DnsSuffix>${escapeText(input.dnsSuffix)}</DnsSuffix>`
    : "";

  const trustedXml = (input.trustedNetworkDetection ?? [])
    .map((d) => `<TrustedNetworkDetection>${escapeText(d)}</TrustedNetworkDetection>`)
    .join("");

  const pskXml = input.protocol === "L2TP" && input.l2tpPsk
    ? `<L2tpPsk>${escapeText(input.l2tpPsk)}</L2tpPsk>`
    : "";

  // Win10+ VPNv2 IKEv2 不再接受直接 <UserMethod>MSChapv2</UserMethod>，必須 EAP wrapper
  // (Win11 24H2 真機 ACK 500 驗證,2026-06-29)
  // L2TP 仍接受 <UserMethod>MSChapv2</UserMethod>（簡單模式）
  const authXml = input.protocol === "IKEv2"
    ? buildEapMschapv2AuthXml()
    : `<Authentication><UserMethod>MSChapv2</UserMethod></Authentication>`;

  return (
    `<VPNProfile>` +
    `<RememberCredentials>${remember}</RememberCredentials>` +
    `<AlwaysOn>${alwaysOn}</AlwaysOn>` +
    dnsSuffixXml +
    trustedXml +
    `<NativeProfile>` +
    `<Servers>${escapeText(input.serverHost)}</Servers>` +
    `<NativeProtocolType>${input.protocol}</NativeProtocolType>` +
    pskXml +
    authXml +
    `<RoutingPolicyType>${routing}</RoutingPolicyType>` +
    `</NativeProfile>` +
    `</VPNProfile>`
  );
}

/**
 * IKEv2 必需的 EAP-MSCHAPv2 wrapper。
 *
 * EAP Type=26 = MSCHAPv2（MS docs：eaphostconfig-mschapv2）。
 * 這個 XML 是固定模板,不接受外部變數注入；使用者帳密由 OS 在連線時詢問。
 *
 * MS docs 參考：https://learn.microsoft.com/en-us/windows/security/identity-protection/vpn/vpn-authentication
 */
function buildEapMschapv2AuthXml(): string {
  return (
    `<Authentication>` +
    `<UserMethod>Eap</UserMethod>` +
    `<Eap>` +
    `<Configuration>` +
    `<EapHostConfig xmlns="http://www.microsoft.com/provisioning/EapHostConfig">` +
    `<EapMethod>` +
    `<Type xmlns="http://www.microsoft.com/provisioning/EapCommon">26</Type>` +
    `<VendorId xmlns="http://www.microsoft.com/provisioning/EapCommon">0</VendorId>` +
    `<VendorType xmlns="http://www.microsoft.com/provisioning/EapCommon">0</VendorType>` +
    `<AuthorId xmlns="http://www.microsoft.com/provisioning/EapCommon">0</AuthorId>` +
    `</EapMethod>` +
    `<Config xmlns="http://www.microsoft.com/provisioning/EapHostConfig">` +
    `<Eap xmlns="http://www.microsoft.com/provisioning/BaseEapConnectionPropertiesV1">` +
    `<Type>26</Type>` +
    `<EapType xmlns="http://www.microsoft.com/provisioning/MsChapV2ConnectionPropertiesV1">` +
    `<UseWinLogonCredentials>false</UseWinLogonCredentials>` +
    `</EapType>` +
    `</Eap>` +
    `</Config>` +
    `</EapHostConfig>` +
    `</Configuration>` +
    `</Eap>` +
    `</Authentication>`
  );
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
