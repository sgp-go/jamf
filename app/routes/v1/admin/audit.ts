import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  EXPORT_MAX_ROWS,
  extractAuditMeta,
  listAuditLogs,
  listAuditLogsExport,
  logAudit,
} from "~/services/admin/audit.ts";
import { CSV_UTF8_BOM, toCsvRow } from "~/lib/csv.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/audit-logs
 * /api/v1/admin/tenants/{tenantId}/audit-logs/export.csv
 *
 * Read-only 審計日誌查詢 + CSV 匯出。寫入由各 admin route 自行調用
 * logAudit / extractAuditMeta。
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

const exportQuery = listQuery.omit({ page: true, limit: true });

const CSV_HEADER = [
  "id",
  "createdAt",
  "actor",
  "action",
  "resourceType",
  "resourceId",
  "ip",
  "userAgent",
  "requestId",
  "payload",
];

const exportSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/audit-logs/export.csv",
  tags: ["審計日誌"],
  security: [{ BearerAuth: [] }],
  summary: "匯出審計日誌 CSV（同查詢過濾維度）",
  description: [
    "把符合過濾條件的審計日誌匯出為 CSV 檔（UTF-8 含 BOM，Excel 可直接開），按 `created_at` 降序。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    `- 單次匯出上限 ${EXPORT_MAX_ROWS.toLocaleString("en-US")} 筆；超過時回應 header \`X-Export-Truncated: true\`，請用 \`since\`/\`until\` 縮小範圍分段匯出`,
    "- `until` 未傳時以請求當下時間封頂（保證匯出期間新寫入不影響結果一致性）",
    "- `payload` 欄位為 JSON 字串",
    "- 匯出行為本身會寫一條 `audit.exported` 審計紀錄",
  ].join("\n"),
  request: { params: tenantParam, query: exportQuery },
  responses: {
    200: {
      description:
        "CSV 文本（欄位：id,createdAt,actor,action,resourceType,resourceId,ip,userAgent,requestId,payload）",
      content: {
        "text/csv": {
          schema: z.string().openapi({
            description: "RFC 4180 CSV，首行為欄位名，UTF-8 含 BOM",
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

auditAdminApp.openapi(exportSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const q = c.req.valid("query");
  // until 以請求當下封頂：audit 為 append-only + desc 排序，無上界時匯出
  // 期間的新寫入會讓批次 offset 位移產生重複列
  const until = q.until ? new Date(q.until) : new Date();

  const { rows, truncated } = await listAuditLogsExport({
    tenantId,
    actionPrefix: q.actionPrefix,
    resourceType: q.resourceType,
    actorPrefix: q.actorPrefix,
    since: q.since ? new Date(q.since) : undefined,
    until,
  });

  const lines = [toCsvRow(CSV_HEADER)];
  for (const r of rows) {
    lines.push(
      toCsvRow([
        r.id,
        r.createdAt.toISOString(),
        r.actor,
        r.action,
        r.resourceType,
        r.resourceId,
        r.ip,
        r.userAgent,
        r.requestId,
        r.payload === null ? null : JSON.stringify(r.payload),
      ]),
    );
  }
  const csv = CSV_UTF8_BOM + lines.join("\r\n") + "\r\n";

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "audit.exported",
    resourceType: "tenant",
    resourceId: tenantId,
    payload: {
      rowCount: rows.length,
      truncated,
      filters: {
        actionPrefix: q.actionPrefix ?? null,
        resourceType: q.resourceType ?? null,
        actorPrefix: q.actorPrefix ?? null,
        since: q.since ?? null,
        until: until.toISOString(),
      },
    },
  });

  const stamp = until.toISOString().slice(0, 10);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="audit-logs-${stamp}.csv"`,
  );
  if (truncated) c.header("X-Export-Truncated", "true");
  return c.body(csv, 200);
});
