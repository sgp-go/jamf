import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  eventLog,
  type EventLog,
  webhookDeliveries,
  type WebhookDelivery,
} from "~/db/schema/webhooks.ts";

/**
 * Webhook 可觀測性查詢層（read-only）。
 *
 * 兩條主鏈路供 admin UI 調試 webhook 配置：
 * - event_log：每次 publishEvent 的權威記錄（含 matched=0 的「沒訂閱者」事件）
 * - webhook_deliveries：實際投遞嘗試（含 pending/failed/dead 重試狀態）
 *
 * 設計取捨（對齊 [[audit.ts]] listAuditLogs）：
 * - 查詢一律 core query db.select；不用 findMany（per project memory：findMany
 *   對 list 慢數秒）
 * - rows + count 並行；count 走同一 where 確保分頁 total 準確
 * - desc createdAt：最近的事件/投遞排最前，調試時先看新的
 */

export interface ListEventLogOptions {
  tenantId: string;
  page: number;
  limit: number;
  /** 過濾：event_type 完全相等（如 "command.completed"） */
  eventType?: string;
  /** 過濾：event_id 完全相等（追單一事件跨 event_log + deliveries） */
  eventId?: string;
  /**
   * 過濾：只看沒訂閱者的事件（matched_endpoint_count = 0）。
   * 調試「事件發了但沒人收」最直接的入口。
   */
  unmatchedOnly?: boolean;
  /** 過濾：created_at >= since */
  since?: Date;
  /** 過濾：created_at < until */
  until?: Date;
}

export interface ListEventLogResult {
  rows: EventLog[];
  total: number;
}

export async function listEventLog(opts: ListEventLogOptions): Promise<ListEventLogResult> {
  const conditions: SQL[] = [eq(eventLog.tenantId, opts.tenantId)];

  if (opts.eventType) {
    conditions.push(eq(eventLog.eventType, opts.eventType));
  }
  if (opts.eventId) {
    conditions.push(eq(eventLog.eventId, opts.eventId));
  }
  if (opts.unmatchedOnly) {
    conditions.push(eq(eventLog.matchedEndpointCount, 0));
  }
  if (opts.since) {
    conditions.push(gte(eventLog.createdAt, opts.since));
  }
  if (opts.until) {
    conditions.push(lt(eventLog.createdAt, opts.until));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(eventLog)
      .where(where)
      .orderBy(desc(eventLog.createdAt))
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db.select({ value: sql<number>`count(*)` }).from(eventLog).where(where),
  ]);

  return { rows, total: Number(totalRows[0]?.value ?? 0) };
}

export interface ListWebhookDeliveriesOptions {
  tenantId: string;
  page: number;
  limit: number;
  /** 過濾：status 完全相等（pending / delivered / failed / dead） */
  status?: WebhookDelivery["status"];
  /** 過濾：endpoint_id 完全相等（看單一接收端的投遞歷史） */
  endpointId?: string;
  /** 過濾：event_type 完全相等 */
  eventType?: string;
  /** 過濾：event_id 完全相等（追單一事件的所有投遞嘗試） */
  eventId?: string;
  /** 過濾：created_at >= since */
  since?: Date;
  /** 過濾：created_at < until */
  until?: Date;
}

export interface ListWebhookDeliveriesResult {
  rows: WebhookDelivery[];
  total: number;
}

export async function listWebhookDeliveries(
  opts: ListWebhookDeliveriesOptions,
): Promise<ListWebhookDeliveriesResult> {
  const conditions: SQL[] = [eq(webhookDeliveries.tenantId, opts.tenantId)];

  if (opts.status) {
    conditions.push(eq(webhookDeliveries.status, opts.status));
  }
  if (opts.endpointId) {
    conditions.push(eq(webhookDeliveries.endpointId, opts.endpointId));
  }
  if (opts.eventType) {
    conditions.push(eq(webhookDeliveries.eventType, opts.eventType));
  }
  if (opts.eventId) {
    conditions.push(eq(webhookDeliveries.eventId, opts.eventId));
  }
  if (opts.since) {
    conditions.push(gte(webhookDeliveries.createdAt, opts.since));
  }
  if (opts.until) {
    conditions.push(lt(webhookDeliveries.createdAt, opts.until));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(webhookDeliveries)
      .where(where)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db.select({ value: sql<number>`count(*)` }).from(webhookDeliveries).where(where),
  ]);

  return { rows, total: Number(totalRows[0]?.value ?? 0) };
}
