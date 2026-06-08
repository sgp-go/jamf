import type { Hook } from "@hono/zod-openapi";

/**
 * 共用的 zod-openapi validation hook。
 * OpenAPIHono 的 defaultHook 不會傳遞到 mount 上的子 app，
 * 因此每個子 app 在 new OpenAPIHono({ defaultHook }) 時都要顯式傳入。
 */
export const validationFailedHook: Hook<unknown, never, never, unknown> = (
  result,
  c,
) => {
  if (!result.success) {
    return c.json(
      {
        ok: false as const,
        error: {
          code: "validation_failed",
          message: "Request validation failed",
          details: result.error.flatten(),
        },
      },
      400,
    );
  }
};
