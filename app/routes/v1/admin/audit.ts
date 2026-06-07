import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { listAuditLogs } from "~/services/admin/audit.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/audit-logs
 *
 * Read-only 審計日誌查詢。寫入由各 admin route 自行調用 logAudit / extractAuditMeta。
 * CSV 匯出待 admin UI 接 + 大量資料才需要，暫不做。
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({
    description: "頁碼（從 1 起算）",
    example: 1,
  }),
  limit: z.coerce.number().int().min(1).max(200).default(50).openapi({
    description: "每頁筆數（最大 200）",
    example: 50,
  }),
  actionPrefix: z.string().optional().openapi({
    description: "前綴過濾，例 `profile.` 抓 profile.* 全部 / `preset.create_` 抓 preset 建立類",
    example: "profile.",
  }),
  resourceType: z.string().optional().openapi({
    description: "資源類型過濾（完全匹配），例 `device` / `tenant` / `profile`",
    example: "device",
  }),
  actorPrefix: z.string().optional().openapi({
    description: "操作者前綴過濾，例 `admin:` / `system` / `service:`",
    example: "admin:",
  }),
  since: z.string().datetime().optional().openapi({
    description: "起始時間（ISO 8601 UTC），過濾 created_at >= since",
    example: "2026-06-01T00:00:00Z",
  }),
  until: z.string().datetime().optional().openapi({
    description: "結束時間（ISO 8601 UTC），過濾 created_at < until",
    example: "2026-06-07T00:00:00Z",
  }),
});

const auditLogSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    actor: z.string().openapi({
      description: "操作者識別（格式：`admin:<ip>` / `system` / `service:<name>`）",
      example: "admin:203.0.113.1",
    }),
    action: z.string().openapi({
      description: "動作名稱（格式：`resource.verb`）",
      example: "device.laps_password_viewed",
    }),
    resourceType: z.string().openapi({
      description: "被操作的資源類型",
      example: "device",
    }),
    resourceId: z.string().nullable().openapi({
      description: "被操作的資源 UUID（部分動作無特定資源時為 null）",
    }),
    payload: z.record(z.unknown()).nullable().openapi({
      description: "動作相關的附加資料（JSON 物件）",
    }),
    requestId: z.string().nullable().openapi({
      description: "HTTP 請求追蹤 ID（如有）",
    }),
    ip: z.string().nullable().openapi({
      description: "請求來源 IP",
      example: "203.0.113.1",
    }),
    userAgent: z.string().nullable().openapi({
      description: "HTTP User-Agent",
    }),
    createdAt: z.string().openapi({ description: "ISO 8601 UTC" }),
  })
  .openapi("AuditLog");

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/audit-logs",
  tags: ["審計日誌"],
  security: [{ BearerAuth: [] }],
  summary: "查詢審計日誌（分頁 + 多維過濾，desc created_at）",
  description: [
    "回傳指定 tenant 的審計日誌，按 `created_at` 降序排列。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**過濾維度**：可組合使用 `actionPrefix`、`resourceType`、`actorPrefix`、`since`/`until`。",
    "所有過濾條件為 AND 關係。",
    "",
    "**寫入方式**：此端點唯讀；日誌由各 admin 端點內部自動調用 `logAudit()` 寫入。",
  ].join("\n"),
  request: { params: tenantParam, query: listQuery },
  responses: {
    200: {
      description: "審計日誌陣列（含分頁 meta）",
      content: {
        "application/json": {
          schema: successSchema(z.array(auditLogSchema)).extend({
            meta: z.object({
              total: z.number().int(),
              page: z.number().int(),
              limit: z.number().int(),
            }),
          }),
        },
      },
    },
    ...commonErrorResponses,
  },
});

export const auditAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
auditAdminApp.use("/admin/*", adminAuth());

auditAdminApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const q = c.req.valid("query");
  const { rows, total } = await listAuditLogs({
    tenantId,
    page: q.page,
    limit: q.limit,
    actionPrefix: q.actionPrefix,
    resourceType: q.resourceType,
    actorPrefix: q.actorPrefix,
    since: q.since ? new Date(q.since) : undefined,
    until: q.until ? new Date(q.until) : undefined,
  });

  return c.json(
    {
      ok: true as const,
      data: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        actor: r.actor,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        payload: r.payload,
        requestId: r.requestId,
        ip: r.ip,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
      })),
      meta: { total, page: q.page, limit: q.limit },
    },
    200,
  );
});
