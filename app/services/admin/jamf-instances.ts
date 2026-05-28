import { and, eq, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { jamfInstances, jamfTokenCache } from "~/db/schema/jamf.ts";
import type { JamfInstance } from "~/db/schema/jamf.ts";
import { AppError, JamfUpstreamError } from "~/lib/errors.ts";
import { decryptSecret, encryptSecret } from "~/lib/secrets.ts";

export interface CreateJamfInstanceInput {
  tenantId: string;
  displayName: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  appLockGroupId?: number | null;
  notes?: string | null;
}

export interface UpdateJamfInstanceInput {
  displayName?: string;
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  appLockGroupId?: number | null;
  isActive?: boolean;
  notes?: string | null;
}

/**
 * 對外 DTO：絕對不回傳 client_secret 全文，只露最後 4 個字。
 */
export interface JamfInstanceDto {
  id: string;
  tenantId: string;
  displayName: string;
  baseUrl: string;
  clientId: string;
  clientSecretSuffix: string;
  appLockGroupId: number | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toJamfInstanceDto(row: JamfInstance): JamfInstanceDto {
  const secret = decryptSecret(row.clientSecretEnc);
  const suffix = secret.length >= 4 ? secret.slice(-4) : "****";
  return {
    id: row.id,
    tenantId: row.tenantId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    clientId: row.clientId,
    clientSecretSuffix: `****${suffix}`,
    appLockGroupId: row.appLockGroupId,
    isActive: row.isActive,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createJamfInstance(
  input: CreateJamfInstanceInput,
): Promise<JamfInstance> {
  try {
    const [row] = await db
      .insert(jamfInstances)
      .values({
        tenantId: input.tenantId,
        displayName: input.displayName,
        baseUrl: input.baseUrl.replace(/\/+$/, ""),
        clientId: input.clientId,
        clientSecretEnc: encryptSecret(input.clientSecret),
        appLockGroupId: input.appLockGroupId ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        "jamf_instance_duplicate",
        "Another instance with the same baseUrl already exists for this tenant",
      );
    }
    if (isForeignKeyViolation(err)) {
      throw new AppError(404, "tenant_not_found", "Tenant not found");
    }
    throw err;
  }
}

export function listJamfInstances(tenantId: string) {
  return db
    .select()
    .from(jamfInstances)
    .where(eq(jamfInstances.tenantId, tenantId))
    .orderBy(jamfInstances.createdAt);
}

export async function getJamfInstance(opts: {
  tenantId: string;
  instanceId: string;
}): Promise<JamfInstance> {
  const row = await db.query.jamfInstances.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.instanceId), eqOp(t.tenantId, opts.tenantId)),
  });
  if (!row) {
    throw new AppError(404, "jamf_instance_not_found", "Jamf instance not found");
  }
  return row;
}

export async function updateJamfInstance(opts: {
  tenantId: string;
  instanceId: string;
  input: UpdateJamfInstanceInput;
}): Promise<JamfInstance> {
  const { input } = opts;
  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl.replace(/\/+$/, "");
  if (input.clientId !== undefined) patch.clientId = input.clientId;
  if (input.clientSecret !== undefined) {
    patch.clientSecretEnc = encryptSecret(input.clientSecret);
  }
  if (input.appLockGroupId !== undefined) patch.appLockGroupId = input.appLockGroupId;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.notes !== undefined) patch.notes = input.notes;

  if (Object.keys(patch).length === 0) {
    return getJamfInstance(opts);
  }
  patch.updatedAt = sql`now()`;

  const [row] = await db
    .update(jamfInstances)
    .set(patch)
    .where(
      and(
        eq(jamfInstances.id, opts.instanceId),
        eq(jamfInstances.tenantId, opts.tenantId),
      ),
    )
    .returning();
  if (!row) {
    throw new AppError(404, "jamf_instance_not_found", "Jamf instance not found");
  }

  // 改了憑據或 baseUrl 必須失效舊 token cache
  if (input.clientSecret !== undefined || input.baseUrl !== undefined) {
    await db
      .delete(jamfTokenCache)
      .where(eq(jamfTokenCache.jamfInstanceId, opts.instanceId));
  }
  return row;
}

export async function deleteJamfInstance(opts: {
  tenantId: string;
  instanceId: string;
}): Promise<void> {
  const [row] = await db
    .delete(jamfInstances)
    .where(
      and(
        eq(jamfInstances.id, opts.instanceId),
        eq(jamfInstances.tenantId, opts.tenantId),
      ),
    )
    .returning({ id: jamfInstances.id });
  if (!row) {
    throw new AppError(404, "jamf_instance_not_found", "Jamf instance not found");
  }
}

/**
 * 用 instance 的 client_credentials 真去呼叫 Jamf OAuth token 端點，
 * 換到 token 即視為配置正確。回傳的 token 不持久化（不污染 cache）。
 */
export async function verifyJamfInstance(opts: {
  tenantId: string;
  instanceId: string;
}): Promise<{ expiresIn: number; scope?: string }> {
  const row = await getJamfInstance(opts);
  const clientSecret = decryptSecret(row.clientSecretEnc);
  const url = `${row.baseUrl}/api/oauth/token`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: row.clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    const body = await safeReadBody(resp);
    throw new JamfUpstreamError(resp.status, url, body);
  }

  const grant = (await resp.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope?: string;
  };
  return { expiresIn: grant.expires_in, scope: grant.scope };
}

async function safeReadBody(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    try {
      return await resp.text();
    } catch {
      return null;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23503"
  );
}
