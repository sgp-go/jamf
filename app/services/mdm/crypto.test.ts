import { assertEquals, assert, assertThrows } from "jsr:@std/assert@^1";
import forge from "node-forge";
import { signWindowsDeviceCsr, getCaRootDer } from "./crypto.ts";

/** 在記憶體裡生一個合法 CSR PEM（不寫入檔案系統） */
function makeCsrPem(commonName = "test-cn"): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

Deno.test("signWindowsDeviceCsr: 合法 CSR 簽發後 CN = deviceId", () => {
  const csrPem = makeCsrPem();
  const certPem = signWindowsDeviceCsr(csrPem, "WIN-DEV-ABC-123");
  const cert = forge.pki.certificateFromPem(certPem);

  const cnAttr = cert.subject.getField("CN");
  assertEquals(cnAttr?.value, "WIN-DEV-ABC-123");
});

Deno.test("signWindowsDeviceCsr: 簽發證書 issuer = CA 主體", () => {
  const csrPem = makeCsrPem();
  const certPem = signWindowsDeviceCsr(csrPem, "DEV1");
  const cert = forge.pki.certificateFromPem(certPem);

  const issuerCN = cert.issuer.getField("CN");
  assertEquals(issuerCN?.value, "Self-Hosted MDM CA");
});

Deno.test("signWindowsDeviceCsr: 有效期約 1 年", () => {
  const csrPem = makeCsrPem();
  const certPem = signWindowsDeviceCsr(csrPem, "DEV2");
  const cert = forge.pki.certificateFromPem(certPem);

  const days =
    (cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime()) /
    (1000 * 60 * 60 * 24);
  assert(days >= 360 && days <= 367, `預期約 365 天，實際 ${days}`);
});

Deno.test("signWindowsDeviceCsr: 含 clientAuth EKU（mTLS 需要）", () => {
  const csrPem = makeCsrPem();
  const certPem = signWindowsDeviceCsr(csrPem, "DEV3");
  const cert = forge.pki.certificateFromPem(certPem);

  const eku = cert.getExtension("extKeyUsage") as
    | { clientAuth?: boolean }
    | null;
  assert(eku?.clientAuth, "必須設置 clientAuth EKU");
});

Deno.test("signWindowsDeviceCsr: 損壞的 CSR signature 應拋錯", () => {
  // 取一個合法 CSR，篡改其 signature 區塊
  const csrPem = makeCsrPem();
  const tampered = csrPem.replace(/[A-Za-z0-9+\/]{20}/, "AAAAAAAAAAAAAAAAAAAA");
  assertThrows(() => signWindowsDeviceCsr(tampered, "DEV"), Error);
});

Deno.test("signWindowsDeviceCsr: 簽發出的證書能用 CA 公鑰驗證", () => {
  const csrPem = makeCsrPem();
  const certPem = signWindowsDeviceCsr(csrPem, "DEV4");
  const cert = forge.pki.certificateFromPem(certPem);

  // 從 getCaRootDer 還原出 CA 證書，用其公鑰驗證裝置證書
  const caDer = getCaRootDer();
  const derStr = String.fromCharCode(...caDer);
  const caCert = forge.pki.certificateFromAsn1(
    forge.asn1.fromDer(derStr) as forge.asn1.Asn1
  );

  // verify 會用 caCert 的 publicKey 驗 cert 的 signature
  assert(caCert.verify(cert), "CA 應能驗證簽發出的裝置證書");
});

Deno.test("getCaRootDer: 回傳合理長度的 DER bytes", () => {
  const der = getCaRootDer();
  assert(
    der.length > 500 && der.length < 5000,
    `預期 CA DER 介於 500-5000 bytes，實際 ${der.length}`
  );
  // DER 都是以 0x30 (SEQUENCE) 起頭
  assertEquals(der[0], 0x30);
});
