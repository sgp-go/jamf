import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import {
  eventLog,
  webhookDeliveries,
  webhookEndpoints,
} from "~/db/schema/webhooks.ts";
import { publishEvent } from "./publisher.ts";

/**
 * 用獨立 tenant 隔離測試資料；測完 cleanup CASCADE 清掉 event_log /
 * webhook_endpoints / webhook_deliveries 三表的相關行。
 */
async function withTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const [row] = await db
    .insert(tenants)
    .values({
      slug: `pub-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "publisher-test",
    })
    .returning({ id: tenants.id });
  try {
    return await fn(row.id);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, row.id));
  }
}

Deno.test("publishEvent: matched=0 仍寫 event_log（dev/test 友好）", async () => {
  await withTenant(async (tenantId) => {
    const result = await publishEvent({
      tenantId,
      eventType: "command.completed",
      data: { command_id: "c-1", status: "acknowledged" },
    });

    assertEquals(result.matched, 0);
    assertEquals(result.deliveryIds.length, 0);

    const logs = await db
      .select()
      .from(eventLog)
      .where(eq(eventLog.tenantId, tenantId));
    assertEquals(logs.length, 1);
    assertEquals(logs[0].eventType, "command.completed");
    assertEquals(logs[0].matchedEndpointCount, 0);

    // 仍寫 envelope 完整 payload — 同事件的 data 段能對得上
    const payload = logs[0].payload as Record<string, unknown>;
    assertEquals((payload.data as Record<string, unknown>).command_id, "c-1");
    assertEquals(payload.event_type, "command.completed");
    assertEquals(payload.tenant_id, tenantId);

    // webhook_deliveries 表零行（沒 endpoint）
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.tenantId, tenantId));
    assertEquals(deliveries.length, 0);
  });
});

Deno.test("publishEvent: matched>0 寫 event_log + deliveries 對齊 event_id", async () => {
  await withTenant(async (tenantId) => {
    await db.insert(webhookEndpoints).values({
      tenantId,
      url: "http://127.0.0.1:9999/sink-test",
      secret: "test-secret-1234567890",
      eventTypes: ["command.completed"],
      isActive: true,
    });
    await db.insert(webhookEndpoints).values({
      tenantId,
      url: "http://127.0.0.1:9999/sink-test-2",
      secret: "test-secret-9876543210",
      eventTypes: [], // 訂閱全部
      isActive: true,
    });

    const result = await publishEvent({
      tenantId,
      eventType: "command.completed",
      data: { command_id: "c-2" },
    });

    assertEquals(result.matched, 2);
    assertEquals(result.deliveryIds.length, 2);

    const logs = await db
      .select()
      .from(eventLog)
      .where(eq(eventLog.tenantId, tenantId));
    assertEquals(logs.length, 1);
    assertEquals(logs[0].matchedEndpointCount, 2);

    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.tenantId, tenantId));
    assertEquals(deliveries.length, 2);
    // 同 event_id 跨 event_log + 2 個 deliveries
    assertEquals(deliveries[0].eventId, logs[0].eventId);
    assertEquals(deliveries[1].eventId, logs[0].eventId);
  });
});

Deno.test("publishEvent: eventTypes 不匹配 → 寫 event_log 但 matched=0", async () => {
  await withTenant(async (tenantId) => {
    // endpoint 只訂閱 command.queued，發 command.completed 應 matched=0
    await db.insert(webhookEndpoints).values({
      tenantId,
      url: "http://127.0.0.1:9999/sink-queued-only",
      secret: "test-secret-only-queued",
      eventTypes: ["command.queued"],
      isActive: true,
    });

    const result = await publishEvent({
      tenantId,
      eventType: "command.completed",
      data: { command_id: "c-3" },
    });

    assertEquals(result.matched, 0);

    const logs = await db
      .select()
      .from(eventLog)
      .where(eq(eventLog.tenantId, tenantId));
    assertEquals(logs.length, 1);
    assertEquals(logs[0].matchedEndpointCount, 0);

    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.tenantId, tenantId));
    assertEquals(deliveries.length, 0);
  });
});

Deno.test("publishEvent: isActive=false endpoint 不算 matched", async () => {
  await withTenant(async (tenantId) => {
    await db.insert(webhookEndpoints).values({
      tenantId,
      url: "http://127.0.0.1:9999/sink-inactive",
      secret: "test-secret-inactive-endpoint",
      eventTypes: [],
      isActive: false, // 停用
    });

    const result = await publishEvent({
      tenantId,
      eventType: "command.completed",
      data: { command_id: "c-4" },
    });

    assertEquals(result.matched, 0);

    const logs = await db
      .select()
      .from(eventLog)
      .where(eq(eventLog.tenantId, tenantId));
    assertEquals(logs.length, 1);
    assertEquals(logs[0].matchedEndpointCount, 0);
  });
});

Deno.test("publishEvent: eventId 自訂時保留（冪等用）", async () => {
  await withTenant(async (tenantId) => {
    const customEventId = crypto.randomUUID();
    await publishEvent({
      tenantId,
      eventType: "command.completed",
      data: { command_id: "c-5" },
      eventId: customEventId,
    });

    const logs = await db
      .select()
      .from(eventLog)
      .where(
        and(eq(eventLog.tenantId, tenantId), eq(eventLog.eventId, customEventId)),
      );
    assertEquals(logs.length, 1);
  });
});
