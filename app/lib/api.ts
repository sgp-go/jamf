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
    description: "租戶 UUID（從 POST /admin/tenants 建立或 GET /admin/tenants 列表取得）",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

export const deviceIdParam = tenantIdParam.extend({
  deviceId: z.string().uuid().openapi({
    param: { name: "deviceId", in: "path" },
    description: "設備 UUID（從 GET /tenants/{tenantId}/devices 列表取得）",
    example: "9d4c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c",
  }),
});

export const deviceGroupIdParam = tenantIdParam.extend({
  deviceGroupId: z.string().uuid().openapi({
    param: { name: "deviceGroupId", in: "path" },
    description: "設備分組 UUID（從 GET /admin/tenants/{tenantId}/device-groups 列表取得）",
    example: "a1b2c3d4-5e6f-7a8b-9c0d-e1f2a3b4c5d6",
  }),
});

export const serialNumberParam = tenantIdParam.extend({
  serialNumber: z.string().min(1).openapi({
    param: { name: "serialNumber", in: "path" },
    description: "設備序號（Apple Serial Number 或 Windows 序號）",
    example: "F2L1234567",
  }),
});

export const instanceIdParam = z.object({
  instanceId: z.string().uuid().openapi({
    param: { name: "instanceId", in: "path" },
    description: "Jamf 實例 UUID",
    example: "00000000-0000-0000-0000-000000000002",
  }),
});

export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1).openapi({
    description: "頁碼（從 1 起算）",
    example: 1,
  }),
  limit: z.coerce.number().int().positive().max(200).default(50).openapi({
    description: "每頁筆數（最大 200）",
    example: 50,
  }),
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
