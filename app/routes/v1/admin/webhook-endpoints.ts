import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { isWebhookEventType } from "~/services/webhooks/events.ts";
import {
  createWebhookEndpoint,
  deactivateWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  type WebhookEndpointRow,
} from "~/services/admin/webhook-endpoints.ts";

/**
 * Webhook 接收端自助註冊 CRUD（取代先前「ops 手動寫 DB」流程）。
 *
 * secret 僅在建立 / 輪換時回傳一次明文；其後任何 GET 都不回傳（DB 內加密儲存）。
 * 刪除為軟刪（isActive=false），保留既有投遞歷史。
 */

const eventTypeArray = z
  .array(
    z.string().refine(isWebhookEventType, {
      message: "未知的事件類型（見 §8.6 事件清單）",
    }),
  )
  .openapi({
    description: "訂閱的事件類型；留空 / 空陣列＝訂閱全部",
    example: ["device.enrolled", "command.completed"],
  });

const webhookEndpointSchema = z
  .object({
    id: z.string().uuid().openapi({ example: "a1b2c3d4-5e6f-7a8b-9c0d-e1f2a3b4c5d6" }),
    tenantId: z.string().uuid(),
    url: z.string().url().openapi({
      description: "接收端 HTTPS URL",
      example: "https://api.tw.example/cogrow/webhook/v1",
    }),
    eventTypes: z.array(z.string()).openapi({
      description: "訂閱事件類型；空陣列＝全訂閱",
    }),
    isActive: z.boolean().openapi({ description: "false＝停用（軟刪後為 false）" }),
    description: z.string().nullable().openapi({ description: "可選備註" }),
    createdAt: z.string().openapi({ description: "ISO 8601 UTC" }),
    updatedAt: z.string().openapi({ description: "ISO 8601 UTC" }),
  })
  .openapi("WebhookEndpoint");

const webhookEndpointWithSecretSchema = webhookEndpointSchema
  .extend({
    secret: z.string().openapi({
      description: "HMAC 簽名密鑰明文。**僅此次回傳一次**，請立即存入密鑰管理；遺失需輪換重發。",
      example: "9f8e7d6c5b4a39281706...",
    }),
  })
  .openapi("WebhookEndpointWithSecret");

const createBody = z
  .object({
    url: z.string().url().openapi({
      description: "接收端 HTTPS URL（建議帶路徑版本）",
      example: "https://api.tw.example/cogrow/webhook/v1",
    }),
    eventTypes: eventTypeArray.optional(),
    description: z.string().max(500).nullable().optional().openapi({ example: "生產環境設備事件" }),
    isActive: z.boolean().optional().openapi({ description: "預設 true" }),
  })
  .openapi("CreateWebhookEndpointInput");

const updateBody = z
  .object({
    url: z.string().url().optional(),
    eventTypes: eventTypeArray.optional(),
    description: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional().openapi({ description: "可重新啟用先前軟刪的端點" }),
  })
  .openapi("UpdateWebhookEndpointInput");

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});
const tenantEndpointParam = tenantParam.extend({
  endpointId: z.string().uuid().openapi({
    param: { name: "endpointId", in: "path" },
    description: "Webhook 端點 UUID",
    example: "a1b2c3d4-5e6f-7a8b-9c0d-e1f2a3b4c5d6",
  }),
});

const security = [{ BearerAuth: [] }];
const TAG = ["Webhook 端點"];

