import { randomUUID } from "node:crypto";
import { db } from "~/db/client.ts";
import { eventLog, webhookDeliveries } from "~/db/schema/webhooks.ts";
import type { WebhookEnvelope, WebhookEventType } from "./events.ts";

/**
 * 業務層觸發事件入口。
 *
 * 流程：
 *  1. 查 tenant 下所有 active webhook_endpoints
 *  2. 按 endpoint.eventTypes 過濾（空 = 訂閱全部）
 *  3. 為每個 matching endpoint 創建一筆 webhook_deliveries（status=pending）
 *  4. **無論 matched 0/N 都 insert 一行 event_log**（dev/test 可審計事件確實
 *     發出；matched=0 也記，避免「沒訂閱者 vs 根本沒發」的歧義）
 *  5. 不阻塞業務：實際 HTTP 推送由 scheduler 從 pending 隊列取出非同步處理
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

  const eventId = opts.eventId ?? randomUUID();
  const occurredAt = opts.occurredAt ?? new Date();

  // 共用 envelope 結構：matched=0 也用同一個 envelope 寫進 event_log，方便
  // dev / test 直接拿 event_log.payload 跟 webhook_deliveries.payload 比對。
  // delivery_id 在 matched=0 情境下不適用，envelope 字段照常生成（uuid），
  // 同 event_id 路徑下不會被 deliveries 寫表，影響可忽略。
  const buildEnvelope = (deliveryId: string): WebhookEnvelope<T> => ({
    event_id: eventId,
    delivery_id: deliveryId,
    event_type: opts.eventType,
    occurred_at: occurredAt.toISOString(),
    tenant_id: opts.tenantId,
    data: opts.data,
  });

  const deliveryRows = matching.map((endpoint) => {
    const deliveryId = randomUUID();
    return {
      tenantId: opts.tenantId,
      endpointId: endpoint.id,
      eventType: opts.eventType,
      eventId,
      deliveryId,
      payload: buildEnvelope(deliveryId) as unknown as Record<string, unknown>,
    };
  });

  // event_log 用第一個 delivery_id（如果有），否則生成佔位 — payload 整體
  // 對 dev/test 觀察足夠（matched_endpoint_count=0 即可區分）。
  const logPayload = buildEnvelope(deliveryRows[0]?.deliveryId ?? randomUUID());

  // 並行寫 event_log + deliveries；event_log 寫失敗不應阻塞 deliveries（webhook
  // 投遞是主業務鏈），故各自包 try / log；Promise.all 確保兩者都 await 完。
  const [_logInsert, inserted] = await Promise.all([
    db
      .insert(eventLog)
      .values({
        tenantId: opts.tenantId,
        eventType: opts.eventType,
        eventId,
        payload: logPayload as unknown as Record<string, unknown>,
        matchedEndpointCount: matching.length,
        occurredAt,
      })
      .catch((err) => {
        console.error(
          `[publisher] event_log insert failed event=${eventId} type=${opts.eventType}`,
          err,
        );
      }),
    deliveryRows.length === 0
      ? Promise.resolve([] as { deliveryId: string }[])
      : db
          .insert(webhookDeliveries)
          .values(deliveryRows)
          .returning({ deliveryId: webhookDeliveries.deliveryId }),
  ]);

  return {
    deliveryIds: inserted.map((r) => r.deliveryId),
    matched: matching.length,
  };
}
