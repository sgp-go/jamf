import { randomUUID } from "node:crypto";
import { db } from "~/db/client.ts";
import { webhookDeliveries } from "~/db/schema/webhooks.ts";
import type { WebhookEnvelope, WebhookEventType } from "./events.ts";

/**
 * 業務層觸發事件入口。
 *
 * 流程：
 *  1. 查 tenant 下所有 active webhook_endpoints
 *  2. 按 endpoint.eventTypes 過濾（空 = 訂閱全部）
 *  3. 為每個 matching endpoint 創建一筆 webhook_deliveries（status=pending）
 *  4. 不阻塞業務：實際 HTTP 推送由 scheduler 從 pending 隊列取出非同步處理
 *
 * 同步操作只有 DB insert，極快。失敗（如 DB down）會拋錯讓上游決定怎麼處理
 * （業務通常仍應繼續，webhook 漏了會在死信佇列裡）。
 *
 * eventId 重發場景：上游業務若想保證冪等（如「設備上線」重複觸發），可傳同一
 * eventId。台灣後端用 event_id 去重。
 */
export async function publishEvent<T extends Record<string, unknown>>(opts: {
  tenantId: string;
  eventType: WebhookEventType;
  data: T;
  eventId?: string;
  occurredAt?: Date;
}): Promise<{ deliveryIds: string[]; matched: number }> {
  const endpoints = await db.query.webhookEndpoints.findMany({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.isActive, true)),
    columns: { id: true, eventTypes: true },
  });

  const matching = endpoints.filter((e) => {
    const subscribed = (e.eventTypes as string[] | null) ?? [];
    return subscribed.length === 0 || subscribed.includes(opts.eventType);
  });

  if (matching.length === 0) {
    return { deliveryIds: [], matched: 0 };
  }

  const eventId = opts.eventId ?? randomUUID();
  const occurredAt = opts.occurredAt ?? new Date();

  const rows = matching.map((endpoint) => {
    const deliveryId = randomUUID();
    const envelope: WebhookEnvelope<T> = {
      event_id: eventId,
      delivery_id: deliveryId,
      event_type: opts.eventType,
      occurred_at: occurredAt.toISOString(),
      tenant_id: opts.tenantId,
      data: opts.data,
    };
    return {
      tenantId: opts.tenantId,
      endpointId: endpoint.id,
      eventType: opts.eventType,
      eventId,
      deliveryId,
      payload: envelope as unknown as Record<string, unknown>,
    };
  });

  const inserted = await db
    .insert(webhookDeliveries)
    .values(rows)
    .returning({ deliveryId: webhookDeliveries.deliveryId });

  return {
    deliveryIds: inserted.map((r) => r.deliveryId),
    matched: matching.length,
  };
}
