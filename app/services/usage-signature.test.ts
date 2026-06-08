import { assert, assertEquals } from "jsr:@std/assert";
import {
  canonicalUsageMessage,
  computeUsageSignature,
  verifyUsageSignature,
} from "~/services/usage-signature.ts";

// 跨語言一致性向量：agent 端 UsageSignatureTests.cs 斷言同一 hex，
// 確保 C# 與 TS 對同一輸入產生相同簽名（改任一端 canonical 格式即兩端紅）。
const VECTOR = {
  token: "test-token-123",
  input: {
    serialNumber: "F2L0001",
    sessionId: null,
    stats: [{
      date: "2026-06-01",
      totalMinutes: 120,
      pickup: 15,
      maxContinuous: 45,
      timeStats: { "9": 30, "10": 25, "14": 65 },
    }],
  },
  canonical: "F2L0001\n\n2026-06-01|120|15|45|9=30,10=25,14=65",
  hex: "73ac28e55b7bf02a722bbfb1c4ebd5ad7416f07a75c12afa3de8c98fb82bc33c",
};

Deno.test("canonicalUsageMessage: 規範化格式鎖定（跨語言契約）", () => {
  assertEquals(canonicalUsageMessage(VECTOR.input), VECTOR.canonical);
});

Deno.test("computeUsageSignature: 已知向量 hex 鎖定", async () => {
  assertEquals(await computeUsageSignature(VECTOR.token, VECTOR.input), VECTOR.hex);
});

Deno.test("canonical: timeStats 按小時數字升序（非字典序）", () => {
  const msg = canonicalUsageMessage({
    serialNumber: "S",
    sessionId: null,
    stats: [{
      date: "2026-06-01",
      totalMinutes: 1,
      pickup: 0,
      maxContinuous: 1,
      // 故意亂序 + 多位數，驗證按數值排序：2 < 9 < 10
      timeStats: { "10": 3, "2": 1, "9": 2 },
    }],
  });
  assert(msg.endsWith("2=1,9=2,10=3"), msg);
});

Deno.test("verifyUsageSignature: 正確簽名通過、篡改後失敗", async () => {
  const sig = await computeUsageSignature(VECTOR.token, VECTOR.input);
  assert(await verifyUsageSignature(VECTOR.token, VECTOR.input, sig));

  // 篡改 stats（少報 totalMinutes）→ 簽名不符
  const tampered = {
    ...VECTOR.input,
    stats: [{ ...VECTOR.input.stats[0], totalMinutes: 5 }],
  };
  assert(!(await verifyUsageSignature(VECTOR.token, tampered, sig)));

  // 錯誤 token → 簽名不符
  assert(!(await verifyUsageSignature("wrong-token", VECTOR.input, sig)));
});

Deno.test("verifyUsageSignature: 大小寫不敏感（hex 正規化）", async () => {
  const sig = await computeUsageSignature(VECTOR.token, VECTOR.input);
  assert(await verifyUsageSignature(VECTOR.token, VECTOR.input, sig.toUpperCase()));
});
