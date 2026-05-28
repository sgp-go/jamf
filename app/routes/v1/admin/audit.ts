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
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  actionPrefix: z.string().optional().openapi({
    description: "前綴過濾，例 'profile.' 抓 profile.* 全部 / 'preset.create_' 抓 W4 preset 建立類",
    example: "profile.",
  }),
  resourceType: z.string().optional(),
  actorPrefix: z.string().optional().openapi({
    description: "actor 前綴，例 'admin:' / 'system' / 'service:'",
  }),
  since: z.string().datetime().optional().openapi({
    description: "ISO 8601；過濾 created_at >= since",
  }),
  until: z.string().datetime().optional().openapi({
    description: "ISO 8601；過濾 created_at < until",
  }),
});

const auditLogSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    actor: z.string(),
    action: z.string(),
    resourceType: z.string(),
    resourceId: z.string().nullable(),
    payload: z.record(z.unknown()).nullable(),
    requestId: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("AuditLog");

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/audit-logs",
  tags: ["Admin: audit"],
  security: [{ BearerAuth: [] }],
  summary: "查詢審計日誌（按 tenant + 過濾 + 分頁，desc created_at）",
  request: { params: tenantParam, query: listQuery },
  responses: {
    200: {
      description: "Audit log list",
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
