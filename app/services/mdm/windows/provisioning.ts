/**
 * wap-provisioningdoc 生成（Windows MDM enrollment 回應的核心 payload）
 *
 * 設備收到後，會：
 *   1. 把 CA 根證書安裝到 LocalMachine\Root（信任後端 mTLS）
 *   2. 把裝置身份證書安裝到 CurrentUser\My（用於 mTLS client cert）
 *   3. 建立 DM Client，用 APPLICATION 內的 ADDR 連管理通道
 *   4. 套用 DMClient/Provider 中的 Push PFN 與 Poll 參數
 *
 * 規範：[MS-MDE2] §2.2.4.4
 */

import forge from "node-forge";

/** 構建 wap-provisioningdoc 的輸入 */
export interface ProvisioningDocConfig {
  /** CA 根證書 PEM（給設備建立 Root 信任） */
  caCertPem: string;
  /** 裝置身份證書 PEM（給設備裝到 My 證書庫） */
  deviceCertPem: string;
  /** Windows DeviceID（GUID 字串），用作 mTLS 查詢的 CN */
  deviceId: string;
  /** 後端管理通道 URL，例：https://mdm.example.com/api/mdm/win/manage/<deviceId> */
  managementUrl: string;
  /** WNS Package Family Name（從 WNS_PFN env 來），可選——未配置時設備走輪詢 */
  wnsPfn?: string;
  /** 提供商 ID，預設 "MS DM Server"（Win10 Magic Name；用其它值可能不被識別） */
  providerId?: string;
  /** 設備在管理後台的顯示名 */
  entDeviceName?: string;
}

/** 生成 wap-provisioningdoc XML（明文，供 Enrollment.svc 回應 base64 編碼） */
export function buildWapProvisioningDoc(config: ProvisioningDocConfig): string {
  const {
    caCertPem,
    deviceCertPem,
    deviceId,
    managementUrl,
    wnsPfn,
    providerId = "MS DM Server",
    entDeviceName = `Aspira-${deviceId.slice(0, 8)}`,
  } = config;

  const caInfo = certInfo(caCertPem);
  const devInfo = certInfo(deviceCertPem);

  const sslSearch =
    `Subject=CN%3D${encodeURIComponent(deviceId)}&Stores=My%5CUser`;

  // mTLS / DigestAuth 用的占位 secret（Windows 設備自動生成 client nonce 時實際不會用到）
  const dummySecret = randomHex(16);

  const pushBlock = wnsPfn
    ? `        <characteristic type="Push">
          <parm name="PFN" value="${escapeAttr(wnsPfn)}" datatype="string"/>
        </characteristic>
`
    : "";

  return `<wap-provisioningdoc version="1.1">
  <characteristic type="CertificateStore">
    <characteristic type="Root">
      <characteristic type="System">
        <characteristic type="${caInfo.thumbprint}">
          <parm name="EncodedCertificate" value="${caInfo.derBase64}"/>
        </characteristic>
      </characteristic>
    </characteristic>
    <characteristic type="My">
      <characteristic type="User">
        <characteristic type="${devInfo.thumbprint}">
          <parm name="EncodedCertificate" value="${devInfo.derBase64}"/>
          <characteristic type="PrivateKeyContainer"/>
        </characteristic>
      </characteristic>
    </characteristic>
  </characteristic>
  <characteristic type="APPLICATION">
    <parm name="APPID" value="w7"/>
    <parm name="PROVIDER-ID" value="${escapeAttr(providerId)}"/>
    <parm name="NAME" value="${escapeAttr(entDeviceName)}"/>
    <parm name="ADDR" value="${escapeAttr(managementUrl)}"/>
    <parm name="ROLE" value="4294967295"/>
    <parm name="BACKCOMPATRETRYDISABLED"/>
    <parm name="DEFAULTENCODING" value="application/vnd.syncml.dm+xml"/>
    <parm name="SSLCLIENTCERTSEARCHCRITERIA" value="${escapeAttr(sslSearch)}"/>
    <characteristic type="APPAUTH">
      <parm name="AAUTHLEVEL" value="CLIENT"/>
      <parm name="AAUTHTYPE" value="DIGEST"/>
      <parm name="AAUTHSECRET" value="${dummySecret}"/>
      <parm name="AAUTHDATA" value="${dummySecret}"/>
    </characteristic>
    <characteristic type="APPAUTH">
      <parm name="AAUTHLEVEL" value="APPSRV"/>
      <parm name="AAUTHTYPE" value="DIGEST"/>
      <parm name="AAUTHNAME" value="${escapeAttr(deviceId)}"/>
      <parm name="AAUTHSECRET" value="${dummySecret}"/>
      <parm name="AAUTHDATA" value="${dummySecret}"/>
    </characteristic>
  </characteristic>
  <characteristic type="DMClient">
    <characteristic type="Provider">
      <characteristic type="${escapeAttr(providerId)}">
        <parm name="EntDeviceName" datatype="string" value="${escapeAttr(entDeviceName)}"/>
${pushBlock}        <characteristic type="Poll">
          <parm name="NumberOfFirstRetries" value="5" datatype="integer"/>
          <parm name="IntervalForFirstSetOfRetries" value="1" datatype="integer"/>
          <parm name="NumberOfSecondRetries" value="10" datatype="integer"/>
          <parm name="IntervalForSecondSetOfRetries" value="5" datatype="integer"/>
          <parm name="IntervalForRemainingScheduledRetries" value="60" datatype="integer"/>
          <parm name="PollOnLogin" value="true" datatype="boolean"/>
        </characteristic>
      </characteristic>
    </characteristic>
  </characteristic>
</wap-provisioningdoc>`;
}

// ---------- 內部工具 ----------

/** 從 PEM 萃取 thumbprint（SHA-1 of DER, 大寫 hex）+ DER base64 */
function certInfo(pem: string): { thumbprint: string; derBase64: string } {
  const cert = forge.pki.certificateFromPem(pem);
  const derStr = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha1.create();
  md.update(derStr);
  const thumbprint = md.digest().toHex().toUpperCase();
  const derBase64 = forge.util.encode64(derStr);
  return { thumbprint, derBase64 };
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
