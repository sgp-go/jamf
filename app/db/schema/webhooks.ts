import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.ts";

/**
 * Webhook delivery 狀態機：
 *   pending   → 排隊待送
 *   delivered → HTTP 2xx 成功
 *   failed    → 暫時失敗，等下一輪重試
 *   dead      → 重試次數耗盡，進死信佇列（可手動補推）
 */
export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "delivered",
  "failed",
  "dead",
]);

/**
 * 上游業務系統（如台灣後端）註冊的 webhook 接收端。
 * 一個 tenant 可有多筆（按事件類型分流，或多副本）。
 *
 * secret: 用於計算 HMAC-SHA256(timestamp + "." + body) 簽名，避免偽造。
 * event_types: jsonb 陣列；空陣列代表訂閱全部事件。
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    url: text().notNull(),
    secret: text().notNull(),
    eventTypes: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isActive: boolean().notNull().default(true),
    description: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("webhook_endpoints_tenant_idx").on(t.tenantId),
    index("webhook_endpoints_active_idx").on(t.isActive),
  ],
);

/**
 * 每次推送的記錄：含 payload、重試狀態、HTTP 回應、死信標記。
 *
 * event_id: 上游業務事件穩定 ID（重試時相同），對應 webhook receiver 可作冪等鍵。
 * delivery_id: 每次嘗試唯一（attempt 1 / 2 / 3 各有自己的 delivery_id）。
 * payload: 完整推送出去的 JSON body（含 envelope 與 data）。
 * response_*: 最後一次 HTTP 嘗試的結果。
 * next_retry_at: pending/failed 才有意義；delivered/dead 為 null。
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid()
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventType: varchar({ length: 64 }).notNull(),
    eventId: uuid().notNull(),
    deliveryId: uuid().notNull().defaultRandom(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: webhookDeliveryStatusEnum().notNull().default("pending"),
    attemptCount: integer().notNull().default(0),
    responseStatus: integer(),
    responseBody: text(),
    responseHeaders: jsonb().$type<Record<string, string>>(),
    errorMessage: text(),
    lastAttemptAt: timestamp({ withTimezone: true }),
    nextRetryAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("webhook_deliveries_endpoint_status_idx").on(t.endpointId, t.status),
    index("webhook_deliveries_status_retry_idx").on(t.status, t.nextRetryAt),
    index("webhook_deliveries_tenant_idx").on(t.tenantId),
    uniqueIndex("webhook_deliveries_delivery_id_uq").on(t.deliveryId),
    index("webhook_deliveries_event_id_idx").on(t.eventId),
  ],
);

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
