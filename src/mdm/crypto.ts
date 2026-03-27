/** 憑證管理 - CA 生成、裝置憑證簽發、PKCS#12、DEP token 解密 */

import forge from "node-forge";

const CERTS_DIR = "certs";

/** 確保 certs 目錄存在 */
function ensureCertsDir(): void {
  try {
    Deno.mkdirSync(CERTS_DIR, { recursive: true });
  } catch {
    // 目錄已存在
  }
}

// ============================================================
// CA 憑證（自建根憑證，用於簽發裝置憑證）
// ============================================================

/** 取得或生成 CA 憑證和金鑰 */
export function getOrCreateCA(): { cert: forge.pki.Certificate; key: forge.pki.PrivateKey } {
  ensureCertsDir();
  const certPath = `${CERTS_DIR}/ca_cert.pem`;
  const keyPath = `${CERTS_DIR}/ca_key.pem`;

  try {
    const certPem = Deno.readTextFileSync(certPath);
    const keyPem = Deno.readTextFileSync(keyPath);
    return {
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
    };
  } catch {
    // 不存在，生成新的
    console.log("[MDM] 生成新的 CA 憑證...");
    const { cert, key } = generateCA();
    Deno.writeTextFileSync(certPath, forge.pki.certificateToPem(cert));
    Deno.writeTextFileSync(keyPath, forge.pki.privateKeyToPem(key));
    console.log("[MDM] CA 憑證已儲存到", certPath);
    return { cert, key };
  }
}

/** 生成 CA 根憑證（有效期 10 年） */
function generateCA(): { cert: forge.pki.Certificate; key: forge.pki.PrivateKey } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerialNumber();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs: forge.pki.CertificateField[] = [
    { name: "commonName", value: "Self-Hosted MDM CA" },
    { name: "organizationName", value: "Aspira" },
    { name: "countryName", value: "TW" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      critical: true,
    },
    {
      name: "subjectKeyIdentifier",
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

// ============================================================
// 裝置身份憑證
// ============================================================

/** 簽發裝置身份憑證，回傳 PKCS#12（DER 格式） */
export function issueDeviceCertificateP12(
  deviceUdid: string,
  password: string
): Uint8Array {
  const ca = getOrCreateCA();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerialNumber();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  cert.setSubject([
    { name: "commonName", value: `MDM Device ${deviceUdid}` },
    { name: "organizationName", value: "Aspira" },
  ]);
  cert.setIssuer(ca.cert.subject.attributes);

  cert.setExtensions([
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: "extKeyUsage",
      clientAuth: true,
    },
  ]);

  cert.sign(ca.key, forge.md.sha256.create());

  // 打包為 PKCS#12
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert, ca.cert], password, {
    algorithm: "3des",
  });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  return Uint8Array.from(p12Der, (c: string) => c.charCodeAt(0));
}

/** 取得 CA 憑證的 PEM 字串 */
export function getCACertPem(): string {
  const ca = getOrCreateCA();
  return forge.pki.certificateToPem(ca.cert);
}

/** 取得 CA 憑證的 DER 格式（base64 編碼） */
export function getCACertDerBase64(): string {
  const ca = getOrCreateCA();
  const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes();
  return forge.util.encode64(derBytes);
}

// ============================================================
// DEP Server Token 解密
// ============================================================

