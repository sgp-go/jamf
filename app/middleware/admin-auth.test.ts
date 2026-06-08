import { assertEquals } from "jsr:@std/assert@^1";
import { createHmac, createHash } from "node:crypto";

// admin-auth.ts 的 HMAC 签名辅助函数独立导出，方便单测。
// 延迟导入（admin-auth.ts 可能有顶层依赖）。
async function importAuth() {
  return await import("~/middleware/admin-auth.ts");
}

const TOKEN = "test-admin-token-256bit-random-hex";

function sign(opts: {
  token: string;
  timestamp: number;
  method: string;
  path: string;
  body: string;
}): string {
  const bodyHash = createHash("sha256").update(opts.body).digest("hex");
  const message = `${opts.timestamp}.${opts.method}.${opts.path}.${bodyHash}`;
  const hmac = createHmac("sha256", opts.token).update(message).digest("hex");
  return `sha256=${hmac}`;
}

// ── verifyHmacSignature 纯函数测试 ────────────────────────────────────────

Deno.test("verifyHmacSignature: 合法签名通过", async () => {
  const { verifyHmacSignature } = await importAuth();
  const now = Math.floor(Date.now() / 1000);
  const sig = sign({
    token: TOKEN,
    timestamp: now,
    method: "POST",
    path: "/api/v1/admin/tenants",
    body: '{"slug":"test"}',
  });

  const result = verifyHmacSignature({
    token: TOKEN,
    timestamp: now,
    method: "POST",
    path: "/api/v1/admin/tenants",
    body: '{"slug":"test"}',
    signature: sig,
    windowSeconds: 300,
  });
  assertEquals(result.ok, true);
});

Deno.test("verifyHmacSignature: timestamp 超过窗口拒绝", async () => {
  const { verifyHmacSignature } = await importAuth();
  const stale = Math.floor(Date.now() / 1000) - 400;
  const sig = sign({
    token: TOKEN,
    timestamp: stale,
    method: "GET",
    path: "/api/v1/admin/tenants",
    body: "",
  });

  const result = verifyHmacSignature({
    token: TOKEN,
    timestamp: stale,
    method: "GET",
    path: "/api/v1/admin/tenants",
    body: "",
    signature: sig,
    windowSeconds: 300,
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "timestamp_expired");
});

Deno.test("verifyHmacSignature: 签名不匹配拒绝（body 被改）", async () => {
  const { verifyHmacSignature } = await importAuth();
  const now = Math.floor(Date.now() / 1000);
  const sig = sign({
    token: TOKEN,
    timestamp: now,
    method: "POST",
    path: "/api/v1/admin/tenants",
    body: '{"slug":"original"}',
  });

  const result = verifyHmacSignature({
    token: TOKEN,
    timestamp: now,
    method: "POST",
    path: "/api/v1/admin/tenants",
    body: '{"slug":"tampered"}',
    signature: sig,
    windowSeconds: 300,
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "signature_mismatch");
});

Deno.test("verifyHmacSignature: 签名不匹配拒绝（method 被改）", async () => {
  const { verifyHmacSignature } = await importAuth();
  const now = Math.floor(Date.now() / 1000);
  const sig = sign({
    token: TOKEN,
    timestamp: now,
    method: "POST",
    path: "/api/v1/admin/tenants",
    body: "",
  });

  const result = verifyHmacSignature({
    token: TOKEN,
    timestamp: now,
    method: "DELETE",
    path: "/api/v1/admin/tenants",
    body: "",
    signature: sig,
    windowSeconds: 300,
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "signature_mismatch");
});

Deno.test("verifyHmacSignature: sha256= 前缀缺失拒绝", async () => {
  const { verifyHmacSignature } = await importAuth();
  const now = Math.floor(Date.now() / 1000);

  const result = verifyHmacSignature({
    token: TOKEN,
    timestamp: now,
    method: "GET",
    path: "/",
    body: "",
    signature: "badhex1234",
    windowSeconds: 300,
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "signature_mismatch");
});

Deno.test("verifyHmacSignature: 空 body GET 请求可签名", async () => {
  const { verifyHmacSignature } = await importAuth();
  const now = Math.floor(Date.now() / 1000);
  const sig = sign({
    token: TOKEN,
    timestamp: now,
    method: "GET",
    path: "/api/v1/admin/tenants/abc/devices",
    body: "",
  });

  const result = verifyHmacSignature({
    token: TOKEN,
    timestamp: now,
    method: "GET",
    path: "/api/v1/admin/tenants/abc/devices",
    body: "",
    signature: sig,
    windowSeconds: 300,
  });
  assertEquals(result.ok, true);
});
