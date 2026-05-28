import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  profileAssignments,
  profiles,
  type Profile,
  type ProfileAssignment,
} from "~/db/schema/profiles.ts";
import { AppError } from "~/lib/errors.ts";

/**
 * Profile 引擎 service 層（admin/）。
 *
 * 範圍：CRUD + assign + status + unassign 骨架。差異化推送（profile 變更後計算
 * 增量 / 重推 / 重試）放 W3，這裡只做 schema-level 寫入與查詢。
 *
 * 多租戶隔離：所有查詢與寫入都帶 eq(tenantId)；profile 與 assignment 的 target
 * （device_group / device）都必須屬同一 tenant，由 assertXxxInTenant 把關。
 */

type Platform = "apple" | "windows";
type ProfileStatus = "draft" | "active" | "archived";
type AssignmentScope = "device_group" | "device";

// ============================================================
// CRUD
// ============================================================

export interface CreateProfileInput {
  tenantId: string;
  platform: Platform;
  displayName: string;
  description?: string | null;
  payload: Record<string, unknown>;
  status?: ProfileStatus;
}

export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  const [row] = await db
    .insert(profiles)
    .values({
      tenantId: input.tenantId,
      platform: input.platform,
      displayName: input.displayName,
      description: input.description ?? null,
      payload: input.payload,
      status: input.status ?? "draft",
    })
    .returning();
  if (!row) throw new Error("createProfile: insert returned no row");
  return row;
}

export function listProfiles(opts: {
  tenantId: string;
  platform?: Platform;
  status?: ProfileStatus;
}): Promise<Profile[]> {
  const conditions: SQL[] = [eq(profiles.tenantId, opts.tenantId)];
  if (opts.platform) conditions.push(eq(profiles.platform, opts.platform));
  if (opts.status) conditions.push(eq(profiles.status, opts.status));
  return db
    .select()
    .from(profiles)
    .where(and(...conditions))
    .orderBy(desc(profiles.updatedAt));
}

export async function getProfile(opts: {
  tenantId: string;
  profileId: string;
}): Promise<Profile> {
  const row = await db.query.profiles.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.profileId), eqOp(t.tenantId, opts.tenantId)),
  });
  if (!row) throw new AppError(404, "profile_not_found", "Profile not found");
  return row;
}

export interface UpdateProfileInput {
  displayName?: string;
  description?: string | null;
  /** 更新 payload 會將 version 自增 1（其餘欄位不 bump version） */
  payload?: Record<string, unknown>;
  status?: ProfileStatus;
}

/**
 * 更新 profile。payload 變更 → version+1（用 SQL `version + 1` 避免讀-改-寫競態）；
 * 其餘欄位（displayName / description / status）變更不影響 version。
 */
export async function updateProfile(opts: {
  tenantId: string;
  profileId: string;
  input: UpdateProfileInput;
}): Promise<Profile> {
  const patch: Record<string, unknown> = {};
  if (opts.input.displayName !== undefined) patch.displayName = opts.input.displayName;
  if (opts.input.description !== undefined) patch.description = opts.input.description;
  if (opts.input.payload !== undefined) {
    patch.payload = opts.input.payload;
    patch.version = sql`${profiles.version} + 1`;
  }
  if (opts.input.status !== undefined) patch.status = opts.input.status;
  if (Object.keys(patch).length === 0) return getProfile(opts);

  const [row] = await db
    .update(profiles)
    .set(patch)
    .where(
      and(eq(profiles.id, opts.profileId), eq(profiles.tenantId, opts.tenantId)),
    )
    .returning();
  if (!row) throw new AppError(404, "profile_not_found", "Profile not found");
  return row;
}

export async function deleteProfile(opts: {
  tenantId: string;
  profileId: string;
}): Promise<void> {
  // cascade onDelete 自動清 profile_assignments 與 status 紀錄
  const [row] = await db
    .delete(profiles)
    .where(
      and(eq(profiles.id, opts.profileId), eq(profiles.tenantId, opts.tenantId)),
    )
    .returning({ id: profiles.id });
  if (!row) throw new AppError(404, "profile_not_found", "Profile not found");
}

// ============================================================
// Assignment（assign / status / unassign）
// ============================================================

