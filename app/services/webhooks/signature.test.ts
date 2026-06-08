import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { signWebhookPayload, verifyWebhookSignature } from "./signature.ts";

describe("signWebhookPayload", () => {
  it("HMAC-SHA256 已知向量：相同輸入應產出穩定簽名", () => {
    const sig = signWebhookPayload({
      secret: "test-secret",
      timestamp: 1748171234,
      body: '{"event_type":"device.enrolled","data":{"id":"x"}}',
    });
    // 預先用 `openssl dgst -sha256 -hmac test-secret` 獨立計算驗證過的已知期望值，
    // 鎖死 HMAC 簽名格式不變（避免日後改動誤調 signing string 結構）。
    assert.equal(
      sig,
      "sha256=2effd5c1f51c43d805fb372ce9a7dd4259ea75834a51553de464cc23d6aa6232",
    );
  });

  it("輸出格式為 sha256={64 hex}", () => {
    const sig = signWebhookPayload({
      secret: "any",
      timestamp: 0,
      body: "",
    });
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  });

  it("body 不同則簽名不同（避免 timestamp 偽造）", () => {
    const a = signWebhookPayload({ secret: "s", timestamp: 100, body: "a" });
    const b = signWebhookPayload({ secret: "s", timestamp: 100, body: "b" });
    assert.notEqual(a, b);
  });

  it("timestamp 不同則簽名不同（避免 replay）", () => {
    const a = signWebhookPayload({ secret: "s", timestamp: 100, body: "x" });
    const b = signWebhookPayload({ secret: "s", timestamp: 101, body: "x" });
    assert.notEqual(a, b);
  });

  it("secret 不同則簽名不同（避免跨 tenant 偽造）", () => {
    const a = signWebhookPayload({ secret: "s1", timestamp: 100, body: "x" });
    const b = signWebhookPayload({ secret: "s2", timestamp: 100, body: "x" });
    assert.notEqual(a, b);
  });
});

describe("verifyWebhookSignature", () => {
  it("正確簽名通過驗證", () => {
    const args = { secret: "s", timestamp: 1000, body: "payload" };
    const sig = signWebhookPayload(args);
    assert.equal(verifyWebhookSignature({ ...args, signature: sig }), true);
  });

  it("body 被竄改後驗證失敗", () => {
    const sig = signWebhookPayload({ secret: "s", timestamp: 1000, body: "orig" });
    assert.equal(
      verifyWebhookSignature({
        secret: "s",
        timestamp: 1000,
        body: "tampered",
        signature: sig,
      }),
      false,
    );
  });

  it("錯誤 secret 驗證失敗（防跨租戶偽造）", () => {
    const sig = signWebhookPayload({ secret: "real", timestamp: 1000, body: "x" });
    assert.equal(
      verifyWebhookSignature({
        secret: "fake",
        timestamp: 1000,
        body: "x",
        signature: sig,
      }),
      false,
    );
  });

  it("簽名長度不一致直接 false（不會拋錯）", () => {
    assert.equal(
      verifyWebhookSignature({
        secret: "s",
        timestamp: 1000,
        body: "x",
        signature: "too-short",
      }),
      false,
    );
  });

  it("空 signature 字串返回 false", () => {
    assert.equal(
      verifyWebhookSignature({
        secret: "s",
        timestamp: 1000,
        body: "x",
        signature: "",
      }),
      false,
    );
  });
});
