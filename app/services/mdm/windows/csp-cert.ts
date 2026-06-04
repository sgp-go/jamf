/**
 * RootCATrustedCertificates CSP — 運行時下發信任憑證
 *
 * 用於讓設備信任 LOB MSIX 的自簽簽名憑證（否則 sideload install 報
 * 0x800B0109 CERT_E_UNTRUSTEDROOT）。push-capable MSIX 用自簽 cert
 * （CN=27397969...）簽名以保持 PFN 一致，設備須先信任該 cert。
 *
 * 路徑：./Device/Vendor/MSFT/RootCATrustedCertificates/<Store>/<Thumbprint>/EncodedCertificate
 *   - Store：Root / CA / TrustedPublisher / TrustedPeople
 *   - 自簽 cert 既是 root 又是 leaf：MSIX sideload 需同時裝 Root（鏈驗證）
 *     + TrustedPeople（sideload 信任），對齊手動裝 cert 的兩個 store（見 quick-start §3.1）
 *   - format=chr，data=base64(DER)
 *
 * MS 文件依據：rootcacertificates-csp
 */
import type { SyncMLCommand } from "./syncml.ts";

const CSP_ROOT = "./Device/Vendor/MSFT/RootCATrustedCertificates";

export type CertStore = "Root" | "CA" | "TrustedPublisher" | "TrustedPeople";

/**
 * 產生一條把憑證裝到指定 store 的 Add 命令。
 * @param thumbprint SHA1 指紋（大寫 hex，無空格）
 * @param certDerBase64 憑證 DER 的 base64
 */
export function buildInstallTrustedCert(opts: {
  thumbprint: string;
  certDerBase64: string;
  store?: CertStore;
}): SyncMLCommand {
  const store = opts.store ?? "TrustedPeople";
  return {
    cmdId: "0", // 由 buildSyncML 填入真實值
    verb: "Add",
    target: `${CSP_ROOT}/${store}/${opts.thumbprint}/EncodedCertificate`,
    format: "chr",
    data: opts.certDerBase64,
  };
}
