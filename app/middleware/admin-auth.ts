import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { AppError } from "~/lib/errors.ts";

/**
 * Bearer token middleware（單一共用 admin token，Phase 3 換正式 user / role）。
 *
 * - `ADMIN_API_TOKEN` 未設：路由直接 503，避免無意間裸奔 admin endpoints
 * - 字串比對用 timingSafeEqual，避免從回應時間側信道判斷正確長度
 *
 * 在 OpenAPI 規格中該路由群應標 `security: [{ BearerAuth: [] }]`，
 * 由 OpenAPIHono 在 createRoute 時聲明（見 admin/*.ts）。
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

    await next();
  };
};
