import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { AppError } from "~/lib/errors.ts";

const HMAC_WINDOW_SECONDS = 300; // ±5 分鐘

/**
 * Bearer token middleware（單一共用 admin token，Phase 3 換正式 user / role）。
 *
 * - `ADMIN_API_TOKEN` 未設：路由直接 503，避免無意間裸奔 admin endpoints
 * - 字串比對用 timingSafeEqual，避免從回應時間側信道判斷正確長度
 *
 * **HMAC 簽名增強**（漸進上線）：
 *   帶 `X-CoGrow-Timestamp` + `X-CoGrow-Signature` 則校驗（防 replay + 防中間人改 body）；
 *   不帶則降級為僅 token 校驗（兼容現有客戶端）。
 *
 * 簽名規格：
 *   message = `{timestamp}.{METHOD}.{path}.{sha256(body)}`
 *   signature = `sha256={HMAC-SHA256(token, message)}`
 */
export const adminAuth = (): MiddlewareHandler => {
  return async (c, next) => {
    const expected = process.env.ADMIN_API_TOKEN;
    if (!expected || expected.length === 0) {
      throw new AppError(
        503,
        "admin_token_not_configured",
        "ADMIN_API_TOKEN is not set on the server",
      );
    }

    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !match[1]) {
      throw new AppError(401, "unauthorized", "Missing Bearer token");
    }
    const presented = match[1];

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(presented, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError(403, "forbidden", "Invalid admin token");
    }

    // HMAC 簽名校驗（可選——漸進上線）
    const tsHeader = c.req.header("x-cogrow-timestamp");
    const sigHeader = c.req.header("x-cogrow-signature");

    if (tsHeader && sigHeader) {
      const timestamp = parseInt(tsHeader, 10);
      if (isNaN(timestamp)) {
        throw new AppError(400, "invalid_timestamp", "X-CoGrow-Timestamp must be a Unix epoch integer");
      }

      const body = await c.req.text();
      const result = verifyHmacSignature({
        token: expected,
        timestamp,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        body,
        signature: sigHeader,
        windowSeconds: HMAC_WINDOW_SECONDS,
      });

      if (!result.ok) {
        const messages: Record<string, string> = {
          timestamp_expired: "Request timestamp outside allowed window (±5 min)",
          signature_mismatch: "HMAC signature verification failed",
        };
        throw new AppError(
          401,
          `hmac_${result.reason}`,
          messages[result.reason] ?? "HMAC verification failed",
        );
      }
    }

    await next();
  };
};

// ── HMAC 純函數（可單測，不依賴 Hono context）──────────────────────────────

export interface HmacVerifyInput {
  token: string;
  timestamp: number;
  method: string;
  path: string;
  body: string;
  signature: string;
  windowSeconds: number;
}

export type HmacVerifyResult =
  | { ok: true }
  | { ok: false; reason: "timestamp_expired" | "signature_mismatch" };

export function verifyHmacSignature(input: HmacVerifyInput): HmacVerifyResult {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - input.timestamp) > input.windowSeconds) {
    return { ok: false, reason: "timestamp_expired" };
  }

  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const message = `${input.timestamp}.${input.method}.${input.path}.${bodyHash}`;
  const expected = createHmac("sha256", input.token)
    .update(message)
    .digest("hex");

  const sigMatch = /^sha256=(.+)$/.exec(input.signature);
  if (!sigMatch) {
    return { ok: false, reason: "signature_mismatch" };
  }

  const presentedBuf = Buffer.from(sigMatch[1], "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");

  if (presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}
