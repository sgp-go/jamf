/**
 * MS-MDE2 Discovery.svc
 *
 * 設備發送 Discover SOAP 請求，伺服器回應 EnrollmentVersion / Policy URL / Enrollment URL。
 *
 * 端點通常為 `https://EnterpriseEnrollment.<domain>/EnrollmentServer/Discovery.svc`，
 * 但本案走 .ppkg / 手動 enrollment 硬編碼 URL，子域名非必需。
 *
 * 規範：MS-MDE2 §3.1.5.1
 */

const DISCOVERY_NS = "http://schemas.microsoft.com/windows/management/2012/01/enrollment";
const ACTION_RESPONSE = `${DISCOVERY_NS}/IDiscoveryService/DiscoverResponse`;

/** Discover 請求中可解析的欄位（用作審計，不影響回應內容） */
export interface DiscoverRequest {
  emailAddress?: string;
  requestVersion?: string;
  deviceType?: string;
  applicationVersion?: string;
  osEdition?: string;
  authPolicies: string[];
  /** SOAP <a:MessageID> 用於回應 RelatesTo */
  messageId?: string;
}

/** Discover 回應參數 */
export interface DiscoverResponseConfig {
  /** 客戶端訊息的 MessageID（會被回填為 RelatesTo） */
  requestMessageId: string;
  /** 後端 base URL，例：https://mdm.example.com */
  baseUrl: string;
  /** 認證策略，本案用 OnPremise（用戶名密碼） */
  authPolicy?: "OnPremise" | "Federated";
}

/**
 * 解析 Discover 請求 SOAP
 * 不嚴格驗證 SOAP envelope，只摘出有用欄位。
 */
export function parseDiscoverRequest(soapXml: string): DiscoverRequest {
  return {
    emailAddress: extractTag(soapXml, "EmailAddress"),
    requestVersion: extractTag(soapXml, "RequestVersion"),
    deviceType: extractTag(soapXml, "DeviceType"),
    applicationVersion: extractTag(soapXml, "ApplicationVersion"),
    osEdition: extractTag(soapXml, "OSEdition"),
    authPolicies: extractAllTags(soapXml, "AuthPolicy"),
    messageId: extractTag(soapXml, "a:MessageID") ?? extractTag(soapXml, "MessageID"),
  };
}

/**
 * 構建 Discover 回應 SOAP envelope
 *
 * 設備收到後會用 EnrollmentPolicyServiceUrl 呼叫 Policy.svc。
 */
export function buildDiscoverResponse(config: DiscoverResponseConfig): string {
  const { requestMessageId, baseUrl, authPolicy = "OnPremise" } = config;
  const responseId = `urn:uuid:${crypto.randomUUID()}`;
  const policyUrl = `${baseUrl}/EnrollmentServer/Policy.svc`;
  const enrollmentUrl = `${baseUrl}/EnrollmentServer/Enrollment.svc`;

  // 重點：DiscoverResult 的子欄位必須宣告於 PKI namespace
  // （MS-MDE2 §3.1.5.1.4 sample 的精確要求；Win 10 ENROLLClient 嚴格依此解析）
  const PKI_NS = "http://schemas.microsoft.com/windows/pki/2009/01/enrollment";
  // 嚴格對齊 MS-MDE2 §3.1.5.1.4 sample header：只含 Action / ActivityId / RelatesTo，
  // 不加 a:MessageID / a:To（多餘字段可能讓嚴格 client 拒絕響應）
  // 對齊 Microsoft Intune 真實服務器（curl https://enrollment.manage.microsoft.com 抓回的樣本）：
  //   - DiscoverResult 子元素**繼承父 enrollment namespace**，不在 PKI namespace 下單獨宣告
  //   - 順序：AuthPolicy → EnrollmentPolicyServiceUrl → EnrollmentServiceUrl → AuthenticationServiceUrl → EnrollmentVersion
  //   - ActivityId 帶 CorrelationId 屬性 + xmlns
  //   - 此格式與 spec sample 不同；以真實 Intune 為準
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
  <s:Header>
    <a:Action s:mustUnderstand="1">${ACTION_RESPONSE}</a:Action>
    <ActivityId CorrelationId="${responseId}" xmlns="http://schemas.microsoft.com/2004/09/ServiceModel/Diagnostics">${responseId}</ActivityId>
    <a:RelatesTo>${escapeXml(requestMessageId)}</a:RelatesTo>
  </s:Header>
  <s:Body>
    <DiscoverResponse xmlns="${DISCOVERY_NS}">
      <DiscoverResult>
        <AuthPolicy>${authPolicy}</AuthPolicy>
        <EnrollmentPolicyServiceUrl>${escapeXml(policyUrl)}</EnrollmentPolicyServiceUrl>
        <EnrollmentServiceUrl>${escapeXml(enrollmentUrl)}</EnrollmentServiceUrl>
        <EnrollmentVersion>4.0</EnrollmentVersion>
      </DiscoverResult>
    </DiscoverResponse>
  </s:Body>
</s:Envelope>`;
}

/**
 * Discovery.svc 的 GET 探活回應（多數 client 不會打 GET，但 health-check 有時會）
 */
export const DISCOVERY_GET_OK_BODY =
  "Microsoft Mobile Device Management Discovery Service";

// ---------- 內部 XML 工具（與 syncml.ts 共用模式但獨立避免循環依賴） ----------

function extractTag(xml: string, tag: string): string | undefined {
  // 容忍命名空間前綴（如 a:MessageID）
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${escaped}>`);
  const m = xml.match(re);
  return m ? unescapeXml(m[1].trim()) : undefined;
}

function extractAllTags(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${escaped}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(unescapeXml(m[1].trim()));
  }
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