/** 取得或生成 DEP 金鑰對 */
export function getOrCreateDepKeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
} {
  ensureCertsDir();
  const pubPath = `${CERTS_DIR}/dep_pubkey.pem`;
  const keyPath = `${CERTS_DIR}/dep_key.pem`;

  try {
    const publicKeyPem = Deno.readTextFileSync(pubPath);
    const privateKeyPem = Deno.readTextFileSync(keyPath);
    return { publicKeyPem, privateKeyPem };
  } catch {
    console.log("[MDM] 生成新的 DEP 金鑰對...");
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const publicKeyPem = forge.pki.publicKeyToPem(keys.publicKey);
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    // 同時生成自簽憑證包裝公鑰（ABM 需要的是憑證 PEM，不是裸公鑰）
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = generateSerialNumber();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

    const attrs: forge.pki.CertificateField[] = [
      { name: "commonName", value: "Self-Hosted MDM DEP" },
      { name: "organizationName", value: "Aspira" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    Deno.writeTextFileSync(pubPath, certPem);
    Deno.writeTextFileSync(keyPath, privateKeyPem);
    console.log("[MDM] DEP 金鑰對已儲存");
    return { publicKeyPem: certPem, privateKeyPem };
  }
}

/**
 * 解密 DEP Server Token (.p7m)
 * ABM 下載的 token 是 CMS/PKCS#7 加密的 JSON
 */
export function decryptDepToken(p7mData: Uint8Array): {
  consumer_key: string;
  consumer_secret: string;
  access_token: string;
  access_secret: string;
  access_token_expiry: string;
} {
  const { privateKeyPem } = getOrCreateDepKeyPair();
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);

  // ABM 下載的 .p7m 可能是 S/MIME 格式（帶 MIME header + base64 body）
  // 需要先剝離 header，提取純 base64 資料再解碼為 DER
  let derBytes: string;
  const text = new TextDecoder().decode(p7mData);
  if (text.startsWith("Content-Type:") || text.includes("smime-type=enveloped-data")) {
    // S/MIME 格式：跳過 header，提取空行之後的 base64 body
    const parts = text.split(/\r?\n\r?\n/);
    if (parts.length < 2) {
      throw new Error("無效的 S/MIME 格式：找不到 body");
    }
    const b64Body = parts.slice(1).join("").replace(/\s/g, "");
    derBytes = forge.util.decode64(b64Body);
  } else {
    // 純 DER 二進位
    derBytes = String.fromCharCode(...p7mData);
  }

  const p7mDer = forge.util.createBuffer(derBytes);
  const p7 = forge.pkcs7.messageFromAsn1(
    forge.asn1.fromDer(p7mDer)
  );

  if (!("decrypt" in p7)) {
    throw new Error("無效的 PKCS#7 EnvelopedData 格式");
  }

  // 取得接收者資訊並解密
  const enveloped = p7 as forge.pkcs7.PkcsEnvelopedData;
  const recipient = enveloped.recipients[0];
  if (!recipient) {
    throw new Error("PKCS#7 中沒有接收者資訊");
  }

  enveloped.decrypt(recipient, privateKey);

  // 解密後的內容可能帶有 MIME header 和 BEGIN/END MESSAGE 包裹
  let rawContent = (enveloped.content as forge.util.ByteStringBuffer).toString();

  // 剝離 MIME header（Content-Type 等行）
  if (rawContent.includes("Content-Type:")) {
    const parts = rawContent.split(/\r?\n\r?\n/);
    rawContent = parts.slice(1).join("\n\n");
  }

  // 剝離 -----BEGIN MESSAGE----- / -----END MESSAGE-----
  rawContent = rawContent
    .replace(/-----BEGIN MESSAGE-----/g, "")
    .replace(/-----END MESSAGE-----/g, "")
    .trim();

  const token = JSON.parse(rawContent);

  return {
    consumer_key: token.consumer_key,
    consumer_secret: token.consumer_secret,
    access_token: token.access_token,
    access_secret: token.access_secret,
    access_token_expiry: token.access_token_expiry ?? "",
  };
}

// ============================================================
// APNS 憑證管理
// ============================================================

// ============================================================
// MDM Vendor Certificate（Apple Developer 後台簽發）
// ============================================================

/**
 * 生成 MDM Vendor Certificate 的 CSR
 * 使用者拿此 CSR 到 Apple Developer 後台申請 MDM Vendor Certificate
 */
export function generateVendorCsr(): { csrPem: string } {
  ensureCertsDir();

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: "commonName", value: "Self-Hosted MDM Vendor" },
    { name: "organizationName", value: "Aspira" },
    { name: "countryName", value: "TW" },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  const csrPem = forge.pki.certificationRequestToPem(csr);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  Deno.writeTextFileSync(`${CERTS_DIR}/vendor_key.pem`, keyPem);
  Deno.writeTextFileSync(`${CERTS_DIR}/vendor_csr.pem`, csrPem);
  console.log("[MDM] Vendor CSR 已生成，私鑰已儲存");

  return { csrPem };
}

