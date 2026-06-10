import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  _resetSecretsWarningForTesting,
  decryptSecret,
  decryptWith,
  encryptSecret,
  encryptWith,
  isEncrypted,
  parseKeyBase64,
} from "./secrets.ts";

const KEY_ENV = "DATA_ENCRYPTION_KEY";
// 固定 32 bytes base64 金鑰（測試用）
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** 在設定金鑰的環境下跑 fn，結束後還原。 */
async function withKey(key: string | null, fn: () => void | Promise<void>) {
  const prev = Deno.env.get(KEY_ENV);
  if (key === null) {
    Deno.env.delete(KEY_ENV);
  } else {
    Deno.env.set(KEY_ENV, key);
  }
  _resetSecretsWarningForTesting();
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete(KEY_ENV);
    else Deno.env.set(KEY_ENV, prev);
  }
}

Deno.test("secrets: 未設金鑰 → encrypt passthrough，decrypt 明文原樣", async () => {
  await withKey(null, () => {
    assertEquals(encryptSecret("my-secret"), "my-secret"); // 不加密
    assertEquals(decryptSecret("my-secret"), "my-secret"); // legacy 明文
  });
});

Deno.test("secrets: 設金鑰 → round-trip 還原，密文帶 v1: 前綴且異於明文", async () => {
  await withKey(TEST_KEY, () => {
    const plain = "jamf-client-secret-xyz";
    const enc = encryptSecret(plain);
    assertEquals(enc.startsWith("v1:"), true);
    assertNotEquals(enc, plain);
    assertEquals(decryptSecret(enc), plain);
  });
});

Deno.test("secrets: 同明文兩次加密密文不同（IV 隨機）", async () => {
  await withKey(TEST_KEY, () => {
    const a = encryptSecret("same-plaintext");
    const b = encryptSecret("same-plaintext");
    assertNotEquals(a, b);
    // 但都能還原
    assertEquals(decryptSecret(a), "same-plaintext");
    assertEquals(decryptSecret(b), "same-plaintext");
  });
});

Deno.test("secrets: 金鑰已設仍能讀 legacy 明文（向後相容，無前綴）", async () => {
  await withKey(TEST_KEY, () => {
    // 模擬 DB 既有明文行（Phase 1 寫入）
    assertEquals(decryptSecret("legacy-plaintext-value"), "legacy-plaintext-value");
  });
});

Deno.test("secrets: 篡改密文 → GCM 認證失敗拋錯", async () => {
  await withKey(TEST_KEY, () => {
    const enc = encryptSecret("tamper-target");
    // 翻轉密文最後一個 base64 字元
    const last = enc.slice(-1) === "A" ? "B" : "A";
    const tampered = enc.slice(0, -1) + last;
    assertThrows(() => decryptSecret(tampered));
  });
});

Deno.test("secrets: 遇 v1: 密文但金鑰未設 → 拋錯（不靜默返回亂碼）", async () => {
  let enc = "";
  await withKey(TEST_KEY, () => {
    enc = encryptSecret("needs-key-to-read");
  });
  await withKey(null, () => {
    assertThrows(() => decryptSecret(enc), Error, "DATA_ENCRYPTION_KEY 未設置");
  });
});

Deno.test("secrets: 空值 / null / undefined → 空字串", async () => {
  await withKey(TEST_KEY, () => {
    assertEquals(encryptSecret(""), "");
    assertEquals(decryptSecret(""), "");
    assertEquals(decryptSecret(null), "");
    assertEquals(decryptSecret(undefined), "");
  });
});

Deno.test("secrets: 金鑰長度非 32 bytes → encrypt 拋錯", async () => {
  const shortKey = Buffer.alloc(16, 1).toString("base64"); // 16 bytes
  await withKey(shortKey, () => {
    assertThrows(() => encryptSecret("x"), Error, "32 bytes");
  });
});

// ── 底層顯式傳 key 的 API（金鑰輪換腳本用，不依賴 env）──

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

Deno.test("secrets/encryptWith: round-trip 顯式金鑰還原", () => {
  const enc = encryptWith(KEY_A, "explicit-key-secret");
  assertEquals(enc.startsWith("v1:"), true);
  assertEquals(decryptWith(KEY_A, enc), "explicit-key-secret");
});

Deno.test("secrets/decryptWith: 用錯金鑰解密 → GCM 認證失敗拋錯（輪換重跑保護的基礎）", () => {
  const enc = encryptWith(KEY_A, "rotate-me");
  assertThrows(() => decryptWith(KEY_B, enc));
});

Deno.test("secrets: 輪換語義 decrypt(old)→encrypt(new)→decrypt(new) 還原", () => {
  const plain = "laps-password-20-chars";
  const oldCipher = encryptWith(KEY_A, plain);
  // 模擬輪換：用舊金鑰解、用新金鑰重加密
  const recovered = decryptWith(KEY_A, oldCipher);
  const newCipher = encryptWith(KEY_B, recovered);
  assertNotEquals(newCipher, oldCipher);
  assertEquals(decryptWith(KEY_B, newCipher), plain);
  // 新密文不能再被舊金鑰解開
  assertThrows(() => decryptWith(KEY_A, newCipher));
});

Deno.test("secrets/isEncrypted: v1 前綴=true，明文/空值=false", () => {
  assertEquals(isEncrypted(encryptWith(KEY_A, "x")), true);
  assertEquals(isEncrypted("legacy-plaintext"), false);
  assertEquals(isEncrypted(""), false);
  assertEquals(isEncrypted(null), false);
  assertEquals(isEncrypted(undefined), false);
});

Deno.test("secrets/parseKeyBase64: 32 bytes 通過，非 32 拋錯", () => {
  const ok = parseKeyBase64(Buffer.alloc(32, 9).toString("base64"));
  assertEquals(ok.length, 32);
  assertThrows(
    () => parseKeyBase64(Buffer.alloc(16, 9).toString("base64")),
    Error,
    "32 bytes",
  );
});
