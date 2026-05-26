/**
 * MS-MDE2 Policy.svc（GetPolicies）
 *
 * 設備拿到 Discover 回應後，用 Basic Auth 或 BinarySecurityToken 呼叫 Policy.svc，
 * 詢問憑證模板（金鑰長度、雜湊演算法、有效期）。
 *
 * 規範：[MS-XCEP] §3.1.4.1（Enrollment Policy Service）
 */

const POLICY_NS = "http://schemas.microsoft.com/windows/pki/2009/01/enrollmentpolicy";

/** Policy 回應參數 */
export interface PolicyResponseConfig {
  /** 客戶端 SOAP MessageID，會被回填為 RelatesTo */
  requestMessageId: string;
  /** 金鑰最小長度，預設 2048 */
  minimalKeyLength?: number;
  /** 憑證有效期（秒），預設 1 年 */
  validityPeriodSeconds?: number;
  /** 續訂期（秒），預設 60 天 */
  renewalPeriodSeconds?: number;
}

/** 解析 Policy 請求中的 SOAP MessageID（用作 RelatesTo） */
export function parsePolicyMessageId(soapXml: string): string | undefined {
  const m = soapXml.match(
    /<(?:[a-zA-Z0-9]+:)?MessageID(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?MessageID>/
  );
  return m ? m[1].trim() : undefined;
}

/**
 * 構建 GetPoliciesResponse SOAP envelope
 *
 * 回應內含一個 policy 描述 X.509 證書模板：
 *   - minimalKeyLength = 2048
 *   - hashAlgorithmOIDReference = 0（對應 oID list 中的 SHA-256）
 *   - validityPeriodSeconds = 1 年
 */
export function buildPolicyResponse(config: PolicyResponseConfig): string {
  const {
    requestMessageId,
    minimalKeyLength = 2048,
    validityPeriodSeconds = 365 * 24 * 60 * 60,
    renewalPeriodSeconds = 60 * 24 * 60 * 60,
  } = config;
  const responseId = `urn:uuid:${crypto.randomUUID()}`;

  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
  <s:Header>
    <a:Action s:mustUnderstand="1">${POLICY_NS}/IPolicy/GetPoliciesResponse</a:Action>
    <ActivityId CorrelationId="${responseId}" xmlns="http://schemas.microsoft.com/2004/09/ServiceModel/Diagnostics">${responseId}</ActivityId>
    <a:RelatesTo>${escapeXml(requestMessageId)}</a:RelatesTo>
  </s:Header>
  <s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <GetPoliciesResponse xmlns="${POLICY_NS}">
      <response>
        <policyID/>
        <policyFriendlyName xsi:nil="true"/>
        <nextUpdateHours xsi:nil="true"/>
        <policiesNotChanged xsi:nil="true"/>
        <policies>
          <policy>
            <policyOIDReference>0</policyOIDReference>
            <cAs xsi:nil="true"/>
            <attributes>
              <commonName>CEPUnsecure</commonName>
              <policySchema>3</policySchema>
              <certificateValidity>
                <validityPeriodSeconds>${validityPeriodSeconds}</validityPeriodSeconds>
                <renewalPeriodSeconds>${renewalPeriodSeconds}</renewalPeriodSeconds>
              </certificateValidity>
              <permission>
                <enroll>true</enroll>
                <autoEnroll>false</autoEnroll>
              </permission>
              <privateKeyAttributes>
                <minimalKeyLength>${minimalKeyLength}</minimalKeyLength>
                <keySpec xsi:nil="true"/>
                <keyUsageProperty xsi:nil="true"/>
                <permissions xsi:nil="true"/>
                <algorithmOIDReference xsi:nil="true"/>
                <cryptoProviders xsi:nil="true"/>
              </privateKeyAttributes>
              <revision>
                <majorRevision>101</majorRevision>
                <minorRevision>0</minorRevision>
              </revision>
              <supersededPolicies xsi:nil="true"/>
              <privateKeyFlags xsi:nil="true"/>
              <subjectNameFlags xsi:nil="true"/>
              <enrollmentFlags xsi:nil="true"/>
              <generalFlags xsi:nil="true"/>
              <hashAlgorithmOIDReference>0</hashAlgorithmOIDReference>
              <rARequirements xsi:nil="true"/>
              <keyArchivalAttributes xsi:nil="true"/>
              <extensions xsi:nil="true"/>
            </attributes>
          </policy>
        </policies>
      </response>
      <cAs xsi:nil="true"/>
      <oIDs>
        <oID>
          <value>2.16.840.1.101.3.4.2.1</value>
          <group>4</group>
          <oIDReferenceID>0</oIDReferenceID>
          <defaultName>szOID_NIST_sha256</defaultName>
        </oID>
      </oIDs>
    </GetPoliciesResponse>
  </s:Body>
</s:Envelope>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