export interface AssignProfileInput {
  scope: AssignmentScope;
  /** scope=device_group 時必填 */
  deviceGroupId?: string;
  /** scope=device 時必填 */
  deviceId?: string;
}

/**
 * 指派 profile 給 device_group 或單一 device。
 *
 * - scope 與 target id 必須配對（zod 未強制 refine，service 層守護）
 * - target 必須屬同 tenant（assertXxxInTenant）
 * - partial unique 索引（profile×group / profile×device）防重複；23505 → 409
 * - 初始 status='pending'，待 W3 推送引擎 ack 後改 applied / failed
 */
export async function assignProfile(opts: {
  tenantId: string;
  profileId: string;
  input: AssignProfileInput;
}): Promise<ProfileAssignment> {
  await getProfile(opts);

  if (opts.input.scope === "device_group") {
    if (!opts.input.deviceGroupId) {
      throw new AppError(
        400,
        "device_group_id_required",
        "scope=device_group requires deviceGroupId",
      );
    }
    if (opts.input.deviceId) {
      throw new AppError(
        400,
        "device_id_not_allowed",
        "scope=device_group should not include deviceId",
      );
    }
    await assertDeviceGroupInTenant(opts.tenantId, opts.input.deviceGroupId);
  } else {
    if (!opts.input.deviceId) {
      throw new AppError(
        400,
        "device_id_required",
        "scope=device requires deviceId",
      );
    }
    if (opts.input.deviceGroupId) {
      throw new AppError(
        400,
        "device_group_id_not_allowed",
        "scope=device should not include deviceGroupId",
      );
    }
    await assertDeviceInTenant(opts.tenantId, opts.input.deviceId);
  }

  try {
    const [row] = await db
      .insert(profileAssignments)
      .values({
        tenantId: opts.tenantId,
        profileId: opts.profileId,
        scope: opts.input.scope,
        deviceGroupId: opts.input.deviceGroupId ?? null,
        deviceId: opts.input.deviceId ?? null,
        status: "pending",
      })
      .returning();
    if (!row) throw new Error("assignProfile: insert returned no row");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        "profile_already_assigned",
        "Profile already assigned to this target",
      );
    }
    throw err;
  }
}

/**
 * 查詢 profile 的所有 assignment（含套用狀態）。
 *
 * 先校驗 profile 屬同 tenant（404 優先於空 list）。
 */
export async function listProfileAssignments(opts: {
  tenantId: string;
  profileId: string;
}): Promise<ProfileAssignment[]> {
  await getProfile(opts);
  return db
    .select()
    .from(profileAssignments)
    .where(
      and(
        eq(profileAssignments.tenantId, opts.tenantId),
        eq(profileAssignments.profileId, opts.profileId),
      ),
    )
    .orderBy(desc(profileAssignments.assignedAt));
}

export async function unassignProfile(opts: {
  tenantId: string;
  profileId: string;
  assignmentId: string;
}): Promise<void> {
  const [row] = await db
    .delete(profileAssignments)
    .where(
      and(
        eq(profileAssignments.id, opts.assignmentId),
        eq(profileAssignments.profileId, opts.profileId),
        eq(profileAssignments.tenantId, opts.tenantId),
      ),
    )
    .returning({ id: profileAssignments.id });
  if (!row) {
    throw new AppError(404, "assignment_not_found", "Assignment not found");
  }
}

// ============================================================
// 內部：target 屬租戶校驗
// ============================================================

async function assertDeviceGroupInTenant(
  tenantId: string,
  deviceGroupId: string,
): Promise<void> {
  const row = await db.query.deviceGroups.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, deviceGroupId), eqOp(t.tenantId, tenantId)),
    columns: { id: true },
  });
  if (!row) {
    throw new AppError(
      400,
      "device_group_not_in_tenant",
      "Device group does not belong to this tenant",
    );
  }
}

async function assertDeviceInTenant(
  tenantId: string,
  deviceId: string,
): Promise<void> {
  const row = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, deviceId), eqOp(t.tenantId, tenantId)),
    columns: { id: true },
  });
  if (!row) {
    throw new AppError(
      400,
      "device_not_in_tenant",
      "Device does not belong to this tenant",
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
