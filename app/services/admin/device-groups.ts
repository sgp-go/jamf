import { and, eq, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { deviceGroups } from "~/db/schema/tenants.ts";
import { AppError } from "~/lib/errors.ts";

export interface CreateDeviceGroupInput {
  tenantId: string;
  code: string;
  displayName: string;
  jamfInstanceId?: string | null;
}

export interface UpdateDeviceGroupInput {
  code?: string;
  displayName?: string;
  jamfInstanceId?: string | null;
}

export async function createDeviceGroup(input: CreateDeviceGroupInput) {
  if (input.jamfInstanceId) {
    await assertJamfBelongsToTenant(input.tenantId, input.jamfInstanceId);
    await assertJamfNotAlreadyBound(input.jamfInstanceId);
  }
  try {
    const [row] = await db
      .insert(deviceGroups)
      .values({
        tenantId: input.tenantId,
        code: input.code,
        displayName: input.displayName,
        jamfInstanceId: input.jamfInstanceId ?? null,
      })
      .returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        "device_group_code_taken",
        `Code "${input.code}" already exists for this tenant`,
      );
    }
    if (isForeignKeyViolation(err)) {
      throw new AppError(404, "tenant_not_found", "Tenant not found");
    }
    throw err;
  }
}

export function listDeviceGroups(tenantId: string) {
  return db
    .select()
    .from(deviceGroups)
    .where(eq(deviceGroups.tenantId, tenantId))
    .orderBy(deviceGroups.code);
}

export async function getDeviceGroup(opts: { tenantId: string; deviceGroupId: string }) {
  const row = await db.query.deviceGroups.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.deviceGroupId), eqOp(t.tenantId, opts.tenantId)),
  });
  if (!row) throw new AppError(404, "device_group_not_found", "Device group not found");
  return row;
}

/**
 * 依 (tenantId, code) 查 device_group。Windows enrollment 從 PPKG DiscoveryUrl 的
 * `/g/{code}` 段解析後用此函式落庫。
 *
 * 找不到 → 404 device_group_not_found（caller 自決定要 hard fail 還是 fallback 到
 * 「直屬 tenant」即不寫 deviceGroupId）。
 */
export async function getDeviceGroupByTenantAndCode(opts: {
  tenantId: string;
  code: string;
}) {
  const row = await db.query.deviceGroups.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.code, opts.code), eqOp(t.tenantId, opts.tenantId)),
  });
  if (!row) throw new AppError(404, "device_group_not_found", "Device group not found");
  return row;
}

export async function updateDeviceGroup(opts: {
  tenantId: string;
  deviceGroupId: string;
  input: UpdateDeviceGroupInput;
}) {
  if (opts.input.jamfInstanceId !== undefined && opts.input.jamfInstanceId !== null) {
    await assertJamfBelongsToTenant(opts.tenantId, opts.input.jamfInstanceId);
    await assertJamfNotAlreadyBound(opts.input.jamfInstanceId, opts.deviceGroupId);
  }

  const patch: Record<string, unknown> = {};
  if (opts.input.code !== undefined) patch.code = opts.input.code;
  if (opts.input.displayName !== undefined) patch.displayName = opts.input.displayName;
  if (opts.input.jamfInstanceId !== undefined) {
    patch.jamfInstanceId = opts.input.jamfInstanceId;
  }
  if (Object.keys(patch).length === 0) return getDeviceGroup(opts);
  patch.updatedAt = sql`now()`;

  try {
    const [row] = await db
      .update(deviceGroups)
      .set(patch)
      .where(
        and(eq(deviceGroups.id, opts.deviceGroupId), eq(deviceGroups.tenantId, opts.tenantId)),
      )
      .returning();
    if (!row) {
      throw new AppError(404, "device_group_not_found", "Device group not found");
    }
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        "device_group_code_taken",
        "Code already exists for this tenant",
      );
    }
    throw err;
  }
}

export async function deleteDeviceGroup(opts: { tenantId: string; deviceGroupId: string }) {
  const [row] = await db
    .delete(deviceGroups)
    .where(
      and(eq(deviceGroups.id, opts.deviceGroupId), eq(deviceGroups.tenantId, opts.tenantId)),
    )
    .returning({ id: deviceGroups.id });
  if (!row) throw new AppError(404, "device_group_not_found", "Device group not found");
}

async function assertJamfBelongsToTenant(tenantId: string, jamfInstanceId: string) {
  const row = await db.query.jamfInstances.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, jamfInstanceId), eqOp(t.tenantId, tenantId)),
    columns: { id: true },
  });
  if (!row) {
    throw new AppError(
      400,
      "jamf_instance_not_in_tenant",
      "Jamf instance does not belong to this tenant",
    );
  }
}

/**
 * 校驗 jamf_instance_id 還沒被其它 device_group 綁走（1:1）。
 * excludeDeviceGroupId 用於 update：自己原本就綁的不算衝突。
 */
async function assertJamfNotAlreadyBound(
  jamfInstanceId: string,
  excludeDeviceGroupId?: string,
) {
  const row = await db.query.deviceGroups.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.jamfInstanceId, jamfInstanceId),
    columns: { id: true },
  });
  if (row && row.id !== excludeDeviceGroupId) {
    throw new AppError(
      409,
      "jamf_instance_already_bound",
      "This Jamf instance is already bound to another device group",
    );
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
