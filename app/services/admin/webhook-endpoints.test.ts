import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { webhookEndpoints } from "~/db/schema/webhooks.ts";
import { AppError } from "~/lib/errors.ts";
import { decryptSecret, isEncrypted } from "~/lib/secrets.ts";
import {
  createWebhookEndpoint,
  deactivateWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  rotateWebhookSecret,
  updateWebhookEndpoint,
} from "./webhook-endpoints.ts";

// 確保走加密路徑（不依賴 .env 是否設了金鑰）。
Deno.env.set("DATA_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));

async function withTenant<T>(fn: (tenantId: string) => Promise<T>): Promise<T> {
  const [row] = await db
    .insert(tenants)
    .values({
      slug: `wh-ep-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayName: "webhook-endpoint-test",
    })
    .returning({ id: tenants.id });
  try {
    return await fn(row.id);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, row.id));
  }
}

Deno.test("create: 回傳一次性 64-hex secret，DB 內加密儲存且可還原", async () => {
  await withTenant(async (tenantId) => {
    const { endpoint, secret } = await createWebhookEndpoint({
      tenantId,
      url: "https://api.tw.example/cogrow/webhook/v1",
      eventTypes: ["device.enrolled", "command.completed"],
    });

    assertEquals(secret.length, 64); // 32 bytes hex
    assertEquals(endpoint.eventTypes as string[], [
      "device.enrolled",
      "command.completed",
    ]);
    assertEquals(endpoint.isActive, true);

    // DB 落地的是密文（v1:），且 decryptSecret 能還原回明文
    const row = await db.query.webhookEndpoints.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.id, endpoint.id),
    });
    assertEquals(isEncrypted(row!.secret), true);
    assertEquals(decryptSecret(row!.secret), secret);
  });
});

Deno.test("list / get: 回傳已建端點；get 跨租戶或不存在 → 404", async () => {
  await withTenant(async (tenantId) => {
    const { endpoint } = await createWebhookEndpoint({
      tenantId,
      url: "https://api.tw.example/h",
    });

    const list = await listWebhookEndpoints(tenantId);
    assertEquals(list.length, 1);
    assertEquals(list[0].id, endpoint.id);

    const got = await getWebhookEndpoint({ tenantId, endpointId: endpoint.id });
    assertEquals(got.id, endpoint.id);

    // 不存在 → 404
    await assertRejects(
      () =>
        getWebhookEndpoint({
          tenantId,
          endpointId: "00000000-0000-0000-0000-000000000000",
        }),
      AppError,
      "Webhook endpoint not found",
    );

    // 跨租戶隔離：另一 tenant 拿不到此 endpoint
    await withTenant(async (otherTenantId) => {
      await assertRejects(
        () => getWebhookEndpoint({ tenantId: otherTenantId, endpointId: endpoint.id }),
        AppError,
        "Webhook endpoint not found",
      );
    });
  });
});

Deno.test("update: 改 url / eventTypes / isActive 生效", async () => {
  await withTenant(async (tenantId) => {
    const { endpoint } = await createWebhookEndpoint({
      tenantId,
      url: "https://old.example/h",
      eventTypes: ["device.enrolled"],
    });

    const updated = await updateWebhookEndpoint({
      tenantId,
      endpointId: endpoint.id,
      input: {
        url: "https://new.example/h",
        eventTypes: ["agent.reported"],
        isActive: false,
      },
    });

    assertEquals(updated.url, "https://new.example/h");
    assertEquals(updated.eventTypes as string[], ["agent.reported"]);
    assertEquals(updated.isActive, false);
  });
});

Deno.test("deactivate: 軟刪標記 isActive=false（行仍在）", async () => {
  await withTenant(async (tenantId) => {
    const { endpoint } = await createWebhookEndpoint({
      tenantId,
      url: "https://api.tw.example/h",
    });

    await deactivateWebhookEndpoint({ tenantId, endpointId: endpoint.id });

    const row = await getWebhookEndpoint({ tenantId, endpointId: endpoint.id });
    assertEquals(row.isActive, false); // 行仍存在，僅標記停用
  });
});

Deno.test("rotateSecret: 生成新 secret，舊密文被取代，新 secret 可還原", async () => {
  await withTenant(async (tenantId) => {
    const created = await createWebhookEndpoint({
      tenantId,
      url: "https://api.tw.example/h",
    });
    const oldCipher = (await getWebhookEndpoint({
      tenantId,
      endpointId: created.endpoint.id,
    })).secret;

    const rotated = await rotateWebhookSecret({
      tenantId,
      endpointId: created.endpoint.id,
    });

    assertEquals(rotated.secret.length, 64);
    assertNotEquals(rotated.secret, created.secret); // 新明文 ≠ 舊明文

    const newRow = await getWebhookEndpoint({
      tenantId,
      endpointId: created.endpoint.id,
    });
    assertNotEquals(newRow.secret, oldCipher); // DB 密文已更換
    assertEquals(decryptSecret(newRow.secret), rotated.secret);
  });
});
