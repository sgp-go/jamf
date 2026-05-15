/**
 * 機密欄位的存取抽象。
 *
 * Phase 1：明文 passthrough（與 DB 欄位內容相同）。
 * Phase 3：以 envelope encryption 解密（AES-256-GCM + KMS-wrapped DEK）。
 *
 * 把所有 `*_enc` 欄位的讀寫都走這層，後續切換不需要動 service / route。
 */

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return "";
  return value;
}

export function encryptSecret(plain: string): string {
  return plain;
}
