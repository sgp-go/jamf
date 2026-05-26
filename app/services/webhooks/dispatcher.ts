import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { webhookDeliveries, webhookEndpoints } from "~/db/schema/webhooks.ts";
import { signWebhookPayload } from "./signature.ts";

/**
 * 重試時間表（秒）。
 * 失敗第 N 次後等 RETRY_DELAYS_SECONDS[N-1] 秒再試。
 * 超過陣列長度即進入死信。
 *
 *   attempt 1 失敗 → 30 秒後 retry
 *   attempt 2 失敗 → 5 分鐘後 retry
 *   attempt 3 失敗 → 30 分鐘後 retry
 *   attempt 4 失敗 → 標 dead
 */
export const RETRY_DELAYS_SECONDS = [30, 5 * 60, 30 * 60];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** HTTP 推送超時（ms）。設備端如 15s 還沒回應就視為失敗。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** Response body 截斷長度，避免無限長 body 灌爆 DB。 */
const RESPONSE_BODY_MAX_BYTES = 4096;

export interface DispatchResult {
  deliveryId: string;
  status: "delivered" | "failed" | "dead";
  attemptCount: number;
  httpStatus?: number;
}

/**
 * 單次嘗試推送一筆 delivery。
 *
 * 流程：
 *   1. 找 delivery 與對應 endpoint
 *   2. 簽 HMAC（base: timestamp + "." + body）
 *   3. POST + Headers
 *   4. 2xx → delivered；非 2xx 或網路錯誤 → 進 retry / dead
 *
 * 不拋錯：失敗都記錄到 DB（webhook_deliveries.errorMessage / responseStatus）。
 * 拋錯只發生在「delivery 不存在」「endpoint 不存在」「DB 異常」等系統級錯誤。
 */
export async function dispatchDelivery(deliveryId: string): Promise<DispatchResult> {
  const delivery = await db.query.webhookDeliveries.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, deliveryId),
  });
  if (!delivery) {
    throw new Error(`webhook delivery ${deliveryId} not found`);
  }
  if (delivery.status === "delivered" || delivery.status === "dead") {
    return {
      deliveryId: delivery.deliveryId,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      httpStatus: delivery.responseStatus ?? undefined,
    };
  }

  const endpoint = await db.query.webhookEndpoints.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, delivery.endpointId),
  });
  if (!endpoint) {
    throw new Error(`webhook endpoint ${delivery.endpointId} not found`);
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload({
    secret: endpoint.secret,
    timestamp,
    body,
  });

  const attemptCount = delivery.attemptCount + 1;
  let httpStatus: number | undefined;
  let responseBody: string | undefined;
  let responseHeaders: Record<string, string> | undefined;
  let errorMessage: string | undefined;

  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "CoGrow-Webhook/1.0",
        "X-CoGrow-Event": delivery.eventType,
        "X-CoGrow-Delivery": delivery.deliveryId,
        "X-CoGrow-Timestamp": String(timestamp),
        "X-CoGrow-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    httpStatus = response.status;
    responseHeaders = Object.fromEntries(response.headers.entries());
    try {
      const text = await response.text();
      responseBody = text.length > RESPONSE_BODY_MAX_BYTES
        ? text.slice(0, RESPONSE_BODY_MAX_BYTES)
        : text;
    } catch {
      responseBody = "";
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const ok = httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300;
  const now = new Date();

  if (ok) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        attemptCount,
        responseStatus: httpStatus ?? null,
        responseBody,
        responseHeaders,
        lastAttemptAt: now,
        deliveredAt: now,
        nextRetryAt: null,
        errorMessage: null,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return {
      deliveryId: delivery.deliveryId,
      status: "delivered",
      attemptCount,
      httpStatus,
    };
  }

  if (attemptCount >= MAX_ATTEMPTS) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "dead",
        attemptCount,
        responseStatus: httpStatus ?? null,
        responseBody,
        responseHeaders,
        lastAttemptAt: now,
        nextRetryAt: null,
        errorMessage,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return {
      deliveryId: delivery.deliveryId,
      status: "dead",
      attemptCount,
      httpStatus,
    };
  }

  const delaySec = RETRY_DELAYS_SECONDS[attemptCount - 1] ?? 60;
  const nextRetryAt = new Date(now.getTime() + delaySec * 1000);
  await db
    .update(webhookDeliveries)
    .set({
      status: "failed",
      attemptCount,
      responseStatus: httpStatus ?? null,
      responseBody,
      responseHeaders,
      lastAttemptAt: now,
      nextRetryAt,
      errorMessage,
    })
    .where(eq(webhookDeliveries.id, delivery.id));

  return {
    deliveryId: delivery.deliveryId,
    status: "failed",
    attemptCount,
    httpStatus,
  };
}

/**
 * 批次處理「到期」的 delivery：
 *   - status = 'pending'（首次推送）
 *   - status = 'failed' AND nextRetryAt <= now（到時間重試）
 *
 * 不並行打同一個 endpoint（避免單一接收端被併發打爆），同 endpoint 內串行。
 * 不同 endpoint 之間並行。MVP 階段全串行，後續視壓力優化。
 */
export async function processDueDeliveries(opts: {
  limit?: number;
} = {}): Promise<{ processed: number; results: DispatchResult[] }> {
  const limit = opts.limit ?? 50;
  const now = new Date();

  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      or(
        eq(webhookDeliveries.status, "pending"),
        and(
          eq(webhookDeliveries.status, "failed"),
          or(
            isNull(webhookDeliveries.nextRetryAt),
            lte(webhookDeliveries.nextRetryAt, now),
          ),
        ),
      ),
    )
    .orderBy(webhookDeliveries.createdAt)
    .limit(limit);

  const results: DispatchResult[] = [];
  for (const row of due) {
    try {
      const r = await dispatchDelivery(row.id);
      results.push(r);
    } catch (err) {
      console.error("[webhook] dispatch error", row.id, err);
    }
  }

  return { processed: results.length, results };
}

/**
 * 手動補推一筆死信。
 *
 * 用途：台灣後端事後發現有事件漏接（如他們服務當機 1 小時）想補拉。
 * 重置 status → pending、attemptCount → 0、nextRetryAt → null，下一輪 scheduler tick 即推。
 *
 * 不重設 deliveryId（保留歷史追溯）。如需保證接收端冪等，台灣後端用 event_id。
 */
export async function requeueDelivery(deliveryId: string): Promise<void> {
  const updated = await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attemptCount: 0,
      nextRetryAt: null,
      errorMessage: null,
    })
    .where(eq(webhookDeliveries.id, deliveryId))
    .returning({ id: webhookDeliveries.id });
  if (updated.length === 0) {
    throw new Error(`webhook delivery ${deliveryId} not found`);
  }
}

// 引用 SQL helper 避免 unused 警告（drizzle 偶爾用得到）
void sql;
