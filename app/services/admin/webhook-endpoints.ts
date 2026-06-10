import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { webhookEndpoints } from "~/db/schema/webhooks.ts";
import { AppError } from "~/lib/errors.ts";
import { encryptSecret } from "~/lib/secrets.ts";

/**
 * Webhook endpoint 自助註冊 CRUD（取代先前「ops 手動寫 DB」流程）。
 *
 * secret 生命週期（仿 install-agent 的 agent token）：
 *   - create / rotate 時生成 32 bytes hex，**僅該次回傳明文一次**；
 *   - 入庫前經 encryptSecret 加密（`secret` 欄位存 v1: 密文）；
 *   - dispatcher 簽名時 decryptSecret 還原；GET 一律不回傳 secret。
 *
 * 刪除採軟刪（isActive=false），保留既有投遞歷史（webhook_deliveries 仍以 endpointId 引用）。
 */

const SECRET_BYTES = 32;

export interface CreateWebhookEndpointInput {
  tenantId: string;
  url: string;
  eventTypes?: string[];
  description?: string | null;
  isActive?: boolean;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  eventTypes?: string[];
  description?: string | null;
  isActive?: boolean;
}

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;

export interface WebhookEndpointWithSecret {
  endpoint: WebhookEndpointRow;
  /** 明文 secret，僅 create / rotate 當次回傳一次。 */
  secret: string;
}

/** 建立 endpoint，生成並回傳一次性明文 secret。 */
export async function createWebhookEndpoint(
  input: CreateWebhookEndpointInput,
): Promise<WebhookEndpointWithSecret> {
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  try {
    const [row] = await db
      .insert(webhookEndpoints)
      .values({
        tenantId: input.tenantId,
        url: input.url,
        secret: encryptSecret(secret),
        eventTypes: input.eventTypes ?? [],
        description: input.description ?? null,
        isActive: input.isActive ?? true,
      })
      .returning();
    if (!row) throw new Error("Insert returned no row");
    return { endpoint: row, secret };
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(404, "tenant_not_found", "Tenant not found");
    }
    throw err;
  }
}

export function listWebhookEndpoints(tenantId: string): Promise<WebhookEndpointRow[]> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.tenantId, tenantId))
    .orderBy(webhookEndpoints.createdAt);
}

export async function getWebhookEndpoint(opts: {
  tenantId: string;
  endpointId: string;
}): Promise<WebhookEndpointRow> {
  const row = await db.query.webhookEndpoints.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.endpointId), eqOp(t.tenantId, opts.tenantId)),
  });
  if (!row) {
    throw new AppError(404, "webhook_endpoint_not_found", "Webhook endpoint not found");
  }
  return row;
}

export async function updateWebhookEndpoint(opts: {
  tenantId: string;
  endpointId: string;
  input: UpdateWebhookEndpointInput;
}): Promise<WebhookEndpointRow> {
  const patch: Record<string, unknown> = {};
  if (opts.input.url !== undefined) patch.url = opts.input.url;
  if (opts.input.eventTypes !== undefined) patch.eventTypes = opts.input.eventTypes;
  if (opts.input.description !== undefined) patch.description = opts.input.description;
  if (opts.input.isActive !== undefined) patch.isActive = opts.input.isActive;
  if (Object.keys(patch).length === 0) return getWebhookEndpoint(opts);
  patch.updatedAt = sql`now()`;

  const [row] = await db
    .update(webhookEndpoints)
    .set(patch)
    .where(
      and(
        eq(webhookEndpoints.id, opts.endpointId),
        eq(webhookEndpoints.tenantId, opts.tenantId),
      ),
    )
    .returning();
  if (!row) {
    throw new AppError(404, "webhook_endpoint_not_found", "Webhook endpoint not found");
  }
  return row;
}

/** 軟刪：標記 isActive=false（保留投遞歷史）。 */
export async function deactivateWebhookEndpoint(opts: {
  tenantId: string;
  endpointId: string;
}): Promise<void> {
  const [row] = await db
    .update(webhookEndpoints)
    .set({ isActive: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(webhookEndpoints.id, opts.endpointId),
        eq(webhookEndpoints.tenantId, opts.tenantId),
      ),
    )
    .returning({ id: webhookEndpoints.id });
  if (!row) {
    throw new AppError(404, "webhook_endpoint_not_found", "Webhook endpoint not found");
  }
}

/** 輪換 secret：生成新 secret 並回傳一次性明文，舊 secret 立即失效。 */
export async function rotateWebhookSecret(opts: {
  tenantId: string;
  endpointId: string;
}): Promise<WebhookEndpointWithSecret> {
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const [row] = await db
    .update(webhookEndpoints)
    .set({ secret: encryptSecret(secret), updatedAt: sql`now()` })
    .where(
      and(
        eq(webhookEndpoints.id, opts.endpointId),
        eq(webhookEndpoints.tenantId, opts.tenantId),
      ),
    )
    .returning();
  if (!row) {
    throw new AppError(404, "webhook_endpoint_not_found", "Webhook endpoint not found");
  }
  return { endpoint: row, secret };
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23503"
  );
}
