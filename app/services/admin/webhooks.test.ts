import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import {
  eventLog,
  webhookDeliveries,
  webhookEndpoints,
} from "~/db/schema/webhooks.ts";
import { listEventLog, listWebhookDeliveries } from "./webhooks.ts";

/**
 * 用獨立 tenant 隔離測試資料；測完 cleanup CASCADE 清掉 event_log /
 * webhook_endpoints / webhook_deliveries 三表相關行（對齊 publisher.test.ts）。
 */
async function withTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const [row] = await db
    .insert(tenants)
    .values({
      slug: `wh-list-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "webhooks-list-test",
    })
    .returning({ id: tenants.id });
  try {
    return await fn(row.id);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, row.id));
  }
}

Deno.test("listEventLog: 按 tenant 分頁 + desc created_at", async () => {
  await withTenant(async (tenantId) => {
    // 插 3 筆，created_at 遞增（顯式給時間確保排序可斷言）
    const base = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 3; i++) {
      await db.insert(eventLog).values({
        tenantId,
        eventType: "command.completed",
        eventId: crypto.randomUUID(),
        payload: { seq: i },
        matchedEndpointCount: i,
        occurredAt: new Date(base.getTime() + i * 1000),
        createdAt: new Date(base.getTime() + i * 1000),
      });
    }

    const { rows, total } = await listEventLog({ tenantId, page: 1, limit: 50 });
    assertEquals(total, 3);
    assertEquals(rows.length, 3);
    // desc：最新（seq=2）排最前
    assertEquals((rows[0].payload as Record<string, unknown>).seq, 2);
    assertEquals((rows[2].payload as Record<string, unknown>).seq, 0);
  });
});

Deno.test("listEventLog: eventType + unmatchedOnly 過濾", async () => {
  await withTenant(async (tenantId) => {
    await db.insert(eventLog).values([
      {
        tenantId,
        eventType: "command.completed",
        eventId: crypto.randomUUID(),
        payload: {},
        matchedEndpointCount: 0, // 沒訂閱者
        occurredAt: new Date(),
      },
      {
        tenantId,
        eventType: "command.completed",
        eventId: crypto.randomUUID(),
        payload: {},
        matchedEndpointCount: 2, // 有訂閱者
        occurredAt: new Date(),
      },
      {
        tenantId,
        eventType: "device.enrolled",
        eventId: crypto.randomUUID(),
        payload: {},
        matchedEndpointCount: 0,
        occurredAt: new Date(),
      },
    ]);

    // eventType 過濾
    const byType = await listEventLog({
      tenantId,
      page: 1,
      limit: 50,
      eventType: "command.completed",
    });
    assertEquals(byType.total, 2);

    // eventType + unmatchedOnly：只剩沒訂閱者那 1 筆
    const unmatched = await listEventLog({
      tenantId,
      page: 1,
      limit: 50,
      eventType: "command.completed",
      unmatchedOnly: true,
    });
    assertEquals(unmatched.total, 1);
    assertEquals(unmatched.rows[0].matchedEndpointCount, 0);
  });
});

Deno.test("listEventLog: eventId 精確過濾", async () => {
  await withTenant(async (tenantId) => {
    const targetId = crypto.randomUUID();
    await db.insert(eventLog).values([
      {
        tenantId,
        eventType: "command.completed",
        eventId: targetId,
        payload: {},
        matchedEndpointCount: 1,
        occurredAt: new Date(),
      },
      {
        tenantId,
        eventType: "command.completed",
        eventId: crypto.randomUUID(),
        payload: {},
        matchedEndpointCount: 1,
        occurredAt: new Date(),
      },
    ]);

    const { rows, total } = await listEventLog({
      tenantId,
      page: 1,
      limit: 50,
      eventId: targetId,
    });
    assertEquals(total, 1);
    assertEquals(rows[0].eventId, targetId);
  });
});

Deno.test("listWebhookDeliveries: status + endpointId 過濾 + desc 排序", async () => {
  await withTenant(async (tenantId) => {
    const [ep] = await db
      .insert(webhookEndpoints)
      .values({
        tenantId,
        url: "http://127.0.0.1:9999/sink",
        secret: "test-secret-list-deliveries",
        eventTypes: [],
        isActive: true,
      })
      .returning({ id: webhookEndpoints.id });

    const base = new Date("2026-02-01T00:00:00Z");
    const eventId = crypto.randomUUID();
    await db.insert(webhookDeliveries).values([
      {
        tenantId,
        endpointId: ep.id,
        eventType: "command.completed",
        eventId,
        payload: { attempt: 1 },
        status: "dead",
        attemptCount: 3,
        createdAt: base,
      },
      {
        tenantId,
        endpointId: ep.id,
        eventType: "command.completed",
        eventId,
        payload: { attempt: 2 },
        status: "delivered",
        attemptCount: 1,
        createdAt: new Date(base.getTime() + 5000),
      },
    ]);

    // 全部
    const all = await listWebhookDeliveries({ tenantId, page: 1, limit: 50 });
    assertEquals(all.total, 2);
    // desc：較新的 delivered 排最前
    assertEquals(all.rows[0].status, "delivered");

    // status 過濾
    const deadOnly = await listWebhookDeliveries({
      tenantId,
      page: 1,
      limit: 50,
      status: "dead",
    });
    assertEquals(deadOnly.total, 1);
    assertEquals(deadOnly.rows[0].status, "dead");

    // endpointId 過濾命中
    const byEndpoint = await listWebhookDeliveries({
      tenantId,
      page: 1,
      limit: 50,
      endpointId: ep.id,
    });
    assertEquals(byEndpoint.total, 2);

    // eventId 過濾：同事件兩次嘗試都拿到
    const byEvent = await listWebhookDeliveries({
      tenantId,
      page: 1,
      limit: 50,
      eventId,
    });
    assertEquals(byEvent.total, 2);
  });
});

Deno.test("listWebhookDeliveries: tenant 隔離（別的 tenant 看不到）", async () => {
  await withTenant(async (tenantId) => {
    const [ep] = await db
      .insert(webhookEndpoints)
      .values({
        tenantId,
        url: "http://127.0.0.1:9999/sink-iso",
        secret: "test-secret-isolation",
        eventTypes: [],
        isActive: true,
      })
      .returning({ id: webhookEndpoints.id });

    await db.insert(webhookDeliveries).values({
      tenantId,
      endpointId: ep.id,
      eventType: "command.completed",
      eventId: crypto.randomUUID(),
      payload: {},
      status: "pending",
      attemptCount: 0,
    });

    // 查一個全新的空 tenant → 0 行
    await withTenant(async (otherTenantId) => {
      const { total } = await listWebhookDeliveries({
        tenantId: otherTenantId,
        page: 1,
        limit: 50,
      });
      assertEquals(total, 0);
    });
  });
});
