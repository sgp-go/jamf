import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import {
  eventLog,
  webhookDeliveries,
  webhookEndpoints,
} from "~/db/schema/webhooks.ts";
import { publishEvent } from "./publisher.ts";
import {
  dispatchDelivery,
  MAX_ATTEMPTS,
  processDueDeliveries,
} from "./dispatcher.ts";
import { verifyWebhookSignature } from "./signature.ts";

/**
 * Webhook 端到端整合測試（W5 P0）。
 *
 * 與 publisher.test.ts 區別：後者只驗 publishEvent 的 DB 寫入；本檔走真實 HTTP
 * 投遞鏈——起一個 throwaway Deno.serve 接收端，驗 dispatcher 的簽名、header、
 * 重試狀態機、租戶隔離。不需真機（對齊 task 17 dummy 模式）。
 */

/** 獨立 tenant 隔離測試資料；finally CASCADE 清三表。 */
async function withTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const [row] = await db
    .insert(tenants)
    .values({
      slug: `integ-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "webhook-integration-test",
    })
    .returning({ id: tenants.id });
  try {
    return await fn(row.id);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, row.id));
  }
}

interface ReceivedRequest {
  method: string;
  headers: Headers;
  body: string;
}

/** 起一個本地接收端（隨機 port），記錄所有收到的請求；可動態切換回應碼。 */
function startReceiver(opts: { status?: number } = {}) {
  const requests: ReceivedRequest[] = [];
  let statusToReturn = opts.status ?? 200;
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      const body = await req.text();
      requests.push({ method: req.method, headers: req.headers, body });
      return new Response("ok", { status: statusToReturn });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://127.0.0.1:${port}/sink`,
    requests,
    setStatus: (s: number) => {
      statusToReturn = s;
    },
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/** 取某 tenant 下的 delivery PK id（publishEvent 返回的是業務 deliveryId，dispatch 要 PK）。 */
async function deliveriesOf(tenantId: string) {
  return await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.tenantId, tenantId));
}

Deno.test("integration: 命令成功全鏈 + 簽名驗證", async () => {
  await withTenant(async (tenantId) => {
    const receiver = startReceiver({ status: 200 });
    try {
      const secret = "integ-secret-abcdefghij";
      await db.insert(webhookEndpoints).values({
        tenantId,
        url: receiver.url,
        secret,
        eventTypes: ["command.completed"],
        isActive: true,
      });

      const pub = await publishEvent({
        tenantId,
        eventType: "command.completed",
        data: { command_id: "cmd-123", status: "acknowledged" },
      });
      assertEquals(pub.matched, 1);

      const [row] = await deliveriesOf(tenantId);
      const result = await dispatchDelivery(row.id);
      assertEquals(result.status, "delivered");

      // 接收端收到恰一筆
      assertEquals(receiver.requests.length, 1);
      const got = receiver.requests[0];
      assertEquals(got.method, "POST");
      assertEquals(got.headers.get("x-cogrow-event"), "command.completed");
      assertEquals(got.headers.get("x-cogrow-delivery"), row.deliveryId);

      // 簽名驗證（§A.3 HMAC-SHA256 over `{timestamp}.{body}`）
      const ts = Number(got.headers.get("x-cogrow-timestamp"));
      const sig = got.headers.get("x-cogrow-signature")!;
      assertEquals(
        verifyWebhookSignature({ secret, timestamp: ts, body: got.body, signature: sig }),
        true,
      );
      // 錯誤 secret → 驗簽失敗
      assertEquals(
        verifyWebhookSignature({ secret: "wrong-secret", timestamp: ts, body: got.body, signature: sig }),
        false,
      );

      // envelope 內容正確
      const env = JSON.parse(got.body);
      assertEquals(env.event_type, "command.completed");
      assertEquals(env.tenant_id, tenantId);
      assertEquals(env.data.command_id, "cmd-123");
      assertEquals(env.event_id, row.eventId);

      // delivery 狀態落庫 delivered
      const [after] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, row.id));
      assertEquals(after.status, "delivered");
      assertEquals(after.deliveredAt !== null, true);
    } finally {
      await receiver.close();
    }
  });
});