/**
 * 上傳 Apple Developer 簽發的 MDM Vendor Certificate (.cer)
 * 自動轉換 DER → PEM，配對已儲存的私鑰
 */
export function saveVendorCert(cerData: Uint8Array, keyPem?: string): {
  subject: string;
  issuer: string;
  expiry: string;
} {
  ensureCertsDir();

  // 如果提供了私鑰，直接儲存
  if (keyPem) {
    Deno.writeTextFileSync(`${CERTS_DIR}/vendor_key.pem`, keyPem);
  } else {
    // 檢查先前 CSR 步驟是否已儲存私鑰
    try {
      Deno.readTextFileSync(`${CERTS_DIR}/vendor_key.pem`);
    } catch {
      throw new Error(
        "未提供私鑰，且伺服器上也沒有已儲存的私鑰。" +
        "請先呼叫 GET /api/mdm/certs/vendor/csr 生成 CSR，或上傳時同時提供 key"
      );
    }
  }

  // DER → PEM
  const derStr = String.fromCharCode(...cerData);
  let cert: forge.pki.Certificate;
  try {
    // 嘗試當作 DER 解析
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(derStr));
    cert = forge.pki.certificateFromAsn1(asn1);
  } catch {
    // 可能已經是 PEM
    try {
      cert = forge.pki.certificateFromPem(new TextDecoder().decode(cerData));
    } catch (e) {
      throw new Error(`無效的憑證格式: ${e instanceof Error ? e.message : e}`);
    }
  }

  const certPem = forge.pki.certificateToPem(cert);
  Deno.writeTextFileSync(`${CERTS_DIR}/vendor_cert.pem`, certPem);

  const subject = cert.subject.attributes
    .map((a: forge.pki.CertificateField) => `${a.shortName ?? a.name ?? a.type}=${a.value}`)
    .join(", ");
  const issuer = cert.issuer.attributes
    .map((a: forge.pki.CertificateField) => `${a.shortName ?? a.name ?? a.type}=${a.value}`)
    .join(", ");
  const expiry = cert.validity.notAfter.toISOString();

  console.log(`[MDM] Vendor Certificate 已儲存: ${subject}`);
  return { subject, issuer, expiry };
}

/**
 * 生成 APNS 推播憑證的 CSR
 * 私鑰自動儲存到 certs/apns_key.pem，CSR 回傳供使用者下載
 * 使用者拿 CSR 去 Apple Push Certificates Portal 簽發後，
 * 再透過 POST /api/mdm/certs/apns 上傳憑證（伺服器自動配對私鑰）
 */
export function generateApnsCsr(): { csrPem: string } {
  ensureCertsDir();

  const keys = forge.pki.rsa.generateKeyPair(2048);

  // 建立 CSR
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: "commonName", value: "Self-Hosted MDM APNS" },
    { name: "organizationName", value: "Aspira" },
    { name: "countryName", value: "TW" },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  const csrPem = forge.pki.certificationRequestToPem(csr);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // 儲存私鑰和 CSR（後續簽署和上傳憑證時使用）
  Deno.writeTextFileSync(`${CERTS_DIR}/apns_key.pem`, keyPem);
  Deno.writeTextFileSync(`${CERTS_DIR}/apns_csr.pem`, csrPem);
  console.log("[MDM] APNS CSR 已生成，私鑰和 CSR 已儲存");

  return { csrPem };
}

/** UID OID（用於 APNS Topic 提取） */
const UID_OID = "0.9.2342.19200300.100.1.1";

