import { z } from "@hono/zod-openapi";

/**
 * 統一 API 信封格式。
 * 成功：{ ok: true, data }
 * 失敗：{ ok: false, error: { code, message, details? } }
 *
 * 用單一信封而非裸 data，是為了 OpenAPI 上能描述穩定的錯誤型別、
 * 並讓客戶端不必每個端點重寫一次錯誤分支。
 */

export const errorSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().openapi({ example: "validation_failed" }),
      message: z.string().openapi({ example: "Invalid input" }),
      details: z.unknown().optional(),
    }),
  })
  .openapi("ApiError");

export function successSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    ok: z.literal(true),
    data,
  });
}

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    ok: z.literal(true),
    data: z.array(item),
    meta: z.object({
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      limit: z.number().int().positive(),
    }),
  });
}

export const tenantIdParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

export const instanceIdParam = z.object({
  instanceId: z.string().uuid().openapi({
    param: { name: "instanceId", in: "path" },
    example: "00000000-0000-0000-0000-000000000002",
  }),
});

export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1).openapi({ example: 1 }),
  limit: z.coerce.number().int().positive().max(200).default(50).openapi({ example: 50 }),
});

export const commonErrorResponses = {
  400: {
    description: "Validation failed",
    content: { "application/json": { schema: errorSchema } },
  },
  401: {
    description: "Unauthenticated",
    content: { "application/json": { schema: errorSchema } },
  },
  403: {
    description: "Forbidden / tenant mismatch",
    content: { "application/json": { schema: errorSchema } },
  },
  404: {
    description: "Not found",
    content: { "application/json": { schema: errorSchema } },
  },
  502: {
    description: "Upstream error (e.g. Jamf)",
    content: { "application/json": { schema: errorSchema } },
  },
} as const;
