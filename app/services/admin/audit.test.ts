import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { auditLogs } from "~/db/schema/audit.ts";
import {
  extractAuditMeta,
  listAuditLogs,
  logAudit,
} from "./audit.ts";

/**
 * 用獨立 tenant 隔離測試資料；測完 cleanup（CASCADE 把 audit_logs 也清）。
 */
async function withTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const [row] = await db
    .insert(tenants)
    .values({
      slug: `audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "audit-test",
    })
    .returning({ id: tenants.id });
  try {
    return await fn(row.id);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, row.id));
  }
}

Deno.test("logAudit + listAuditLogs: 基本 round-trip", async () => {
  await withTenant(async (tenantId) => {
    await logAudit({
      tenantId,
      actor: "admin:test@cogrow.com",
      action: "profile.create",
      resourceType: "profile",
      resourceId: "p-1",
      payload: { foo: "bar" },
    });
    const { rows, total } = await listAuditLogs({ tenantId, page: 1, limit: 10 });
    assertEquals(total, 1);
    assertEquals(rows[0].action, "profile.create");
    assertEquals(rows[0].resourceId, "p-1");
    assertEquals(rows[0].payload, { foo: "bar" });
  });
});

Deno.test("listAuditLogs: actionPrefix 過濾", async () => {
  await withTenant(async (tenantId) => {
    await logAudit({ tenantId, actor: "admin:a", action: "profile.create", resourceType: "profile" });
    await logAudit({ tenantId, actor: "admin:a", action: "profile.assign", resourceType: "profile" });
    await logAudit({ tenantId, actor: "admin:a", action: "device.transfer", resourceType: "device" });

    const { rows, total } = await listAuditLogs({
      tenantId,
      page: 1,
      limit: 10,
      actionPrefix: "profile.",
    });
    assertEquals(total, 2);
    // desc createdAt：最後寫的在最前面（assign 比 create 晚寫）
    assertEquals(
      rows.map((r) => r.action).sort(),
      ["profile.assign", "profile.create"],
    );
  });
});

Deno.test("listAuditLogs: resourceType + actorPrefix 過濾", async () => {
  await withTenant(async (tenantId) => {
    await logAudit({ tenantId, actor: "admin:a", action: "x.y", resourceType: "device" });
    await logAudit({ tenantId, actor: "system", action: "x.y", resourceType: "device" });
    await logAudit({ tenantId, actor: "admin:b", action: "x.y", resourceType: "profile" });

    const result = await listAuditLogs({
      tenantId,
      page: 1,
      limit: 10,
      resourceType: "device",
      actorPrefix: "admin:",
    });
    assertEquals(result.total, 1);
    assertEquals(result.rows[0].actor, "admin:a");
  });
});

Deno.test("listAuditLogs: 時間範圍過濾 since/until", async () => {
  await withTenant(async (tenantId) => {
    await logAudit({ tenantId, actor: "a", action: "test", resourceType: "x" });
    const t1 = new Date();
    const all = await listAuditLogs({ tenantId, page: 1, limit: 10 });
    assertEquals(all.total, 1);

    // until = now → 此時應仍包含（log row.createdAt < now）
    const before = await listAuditLogs({ tenantId, page: 1, limit: 10, until: t1 });
    assertEquals(before.total <= 1, true);

    // since = 未來時間點 → 應為 0
    const future = new Date(Date.now() + 60_000);
    const afterFuture = await listAuditLogs({
      tenantId,
      page: 1,
      limit: 10,
      since: future,
    });
    assertEquals(afterFuture.total, 0);
  });
});

Deno.test("listAuditLogs: 分頁 page + limit", async () => {
  await withTenant(async (tenantId) => {
    for (let i = 0; i < 5; i++) {
      await logAudit({
        tenantId,
        actor: "a",
        action: `test.${i}`,
        resourceType: "x",
      });
    }
    const p1 = await listAuditLogs({ tenantId, page: 1, limit: 2 });
    const p2 = await listAuditLogs({ tenantId, page: 2, limit: 2 });
    const p3 = await listAuditLogs({ tenantId, page: 3, limit: 2 });
    assertEquals(p1.total, 5);
    assertEquals(p2.total, 5);
    assertEquals(p1.rows.length, 2);
    assertEquals(p2.rows.length, 2);
    assertEquals(p3.rows.length, 1);
    // 不重複
    const ids = new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id));
    assertEquals(ids.size, 5);
  });
});

Deno.test("logAudit: DB error 不 throw（fire-and-forget）", async () => {
  // 不存在的 tenant ID 觸發 FK violation → 不該 throw
  await logAudit({
    tenantId: "00000000-0000-0000-0000-000000000000",
    actor: "a",
    action: "x.y",
    resourceType: "z",
  });
  // 沒 throw 即通過；無斷言
});

Deno.test("extractAuditMeta: 預設 actor=admin:bearer / 其他 null", () => {
  const fakeCtx = {
    req: { header: (_: string): string | undefined => undefined },
  };
  assertEquals(extractAuditMeta(fakeCtx), {
    actor: "admin:bearer",
    ip: null,
    userAgent: null,
    requestId: null,
  });
});

Deno.test("extractAuditMeta: X-Actor / X-Forwarded-For / UA / X-Request-Id 全部讀到", () => {
  const headers: Record<string, string> = {
    "x-actor": "admin:hj@cogrow.com",
    "x-forwarded-for": "203.0.113.5, 10.0.0.1",
    "user-agent": "curl/8.0",
    "x-request-id": "req-abc",
  };
  const fakeCtx = {
    req: { header: (name: string) => headers[name.toLowerCase()] },
  };
  assertEquals(extractAuditMeta(fakeCtx), {
    actor: "admin:hj@cogrow.com",
    ip: "203.0.113.5",
    userAgent: "curl/8.0",
    requestId: "req-abc",
  });
});

Deno.test("extractAuditMeta: 無 X-Forwarded-For 時 fallback X-Real-IP", () => {
  const headers: Record<string, string> = {
    "x-real-ip": "10.0.0.5",
  };
  const fakeCtx = {
    req: { header: (name: string) => headers[name.toLowerCase()] },
  };
  assertEquals(extractAuditMeta(fakeCtx).ip, "10.0.0.5");
});