/** 從憑證 Subject 中提取 UID（APNS Topic） */
function extractUidFromCert(cert: forge.pki.Certificate): string | undefined {
  const attr = cert.subject.getField({ name: "userId" }) ??
    cert.subject.getField({ shortName: "UID" }) ??
    cert.subject.getField({ type: UID_OID });
  return attr ? String(attr.value) : undefined;
}

/** 檢查 APNS 推播憑證是否存在 */
export function getApnsCertInfo(): {
  exists: boolean;
  expiry?: string;
  topic?: string;
} {
  try {
    const certPem = Deno.readTextFileSync(`${CERTS_DIR}/apns_cert.pem`);
    const cert = forge.pki.certificateFromPem(certPem);
    const expiry = cert.validity.notAfter.toISOString();

    // 從 Subject 中提取 UID（即 APNS Topic）
    const topic = extractUidFromCert(cert);

    return { exists: true, expiry, topic };
  } catch {
    return { exists: false };
  }
}

/** 載入 APNS 憑證和金鑰（PEM 格式） */
export function loadApnsCert(): { certPem: string; keyPem: string } | null {
  try {
    const certPem = Deno.readTextFileSync(`${CERTS_DIR}/apns_cert.pem`);
    const keyPem = Deno.readTextFileSync(`${CERTS_DIR}/apns_key.pem`);
    return { certPem, keyPem };
  } catch {
    return null;
  }
}

/** 從 APNS 憑證中提取 topic（Subject UID 欄位） */
export function getApnsTopic(): string | null {
  const info = getApnsCertInfo();
  return info.topic ?? null;
}

/** APNS 憑證檔案路徑（固定） */
export const APNS_CERT_PATH = `${CERTS_DIR}/apns_cert.pem`;
export const APNS_KEY_PATH = `${CERTS_DIR}/apns_key.pem`;

/**
 * 上傳並儲存 APNS 推播憑證
 * - 若提供 keyPem：同時儲存憑證和金鑰
 * - 若未提供 keyPem：僅儲存憑證，使用先前 CSR 步驟已儲存的私鑰
 */
export function saveApnsCert(certPem: string, keyPem?: string): {
  topic: string;
  expiry: string;
  subject: string;
} {
  ensureCertsDir();

  // 驗證憑證 PEM 格式
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(certPem);
  } catch (e) {
    throw new Error(`無效的憑證 PEM 格式: ${e instanceof Error ? e.message : e}`);
  }

  if (keyPem) {
    // 有提供金鑰，驗證格式
    try {
      forge.pki.privateKeyFromPem(keyPem);
    } catch (e) {
      throw new Error(`無效的金鑰 PEM 格式: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    // 未提供金鑰，檢查 CSR 步驟是否已儲存私鑰
    try {
      const existingKey = Deno.readTextFileSync(APNS_KEY_PATH);
      forge.pki.privateKeyFromPem(existingKey);
    } catch {
      throw new Error(
        "未提供私鑰，且伺服器上也沒有已儲存的私鑰。" +
        "請先呼叫 GET /api/mdm/certs/apns/csr 生成 CSR，或上傳時同時提供 key"
      );
    }
  }

  // 提取 topic（Subject UID）
  const topic = extractUidFromCert(cert);
  if (!topic) {
    throw new Error("憑證中找不到 UID 欄位（APNS Topic），請確認是 MDM 推播憑證");
  }

  const expiry = cert.validity.notAfter.toISOString();
  const subject = cert.subject.attributes
    .map((a: forge.pki.CertificateField) => `${a.shortName ?? a.name ?? a.type}=${a.value}`)
    .join(", ");

  // 儲存到檔案
  Deno.writeTextFileSync(APNS_CERT_PATH, certPem);
  if (keyPem) {
    Deno.writeTextFileSync(APNS_KEY_PATH, keyPem);
  }

  console.log(`[MDM] APNS 憑證已儲存: topic=${topic}, expiry=${expiry}`);
  return { topic, expiry, subject };
}

// ============================================================
// 工具函式
// ============================================================

/** 生成隨機序號（hex 字串） */
function generateSerialNumber(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
