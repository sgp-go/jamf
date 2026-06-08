import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  _resetSecretsWarningForTesting,
  decryptSecret,
  encryptSecret,
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
