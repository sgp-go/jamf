import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * 跨層級的應用錯誤型別。
 * - 在 service 拋出，由 server.ts onError 統一格式化成 ApiError JSON
 * - code 用穩定的 snake_case，前端可以對 code switch
 */
export class AppError extends Error {
  override name = "AppError";

  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class JamfUpstreamError extends AppError {
  override name = "JamfUpstreamError";

  constructor(
    upstreamStatus: number,
    public readonly url: string,
    public readonly upstreamBody: unknown,
  ) {
    super(
      (upstreamStatus >= 400 && upstreamStatus < 600
        ? upstreamStatus
        : 502) as ContentfulStatusCode,
      "jamf_upstream_error",
      `Jamf upstream returned ${upstreamStatus}`,
      { url, upstreamBody },
    );
  }
}
