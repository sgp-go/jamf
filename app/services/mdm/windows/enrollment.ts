/**
 * MS-MDE2 Enrollment.svc（WS-Trust 1.3 RST/wstep）
 *
 * 設備在拿到 Policy 後，產生 PKCS#10 CSR + 帶上 HardwareID 等 ContextItem，
 * 發送 RequestSecurityToken 到 Enrollment.svc。
 *
 * 後端：
 *   1. 解析 BinarySecurityToken（base64 PKCS#10 CSR）
 *   2. 抽 ContextItem 中的 DeviceID / HWDevID 等
 *   3. 用 CA 簽發裝置證書
 *   4. 產生 wap-provisioningdoc → base64 → 回傳
 *
 * 規範：[MS-MDE2] §3.1.5.1.5（RST）+ §3.1.5.1.6（RSTR）
 */

import forge from "node-forge";
import { type CaKeyPair, getCaRootDer, signWindowsDeviceCsr } from "../crypto.ts";
import { buildWapProvisioningDoc } from "./provisioning.ts";

const ENROLL_NS = "http://schemas.microsoft.com/windows/pki/2009/01/enrollment";
const RST_RESPONSE_NS = "http://docs.oasis-open.org/ws-sx/ws-trust/200512";
const ACTION_RESPONSE = `${ENROLL_NS}/RSTRC/wstep`;
const TOKEN_TYPE_PROV_DOC =
  "http://schemas.microsoft.com/5.0.0.0/ConfigurationManager/Enrollment/DeviceEnrollmentProvisionDoc";

/** Enrollment 請求中可解析的欄位 */
export interface EnrollmentRequest {
  /** SOAP MessageID（用於回應 RelatesTo） */
  messageId?: string;
  /** PKCS#10 CSR PEM（已從 BinarySecurityToken base64 還原並包成 PEM） */
  csrPem: string;
  /** 設備自報的 ContextItem 欄位（DeviceType / HWDevID / DeviceID 等） */
  context: Record<string, string>;
}

/**
 * 解析設備發來的 RST SOAP 訊息，回傳 CSR + Context 摘要
 */
export function parseEnrollmentRequest(soapXml: string): EnrollmentRequest {
  const messageId = extractTag(soapXml, "MessageID");
  const csrBase64 = extractBinarySecurityToken(soapXml);
  if (!csrBase64) {
    throw new Error("Enrollment 請求缺少 BinarySecurityToken（CSR）");
  }
  const csrPem = base64DerToPem(csrBase64, "CERTIFICATE REQUEST");
  const context = extractContextItems(soapXml);
  return { messageId, csrPem, context };
}

/** Enrollment 回應參數 */
export interface EnrollmentResponseConfig {
  /** 客戶端 SOAP MessageID（會被回填為 RelatesTo） */
  requestMessageId: string;
  /** Windows DeviceID（從 ContextItem.DeviceID 來，或自行生成 GUID） */
  deviceId: string;
  /** 後端管理通道 URL，例：https://mdm.example.com/api/mdm/win/manage/<deviceId> */
  managementUrl: string;
  /** 設備發來的 CSR PEM */
  csrPem: string;
  /** WNS Package Family Name（可選） */
  wnsPfn?: string;
  /** 提供商 ID，預設 "Aspira MDM" */
  providerId?: string;
  /**
   * per-tenant CA（多租戶：從 self_mdm_config.caCertPem/caKeyPemEnc 載入）。
   * 不傳則 fallback 到 crypto.ts 的檔案系統 CA（src/ 單租戶相容）。
   */
  ca?: CaKeyPair;
}

/** Enrollment 回應結果（同時回傳簽出的設備證書供入庫） */
export interface EnrollmentResult {
  /** 完整 SOAP envelope 字串 */
  soapResponse: string;
  /** 簽發的設備證書 PEM（供 mdm_certificates 表存檔） */
  deviceCertPem: string;
}

/**
 * 構建 RequestSecurityTokenResponse SOAP envelope
 *
 * 流程：CSR → CA 簽發 → wap-provisioningdoc → base64 → 包進 BinarySecurityToken
 */
