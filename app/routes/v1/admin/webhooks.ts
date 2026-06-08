import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  listEventLog,
  listWebhookDeliveries,
} from "~/services/admin/webhooks.ts";

/**
 * Webhook 可觀測性端點（read-only）— W5 admin UI 基建。
 *
 * 兩條鏈路：
 * - /event-log：每次 publishEvent 的權威記錄（含 matched=0 沒訂閱者的事件）→
 *   調試「事件到底發了沒」
 * - /webhook-deliveries：實際投遞嘗試 + 重試狀態（pending/failed/dead）→
 *   調試「投遞成功了沒 / 卡在哪」
 *
 * 寫入由 publisher.ts（event_log）/ dispatcher.ts（deliveries）負責；此處只讀。
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

// ─────────────────────────── event_log ───────────────────────────

const eventLogQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  eventType: z.string().optional().openapi({
    description: "事件類型完全匹配，例 'command.completed' / 'device.enrolled'",
    example: "command.completed",
  }),
  eventId: z.string().uuid().optional().openapi({
    description: "追單一事件：同 event_id 可跨 event_log（1 行）+ webhook_deliveries（N 行）對齊",
  }),
  unmatchedOnly: z.coerce.boolean().optional().openapi({
    description: "只看沒訂閱者的事件（matched_endpoint_count = 0）— 調試「發了但沒人收」",
  }),
  since: z.string().datetime().optional().openapi({
    description: "ISO 8601；過濾 created_at >= since",
  }),
  until: z.string().datetime().optional().openapi({
    description: "ISO 8601；過濾 created_at < until",
  }),
});

const eventLogSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    eventType: z.string(),
    eventId: z.string().uuid(),
    payload: z.record(z.unknown()),
    matchedEndpointCount: z.number().int(),
    occurredAt: z.string(),
    createdAt: z.string(),
  })
  .openapi("EventLogEntry");

const listEventLogSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/event-log",
  tags: ["Webhook 監控"],
  security: [{ BearerAuth: [] }],
  summary: "查詢事件發布記錄（含沒訂閱者的事件）",
  description: [
    "回傳 `publishEvent()` 記錄的所有事件，包含沒有任何訂閱者的事件（`matchedEndpointCount = 0`）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**用途**：調試「事件到底發了沒」。搭配 `/webhook-deliveries` 可追蹤從事件發布到投遞的完整鏈路。",
    "",
    "**追蹤單一事件**：傳 `eventId` 可跨 event_log（1 行）+ webhook_deliveries（N 行）對齊。",
  ].join("\n"),
  request: { params: tenantParam, query: eventLogQuery },
  responses: {
    200: {
      description: "事件記錄陣列（含分頁 meta）",
      content: {
        "application/json": {
          schema: successSchema(z.array(eventLogSchema)).extend({
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

// ─────────────────────── webhook_deliveries ───────────────────────

const deliveriesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(["pending", "delivered", "failed", "dead"]).optional().openapi({
    description: "投遞狀態：pending 排隊 / delivered 成功 / failed 待重試 / dead 死信",
  }),
  endpointId: z.string().uuid().optional().openapi({
    description: "只看單一接收端的投遞歷史",
  }),
  eventType: z.string().optional().openapi({ example: "command.completed" }),
  eventId: z.string().uuid().optional().openapi({
    description: "追單一事件的所有投遞嘗試（每個 endpoint 一行）",
  }),
  since: z.string().datetime().optional().openapi({
    description: "ISO 8601；過濾 created_at >= since",
  }),
  until: z.string().datetime().optional().openapi({
    description: "ISO 8601；過濾 created_at < until",
  }),
});

const deliverySchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    endpointId: z.string().uuid(),
    eventType: z.string(),
    eventId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    payload: z.record(z.unknown()),
    status: z.enum(["pending", "delivered", "failed", "dead"]),
    attemptCount: z.number().int(),
    responseStatus: z.number().int().nullable(),
    responseBody: z.string().nullable(),
    errorMessage: z.string().nullable(),
    lastAttemptAt: z.string().nullable(),
    nextRetryAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("WebhookDeliveryEntry");

const listDeliveriesSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/webhook-deliveries",
  tags: ["Webhook 監控"],
  security: [{ BearerAuth: [] }],
  summary: "查詢 webhook 投遞記錄（含重試 / 死信狀態）",
  description: [
    "回傳實際的 webhook 投遞嘗試記錄。每個事件 × 每個接收端點 = 一行 delivery。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**用途**：調試「投遞成功了沒 / 卡在哪」。",
    "",
    "**狀態流轉**：`pending`（排隊中）→ `delivered`（成功）/ `failed`（待重試，30s/5min/30min 三段退避）→ `dead`（超過重試次數）。",
  ].join("\n"),
  request: { params: tenantParam, query: deliveriesQuery },
  responses: {
    200: {
      description: "投遞記錄陣列（含分頁 meta）",
      content: {
        "application/json": {
          schema: successSchema(z.array(deliverySchema)).extend({
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

// ─────────────────────────── app ───────────────────────────

export const webhooksAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
webhooksAdminApp.use("/admin/*", adminAuth());

webhooksAdminApp.openapi(listEventLogSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const q = c.req.valid("query");
  const { rows, total } = await listEventLog({
    tenantId,
    page: q.page,
    limit: q.limit,
    eventType: q.eventType,
    eventId: q.eventId,
    unmatchedOnly: q.unmatchedOnly,
    since: q.since ? new Date(q.since) : undefined,
    until: q.until ? new Date(q.until) : undefined,
  });

  return c.json(
    {
      ok: true as const,
      data: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        eventType: r.eventType,
        eventId: r.eventId,
        payload: r.payload,
        matchedEndpointCount: r.matchedEndpointCount,
        occurredAt: r.occurredAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      meta: { total, page: q.page, limit: q.limit },
    },
    200,
  );
});

webhooksAdminApp.openapi(listDeliveriesSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const q = c.req.valid("query");
  const { rows, total } = await listWebhookDeliveries({
    tenantId,
    page: q.page,
    limit: q.limit,
    status: q.status,
    endpointId: q.endpointId,
    eventType: q.eventType,
    eventId: q.eventId,
    since: q.since ? new Date(q.since) : undefined,
    until: q.until ? new Date(q.until) : undefined,
  });

  return c.json(
    {
      ok: true as const,
      data: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        endpointId: r.endpointId,
        eventType: r.eventType,
        eventId: r.eventId,
        deliveryId: r.deliveryId,
        payload: r.payload,
        status: r.status,
        attemptCount: r.attemptCount,
        responseStatus: r.responseStatus,
        responseBody: r.responseBody,
        errorMessage: r.errorMessage,
        lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
        nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
        deliveredAt: r.deliveredAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      meta: { total, page: q.page, limit: q.limit },
    },
    200,
  );
});
