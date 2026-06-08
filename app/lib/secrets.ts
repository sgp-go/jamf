/**
 * 機密欄位的存取抽象。
 *
 * 所有 `*_enc` 欄位的讀寫都走這層，加密實作切換不需動 service / route。
 *
 * 加密方案：AES-256-GCM（authenticated encryption）。
 *   密文格式：`v1:` + base64( iv[12] || authTag[16] || ciphertext )
 *   金鑰：環境變數 `DATA_ENCRYPTION_KEY`（base64 編碼的 32 bytes / 256-bit）
 *
 * 向後相容（無需資料遷移）：
 *   - decryptSecret 見 `v1:` 前綴才解密；無前綴一律當 legacy 明文原樣返回。
 *   - 既有明文行在「下次寫入」時自動升級為密文。
 *
 * Dev / test 友好：
 *   - `DATA_ENCRYPTION_KEY` 未設時 encryptSecret 走明文 passthrough（+ 一次性 warn）。
 *   - **生產環境必須設置**（否則機密明文落 DB）。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "v1:";
const IV_LEN = 12; // GCM 標準 nonce 長度
const TAG_LEN = 16; // GCM auth tag 長度
const KEY_LEN = 32; // AES-256

let warnedNoKey = false;

/** 讀取並驗證金鑰；未設置返回 null（passthrough 模式）。 */
function getKey(): Buffer | null {
  const raw = Deno.env.get("DATA_ENCRYPTION_KEY");
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(
      `DATA_ENCRYPTION_KEY 必須是 base64 編碼的 ${KEY_LEN} bytes（256-bit）金鑰，` +
        `當前解碼後為 ${key.length} bytes。生成：openssl rand -base64 32`,
    );
  }
  return key;
}

function warnNoKeyOnce(): void {
  if (warnedNoKey) return;
  warnedNoKey = true;
  console.warn(
    "[secrets] DATA_ENCRYPTION_KEY 未設置：機密以明文存儲。僅 dev/test 可接受，生產環境必須設置。",
  );
}

/**
 * 解密機密欄位值。
 *
 * @param value DB 中的 `*_enc` 欄位值（可能是 v1: 密文，或 legacy 明文）
 * @returns 明文；空值返回 ""
 * @throws 遇到 v1: 密文但金鑰未設置 / 密文被篡改（GCM 認證失敗）
 */
export function decryptSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.startsWith(PREFIX)) return value; // legacy 明文

  const key = getKey();
  if (!key) {
    throw new Error(
      "遇到加密機密（v1: 前綴）但 DATA_ENCRYPTION_KEY 未設置，無法解密。",
    );
  }
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    .toString("utf8");
}

/**
 * 加密機密欄位值（寫 DB 前調用）。
 *
 * @param plain 明文機密；空字串原樣返回（不加密空值）
 * @returns 金鑰已設 → `v1:` 密文；未設 → 明文 passthrough（dev/test）
 */
export function encryptSecret(plain: string): string {
  if (plain === "") return "";

  const key = getKey();
  if (!key) {
    warnNoKeyOnce();
    return plain; // dev/test passthrough
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** 測試用：重置 warn-once 旗標。 */
export function _resetSecretsWarningForTesting(): void {
  warnedNoKey = false;
}