export function buildEnrollmentResponse(
  config: EnrollmentResponseConfig
): EnrollmentResult {
  const {
    requestMessageId,
    deviceId,
    managementUrl,
    csrPem,
    wnsPfn,
    providerId,
    ca,
  } = config;

  // 1. 用 CA 簽發裝置證書
  const deviceCertPem = signWindowsDeviceCsr(csrPem, deviceId, ca);

  // 2. 取 CA 根 PEM（給 provisioning doc 嵌入信任）
  const caCertPem = forge.pki.certificateToPem(
    forge.pki.certificateFromAsn1(
      forge.asn1.fromDer(
        String.fromCharCode(...getCaRootDer(ca))
      ) as forge.asn1.Asn1
    )
  );

  // 3. 構建 wap-provisioningdoc
  const provDocXml = buildWapProvisioningDoc({
    caCertPem,
    deviceCertPem,
    deviceId,
    managementUrl,
    wnsPfn,
    providerId,
  });

  // 4. UTF-8 編碼 → base64
  const provDocBase64 = btoa(unescape(encodeURIComponent(provDocXml)));

  const responseId = `urn:uuid:${crypto.randomUUID()}`;
  const soapResponse = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
  <s:Header>
    <a:Action s:mustUnderstand="1">${ACTION_RESPONSE}</a:Action>
    <a:RelatesTo>${escapeXml(requestMessageId)}</a:RelatesTo>
    <ActivityId xmlns="http://schemas.microsoft.com/2004/09/ServiceModel/Diagnostics">${responseId}</ActivityId>
  </s:Header>
  <s:Body>
    <RequestSecurityTokenResponseCollection xmlns="${RST_RESPONSE_NS}">
      <RequestSecurityTokenResponse>
        <TokenType>${TOKEN_TYPE_PROV_DOC}</TokenType>
        <DispositionMessage xmlns="${ENROLL_NS}">Provisioned</DispositionMessage>
        <RequestedSecurityToken>
          <BinarySecurityToken
            ValueType="${TOKEN_TYPE_PROV_DOC}"
            EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#base64binary"
            xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">${provDocBase64}</BinarySecurityToken>
        </RequestedSecurityToken>
        <RequestID xmlns="${ENROLL_NS}">0</RequestID>
      </RequestSecurityTokenResponse>
    </RequestSecurityTokenResponseCollection>
  </s:Body>
</s:Envelope>`;

  return { soapResponse, deviceCertPem };
}

// ---------- 內部工具 ----------

function extractTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`
  );
  const m = xml.match(re);
  return m ? m[1].trim() : undefined;
}

/** 抓 BinarySecurityToken 的 base64 內容（去掉 XML 換行/縮排）
 *  Win10 ENROLLClient 在 Header 也放一個空的 wsse:BinarySecurityToken（DeviceEnrollmentUserToken 類型），
 *  真實 CSR 在 Body 中，ValueType 含 PKCS10。優先取含 PKCS10 的那個，否則取第一個非空。 */
function extractBinarySecurityToken(xml: string): string | undefined {
  const re = /<(?:[a-zA-Z0-9]+:)?BinarySecurityToken([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?BinarySecurityToken>/g;
  const candidates: { attrs: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    candidates.push({ attrs: m[1], body: m[2].replace(/\s+/g, "") });
  }
  // 優先取 PKCS10
  const pkcs10 = candidates.find((c) => /PKCS10/i.test(c.attrs) && c.body);
  if (pkcs10) return pkcs10.body;
  // 否則取第一個 non-empty
  return candidates.find((c) => c.body)?.body;
}

/** 抓所有 ContextItem 名值對 */
function extractContextItems(xml: string): Record<string, string> {
  const re = /<ContextItem\s+Name="([^"]+)">\s*<Value>([\s\S]*?)<\/Value>\s*<\/ContextItem>/g;
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** 把 base64 DER 包成 PEM 字串 */
function base64DerToPem(b64: string, label: string): string {
  // 去白空格 + 每 64 字元換行
  const cleaned = b64.replace(/\s+/g, "");
  const lines = cleaned.match(/.{1,64}/g) ?? [cleaned];
  return [
    `-----BEGIN ${label}-----`,
    ...lines,
    `-----END ${label}-----`,
    "",
  ].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