Deno.test("integration: processDueDeliveries 批次路徑投遞 pending", async () => {
  await withTenant(async (tenantId) => {
    const receiver = startReceiver({ status: 200 });
    try {
      await db.insert(webhookEndpoints).values({
        tenantId,
        url: receiver.url,
        secret: "integ-batch-secret-1234",
        eventTypes: [],
        isActive: true,
      });
      await publishEvent({
        tenantId,
        eventType: "device.online",
        data: { udid: "dev-batch" },
      });

      // 走 scheduler 真路徑（掃 pending 投遞）
      await processDueDeliveries({ limit: 100 });

      const [after] = await deliveriesOf(tenantId);
      assertEquals(after.status, "delivered");
      // 接收端確實收到本 tenant 的事件
      const mine = receiver.requests.filter(
        (r) => r.headers.get("x-cogrow-delivery") === after.deliveryId,
      );
      assertEquals(mine.length, 1);
    } finally {
      await receiver.close();
    }
  });
});

Deno.test("integration: 投遞失敗 retry→dead 狀態機", async () => {
  await withTenant(async (tenantId) => {
    const receiver = startReceiver({ status: 500 });
    try {
      await db.insert(webhookEndpoints).values({
        tenantId,
        url: receiver.url,
        secret: "integ-500-secret-12345",
        eventTypes: [],
        isActive: true,
      });
      await publishEvent({
        tenantId,
        eventType: "command.failed",
        data: { command_id: "c-fail" },
      });

      const [row] = await deliveriesOf(tenantId);

      // 直接 dispatch MAX_ATTEMPTS 次驅動狀態機（繞過 nextRetryAt 等待）
      const statuses: string[] = [];
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const r = await dispatchDelivery(row.id);
        statuses.push(r.status);
      }
      // 前 N-1 次 failed，最後一次 dead
      assertEquals(
        statuses.slice(0, MAX_ATTEMPTS - 1).every((s) => s === "failed"),
        true,
      );
      assertEquals(statuses[MAX_ATTEMPTS - 1], "dead");

      const [after] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, row.id));
      assertEquals(after.status, "dead");
      assertEquals(after.attemptCount, MAX_ATTEMPTS);
      // 接收端共收到 MAX_ATTEMPTS 次（每次都打了）
      assertEquals(receiver.requests.length, MAX_ATTEMPTS);
    } finally {
      await receiver.close();
    }
  });
});

Deno.test("integration: 無訂閱者 matched=0 不產生投遞 / 不打 HTTP", async () => {
  await withTenant(async (tenantId) => {
    const receiver = startReceiver({ status: 200 });
    try {
      // 不註冊任何 endpoint
      const pub = await publishEvent({
        tenantId,
        eventType: "device.online",
        data: { udid: "dev-no-sub" },
      });
      assertEquals(pub.matched, 0);

      // event_log 有、matched=0
      const logs = await db
        .select()
        .from(eventLog)
        .where(eq(eventLog.tenantId, tenantId));
      assertEquals(logs.length, 1);
      assertEquals(logs[0].matchedEndpointCount, 0);

      // deliveries 零行
      assertEquals((await deliveriesOf(tenantId)).length, 0);

      // 跑 scheduler 也不會對本 tenant 打任何 HTTP
      await processDueDeliveries({ limit: 100 });
      const mine = receiver.requests.filter((r) => {
        try {
          return JSON.parse(r.body).tenant_id === tenantId;
        } catch {
          return false;
        }
      });
      assertEquals(mine.length, 0);
    } finally {
      await receiver.close();
    }
  });
});

Deno.test("integration: 租戶隔離 — A 事件不漏到 B 的 endpoint", async () => {
  await withTenant(async (tenantA) => {
    await withTenant(async (tenantB) => {
      const recvA = startReceiver({ status: 200 });
      const recvB = startReceiver({ status: 200 });
      try {
        await db.insert(webhookEndpoints).values({
          tenantId: tenantA,
          url: recvA.url,
          secret: "integ-iso-a-secret-12",
          eventTypes: [],
          isActive: true,
        });
        await db.insert(webhookEndpoints).values({
          tenantId: tenantB,
          url: recvB.url,
          secret: "integ-iso-b-secret-12",
          eventTypes: [],
          isActive: true,
        });

        const pub = await publishEvent({
          tenantId: tenantA,
          eventType: "device.online",
          data: { udid: "a-dev" },
        });
        assertEquals(pub.matched, 1);

        // 只 A 有 delivery，B 零
        assertEquals((await deliveriesOf(tenantA)).length, 1);
        assertEquals((await deliveriesOf(tenantB)).length, 0);

        const [aRow] = await deliveriesOf(tenantA);
        await dispatchDelivery(aRow.id);

        // A 收到、B 沒收到
        assertEquals(recvA.requests.length, 1);
        const bGotA = recvB.requests.filter((r) => {
          try {
            return JSON.parse(r.body).tenant_id === tenantA;
          } catch {
            return false;
          }
        });
        assertEquals(bGotA.length, 0);
      } finally {
        await recvA.close();
        await recvB.close();
      }
    });
  });
});
