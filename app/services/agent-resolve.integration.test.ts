/**
 * resolveAgentDevice — stale-disown 整合測試。
 *
 * 場景：Windows Agent wipe 後 doWipePersistProvisionedData → PPKG 自動重跑
 *  enrollment → 建新 row 拿新 token。舊 row 仍佔 (tenant, serial) unique
 *  index，backfill 直接 UPDATE 會撞 unique violation → 500。
 *
 *  resolveAgentDevice token-first 命中新 row 後應：
 *   1. 檢測到同 (tenant, serial) 有 stale 舊 row（agent_token_issued_at 更早）
 *   2. 把舊 row.serial_number disown 為 null（保留 row + FK 歷史）
 *   3. UPDATE 新 row.serial 成功、不再 unique violation
 *   4. 已簽發活 token 的其他 row **不會**被誤傷（防守測試）
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { resolveAgentDevice } from "./agent.ts";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function withTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const slug = `agent-resolve-it-${Date.now()}-${
    Math.random().toString(36).slice(2, 7)
  }`;
  const [t] = await db
    .insert(tenants)
    .values({ slug, displayName: "agent-resolve-it" })
    .returning({ id: tenants.id });
  try {
    return await fn(t.id);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, t.id));
  }
}

Deno.test("resolveAgentDevice: wipe 後 PPKG 重 enroll，backfill 前 disown 舊 row 的 serial", async () => {
  await withTenant(async (tenantId) => {
    const oldToken = "old-token-" + Math.random();
    const newToken = "new-token-" + Math.random();
    const serial = "PF5XSMN1";

    // 舊 row：wipe 前的 enrollment，有 serial + 舊 token
    const oldIssuedAt = new Date(Date.now() - 3600_000);
    const [oldRow] = await db.insert(mdmDevices).values({
      tenantId,
      platform: "windows",
      serialNumber: serial,
      udid: "windows-OLD-udid",
      agentTokenHash: hash(oldToken),
      agentTokenIssuedAt: oldIssuedAt,
      enrollmentStatus: "enrolled",
    }).returning({ id: mdmDevices.id });

    // 新 row：wipe 後 PPKG 自動重 enroll 建的，serial 空、拿新 token
    const newIssuedAt = new Date();
    const [newRow] = await db.insert(mdmDevices).values({
      tenantId,
      platform: "windows",
      serialNumber: null,
      udid: "windows-NEW-udid",
      agentTokenHash: hash(newToken),
      agentTokenIssuedAt: newIssuedAt,
      enrollmentStatus: "enrolled",
    }).returning({ id: mdmDevices.id });

    // Agent 帶新 token + 真 serial 打過來 → 應該命中新 row，並 disown 舊 row.serial
    const resolved = await resolveAgentDevice({
      tenantId,
      serialNumber: serial,
      token: newToken,
    });
    assertEquals(resolved.id, newRow.id);

    const oldAfter = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, oldRow.id),
      columns: { serialNumber: true, agentTokenHash: true },
    });
    assertEquals(oldAfter?.serialNumber, null, "舊 row.serial 應被 disown");
    assertEquals(oldAfter?.agentTokenHash, hash(oldToken), "舊 row.token_hash 保留");

    const newAfter = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, newRow.id),
      columns: { serialNumber: true },
    });
    assertEquals(newAfter?.serialNumber, serial, "新 row.serial backfill 成功");
  });
});

Deno.test("resolveAgentDevice: 同 tenant 若已有活 token 的其他 row（issuedAt 更新）不會被 disown", async () => {
  await withTenant(async (tenantId) => {
    const tokenA = "token-a-" + Math.random();
    const tokenB = "token-b-" + Math.random();
    const serial = "COLLISION-SERIAL";

    // Row A：兩年後 issuedAt，模擬「更新的活設備」
    const [rowA] = await db.insert(mdmDevices).values({
      tenantId,
      platform: "windows",
      serialNumber: serial,
      agentTokenHash: hash(tokenA),
      agentTokenIssuedAt: new Date(Date.now() + 1000_000),
      enrollmentStatus: "enrolled",
    }).returning({ id: mdmDevices.id });

    // Row B：token 命中的當前 row，issuedAt 較早（比 A 舊）
    const [rowB] = await db.insert(mdmDevices).values({
      tenantId,
      platform: "windows",
      serialNumber: null,
      agentTokenHash: hash(tokenB),
      agentTokenIssuedAt: new Date(),
      enrollmentStatus: "enrolled",
    }).returning({ id: mdmDevices.id });

    // 打 B 的 token + serial（跟 A 撞）→ backfill 應該失敗（不清 A，A 更新）
    // 且不 throw，只是不 disown、UPDATE B 撞 unique 會冒錯
    let threw = false;
    try {
      await resolveAgentDevice({
        tenantId,
        serialNumber: serial,
        token: tokenB,
      });
    } catch {
      threw = true;
    }

    const aAfter = await db.query.mdmDevices.findFirst({
      where: eq(mdmDevices.id, rowA.id),
      columns: { serialNumber: true },
    });
    assertEquals(aAfter?.serialNumber, serial, "更新的活 row A 不應被誤傷");

    // 這個 case 應該冒 unique violation（因為 A 是活的、不該被 disown）；
    // 這是設計期望：token-first 命中的 row 想 backfill 但衝到活 row 說明配置錯誤，
    // 拋錯讓運維察覺，比默默清 A 更安全。
    assertEquals(threw, true, "撞活 row 應拋錯而非默默 disown");

    // cleanup: 手動釋放避免 test 內的 unique 佔用影響後續
    await db.update(mdmDevices).set({ serialNumber: null }).where(
      and(eq(mdmDevices.tenantId, tenantId), eq(mdmDevices.id, rowB.id)),
    );
  });
});