function toDto(row: WebhookEndpointRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    url: row.url,
    eventTypes: (row.eventTypes ?? []) as string[],
    isActive: row.isActive,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const createSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/webhook-endpoints",
  tags: TAG,
  security,
  summary: "註冊 Webhook 接收端（回傳一次性 secret）",
  description: [
    "為 tenant 註冊一個 Webhook 接收端。回應含 `secret` 明文——**僅此一次**，用於驗證推送簽名。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：secret 僅建立時回傳，請立即存入密鑰管理；遺失只能 `rotate-secret` 重發。",
  ].join("\n"),
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: {
      description: "建立成功，回傳端點物件 + 一次性 secret 明文",
      content: {
        "application/json": { schema: successSchema(webhookEndpointWithSecretSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/webhook-endpoints",
  tags: TAG,
  security,
  summary: "列出該 tenant 的 Webhook 端點",
  description: "回傳全部端點（不含 secret）。\n\n**鑑權**：Bearer admin token。",
  request: { params: tenantParam },
  responses: {
    200: {
      description: "端點陣列（不含 secret）",
      content: {
        "application/json": { schema: successSchema(z.array(webhookEndpointSchema)) },
      },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/webhook-endpoints/{endpointId}",
  tags: TAG,
  security,
  summary: "取得單一 Webhook 端點詳情",
  description: "回傳端點資訊（不含 secret）。\n\n**鑑權**：Bearer admin token。",
  request: { params: tenantEndpointParam },
  responses: {
    200: {
      description: "端點物件（不含 secret）",
      content: { "application/json": { schema: successSchema(webhookEndpointSchema) } },
    },
    ...commonErrorResponses,
  },
});

const updateSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/webhook-endpoints/{endpointId}",
  tags: TAG,
  security,
  summary: "更新 Webhook 端點（URL / 訂閱 / 啟停）",
  description: [
    "部分更新端點。可改 `url` / `eventTypes` / `description` / `isActive`（不含 secret，secret 走 rotate-secret）。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: tenantEndpointParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: {
      description: "更新後的端點物件",
      content: { "application/json": { schema: successSchema(webhookEndpointSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/webhook-endpoints/{endpointId}",
  tags: TAG,
  security,
  summary: "停用 Webhook 端點（軟刪）",
  description: [
    "軟刪端點：標記 `isActive=false`，停止投遞但**保留既有投遞歷史**。",
    "需重新啟用可 `PATCH` 設 `isActive=true`。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: { params: tenantEndpointParam },
  responses: {
    204: { description: "停用成功（無回傳 body）" },
    ...commonErrorResponses,
  },
});

const rotateSecretSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/webhook-endpoints/{endpointId}/rotate-secret",
  tags: TAG,
  security,
  summary: "輪換 Webhook secret（回傳一次性新 secret）",
  description: [
    "為端點生成新 secret，舊 secret 立即失效。回應含新 secret 明文——**僅此一次**。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：輪換後，你方需同步更新驗簽用的 secret，否則後續推送驗簽會失敗。",
  ].join("\n"),
  request: { params: tenantEndpointParam },
  responses: {
    200: {
      description: "輪換成功，回傳端點物件 + 一次性新 secret 明文",
      content: {
        "application/json": { schema: successSchema(webhookEndpointWithSecretSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

export const webhookEndpointsAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
webhookEndpointsAdminApp.use("/admin/*", adminAuth());

webhookEndpointsAdminApp.openapi(createSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const { endpoint, secret } = await createWebhookEndpoint({ tenantId, ...body });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "webhook_endpoint.create",
    resourceType: "webhook_endpoint",
    resourceId: endpoint.id,
    // 不記 secret 明文
    payload: { url: body.url, eventTypes: body.eventTypes ?? [] },
  });
  return c.json({ ok: true as const, data: { ...toDto(endpoint), secret } }, 201);
});

webhookEndpointsAdminApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const rows = await listWebhookEndpoints(tenantId);
  return c.json({ ok: true as const, data: rows.map(toDto) }, 200);
});

webhookEndpointsAdminApp.openapi(detailSpec, async (c) => {
  const { tenantId, endpointId } = c.req.valid("param");
  const row = await getWebhookEndpoint({ tenantId, endpointId });
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

webhookEndpointsAdminApp.openapi(updateSpec, async (c) => {
  const { tenantId, endpointId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await updateWebhookEndpoint({ tenantId, endpointId, input: body });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "webhook_endpoint.update",
    resourceType: "webhook_endpoint",
    resourceId: endpointId,
    payload: body as Record<string, unknown>,
  });
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

webhookEndpointsAdminApp.openapi(deleteSpec, async (c) => {
  const { tenantId, endpointId } = c.req.valid("param");
  await deactivateWebhookEndpoint({ tenantId, endpointId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "webhook_endpoint.deactivate",
    resourceType: "webhook_endpoint",
    resourceId: endpointId,
  });
  return c.body(null, 204);
});

webhookEndpointsAdminApp.openapi(rotateSecretSpec, async (c) => {
  const { tenantId, endpointId } = c.req.valid("param");
  const { endpoint, secret } = await rotateWebhookSecret({ tenantId, endpointId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "webhook_endpoint.rotate_secret",
    resourceType: "webhook_endpoint",
    resourceId: endpointId,
  });
  return c.json({ ok: true as const, data: { ...toDto(endpoint), secret } }, 200);
});
