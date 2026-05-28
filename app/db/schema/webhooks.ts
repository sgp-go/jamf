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

/**
 * Event log — 記錄每次 publishEvent 調用（無論是否有 endpoint 匹配）。
 *
 * 為什麼存在：webhook_deliveries 只在 endpoint 匹配時才有行；endpoint 為空或
 * 過濾後 matched=0 時 publishEvent 完全靜默。dev/test 無法區分「事件根本沒
 * 發出」vs「發了但沒訂閱者」。event_log 提供權威記錄：發了的事件都在這裡，
 * 不論最終投遞到幾個 endpoint。
 *
 * 與 webhook_deliveries 透過 event_id 對齊；同 event_id 可有 N 行 deliveries
 *（每個 endpoint 一行）+ 1 行 event_log。
 *
 * 保留週期：跟 webhook_deliveries 同（後續 W4/W5 加 retention job 時統一處理）。
 */
export const eventLog = pgTable(
  "event_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    eventType: varchar({ length: 64 }).notNull(),
    eventId: uuid().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** publishEvent 計算出有幾個 endpoint 匹配；0 = 完全沒訂閱者 */
    matchedEndpointCount: integer().notNull().default(0),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("event_log_tenant_idx").on(t.tenantId),
    index("event_log_event_id_idx").on(t.eventId),
    index("event_log_type_created_idx").on(t.eventType, t.createdAt),
  ],
);

export type EventLog = typeof eventLog.$inferSelect;
export type NewEventLog = typeof eventLog.$inferInsert;
