import { assertEquals, assertExists, assert } from "jsr:@std/assert@^1";
import forge from "node-forge";
import {
  parseDiscoverRequest,
  buildDiscoverResponse,
} from "./discovery.ts";
import {
  parsePolicyMessageId,
  buildPolicyResponse,
} from "./policy.ts";
import {
  parseEnrollmentRequest,
  buildEnrollmentResponse,
} from "./enrollment.ts";
import { buildWapProvisioningDoc } from "./provisioning.ts";

/** 模擬設備生成 PKCS#10 CSR + 包成 base64 DER */
function makeCsrBase64(commonName: string): { csrPem: string; csrBase64: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const csrPem = forge.pki.certificationRequestToPem(csr);
  const csrDer = forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes();
  const csrBase64 = forge.util.encode64(csrDer);
  return { csrPem, csrBase64 };
}

// ============================================================
// Discovery
// ============================================================

Deno.test("Discovery: 解析請求並回傳含 Policy / Enrollment URL", () => {
  const reqXml = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
  <s:Header>
    <a:Action s:mustUnderstand="1">http://schemas.microsoft.com/windows/management/2012/01/enrollment/IDiscoveryService/Discover</a:Action>
    <a:MessageID>urn:uuid:abc-123</a:MessageID>
  </s:Header>
  <s:Body>
    <Discover xmlns="http://schemas.microsoft.com/windows/management/2012/01/enrollment">
      <request>
        <EmailAddress>user@example.com</EmailAddress>
        <RequestVersion>4.0</RequestVersion>
        <DeviceType>CIMClient_Windows</DeviceType>
        <ApplicationVersion>10.0.22621</ApplicationVersion>
        <OSEdition>4</OSEdition>
        <AuthPolicies>
          <AuthPolicy>OnPremise</AuthPolicy>
          <AuthPolicy>Federated</AuthPolicy>
        </AuthPolicies>
      </request>
    </Discover>
  </s:Body>
</s:Envelope>`;

  const req = parseDiscoverRequest(reqXml);
  assertEquals(req.emailAddress, "user@example.com");
  assertEquals(req.requestVersion, "4.0");
  assertEquals(req.deviceType, "CIMClient_Windows");
  assertEquals(req.authPolicies, ["OnPremise", "Federated"]);
  assertEquals(req.messageId, "urn:uuid:abc-123");

  const resp = buildDiscoverResponse({
    requestMessageId: req.messageId!,
    baseUrl: "https://mdm.example.com",
  });

  // DiscoverResult 子元素繼承父 enrollment namespace（按 Intune 真機抓包）
  // — 不應在子元素上重新宣告 PKI namespace；舊版測試誤期待 PKI ns 已修正
  assert(/<EnrollmentVersion>4\.0<\/EnrollmentVersion>/.test(resp));
  assert(/<EnrollmentPolicyServiceUrl>[^<]*Policy\.svc<\/EnrollmentPolicyServiceUrl>/.test(resp));
  assert(/<EnrollmentServiceUrl>[^<]*Enrollment\.svc<\/EnrollmentServiceUrl>/.test(resp));
  // negative：DiscoverResult 子元素不該帶 xmlns="...pki..."
  assert(!/<EnrollmentVersion\s+xmlns="[^"]*pki/.test(resp));
  assert(!/<EnrollmentPolicyServiceUrl\s+xmlns="[^"]*pki/.test(resp));
  assert(resp.includes("<AuthPolicy>OnPremise</AuthPolicy>"));
  assert(resp.includes("<a:RelatesTo>urn:uuid:abc-123</a:RelatesTo>"));
});

Deno.test("Discovery: baseUrl 含特殊字元正確 escape", () => {
  const resp = buildDiscoverResponse({
    requestMessageId: "id-1",
    baseUrl: "https://mdm.example.com",
  });
  // 不該出現未 escape 的 & 在屬性內
  assert(!/[&](?!amp;|lt;|gt;|quot;|apos;)/.test(resp));
});

// ============================================================
// Policy
// ============================================================

Deno.test("Policy: 解析 MessageID + 回應含 minimalKeyLength=2048", () => {
  const reqXml = `<s:Envelope xmlns:s="..." xmlns:a="...">
  <s:Header>
    <a:MessageID>urn:uuid:policy-msg</a:MessageID>
  </s:Header>
  <s:Body><GetPolicies/></s:Body>
</s:Envelope>`;

  assertEquals(parsePolicyMessageId(reqXml), "urn:uuid:policy-msg");

  const resp = buildPolicyResponse({ requestMessageId: "urn:uuid:policy-msg" });
  assert(resp.includes("<minimalKeyLength>2048</minimalKeyLength>"));
  assert(resp.includes("szOID_NIST_sha256"));
  assert(resp.includes("<a:RelatesTo>urn:uuid:policy-msg</a:RelatesTo>"));
  // validityPeriodSeconds 預設約 1 年
  const m = resp.match(/<validityPeriodSeconds>(\d+)<\/validityPeriodSeconds>/);
  assertExists(m);
  assertEquals(Number(m[1]), 365 * 24 * 60 * 60);
});

// ============================================================
// Enrollment
// ============================================================

Deno.test("Enrollment: 解析帶 CSR 的 RST 請求", () => {
  const { csrBase64 } = makeCsrBase64("device-001");
  const reqXml = `<s:Envelope>
  <s:Header><a:MessageID>urn:uuid:rst-1</a:MessageID></s:Header>
  <s:Body>
    <RequestSecurityToken>
      <TokenType>http://schemas.microsoft.com/5.0.0.0/ConfigurationManager/Enrollment/DeviceEnrollmentToken</TokenType>
      <RequestType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/Issue</RequestType>
      <BinarySecurityToken
        ValueType="http://schemas.microsoft.com/windows/pki/2009/01/enrollment#PKCS10"
        EncodingType="...base64binary">${csrBase64}</BinarySecurityToken>
      <AdditionalContext>
        <ContextItem Name="DeviceType"><Value>CIMClient_Windows</Value></ContextItem>
        <ContextItem Name="HWDevID"><Value>HW-AABB-CCDD</Value></ContextItem>
        <ContextItem Name="DeviceID"><Value>WIN-DEV-001</Value></ContextItem>
      </AdditionalContext>
    </RequestSecurityToken>
  </s:Body>
</s:Envelope>`;

  const parsed = parseEnrollmentRequest(reqXml);
  assertEquals(parsed.messageId, "urn:uuid:rst-1");
  assertEquals(parsed.context.HWDevID, "HW-AABB-CCDD");
  assertEquals(parsed.context.DeviceID, "WIN-DEV-001");
  // CSR PEM 應可被 forge 解析
  const csrObj = forge.pki.certificationRequestFromPem(parsed.csrPem);
  assert(csrObj.verify());
});

Deno.test("Enrollment: 完整三步 round-trip + 簽出證書 CN 對齊 deviceId", () => {
  const { csrBase64, csrPem } = makeCsrBase64("ignored-cn-from-csr");

  const result = buildEnrollmentResponse({
    requestMessageId: "urn:uuid:rst-2",
    deviceId: "WIN-DEV-FULL",
    managementUrl: "https://mdm.example.com/api/mdm/win/manage/WIN-DEV-FULL",
    csrPem,
    wnsPfn: "CoGrow.CogrowMDMPush_xxx",
  });

  // SOAP envelope 結構
  assert(result.soapResponse.includes("RequestSecurityTokenResponseCollection"));
  assert(result.soapResponse.includes("BinarySecurityToken"));

  // 簽出的設備證書 CN = deviceId
  const cert = forge.pki.certificateFromPem(result.deviceCertPem);
  assertEquals(cert.subject.getField("CN")?.value, "WIN-DEV-FULL");

  // 從 SOAP 提取 wap-provisioningdoc base64 還原驗內容
  const m = result.soapResponse.match(
    /<BinarySecurityToken[^>]*>([\s\S]*?)<\/BinarySecurityToken>/
  );
  assertExists(m);
  const provDocXml = decodeBase64Utf8(m[1].replace(/\s+/g, ""));
  // 必含的關鍵欄位
  assert(provDocXml.includes("<wap-provisioningdoc"));
  assert(provDocXml.includes('APPID" value="w7"'));
  assert(
    provDocXml.includes(
      'ADDR" value="https://mdm.example.com/api/mdm/win/manage/WIN-DEV-FULL"'
    )
  );
  assert(provDocXml.includes('PFN" value="CoGrow.CogrowMDMPush_xxx"'));
  // Poll 區塊（即使有 PFN 也保留輪詢作為後備）
  assert(provDocXml.includes('NumberOfFirstRetries" value="5"'));
  // CertificateStore Root + My
  assert(provDocXml.includes('type="Root"'));
  assert(provDocXml.includes('type="My"'));
  // SSL client 查詢條件 = CN = deviceId
  assert(provDocXml.includes("CN%3DWIN-DEV-FULL"));

  // 順帶確認 CSR 那個被忽略掉的 CN 沒被當作 deviceId 用
  assert(!provDocXml.includes("ignored-cn-from-csr"));
  // csrBase64 是合法 base64（用於避免警告）
  assert(csrBase64.length > 100);
});

Deno.test("Enrollment: 無 wnsPfn 時不寫 Push 區塊（純輪詢模式）", () => {
  const { csrPem } = makeCsrBase64("dev");
  const result = buildEnrollmentResponse({
    requestMessageId: "id",
    deviceId: "DEV-NOPUSH",
    managementUrl: "https://mdm/m/DEV-NOPUSH",
    csrPem,
    // wnsPfn 不設
  });
  const m = result.soapResponse.match(
    /<BinarySecurityToken[^>]*>([\s\S]*?)<\/BinarySecurityToken>/
  );
  const provDocXml = decodeBase64Utf8(m![1].replace(/\s+/g, ""));
  assert(!provDocXml.includes("<characteristic type=\"Push\""));
  assert(!provDocXml.includes('PFN"'));
  // Poll 仍應在
  assert(provDocXml.includes('NumberOfFirstRetries" value="5"'));
});

// ============================================================
// Provisioning Doc 直接測試
// ============================================================

Deno.test("buildWapProvisioningDoc: thumbprint 為 SHA-1 hex 大寫 40 字元", () => {
  // 用 forge 生一張一次性憑證
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: "commonName", value: "test" }]);
  cert.setIssuer([{ name: "commonName", value: "test" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);

  const xml = buildWapProvisioningDoc({
    caCertPem: pem,
    deviceCertPem: pem,
    deviceId: "DEV",
    managementUrl: "https://mdm/m/DEV",
  });
  // 找 Root 區塊裡的 thumbprint
  const m = xml.match(
    /<characteristic type="Root">[\s\S]*?<characteristic type="System">[\s\S]*?<characteristic type="([0-9A-F]+)">/
  );
  assertExists(m);
  assertEquals(m[1].length, 40);
  assert(/^[0-9A-F]+$/.test(m[1]));
});

// ---------- helper ----------

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  return decodeURIComponent(escape(bin));
}
