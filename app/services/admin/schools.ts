import { and, eq, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { jamfInstances } from "~/db/schema/jamf.ts";
import { schools } from "~/db/schema/tenants.ts";
import { AppError } from "~/lib/errors.ts";

export interface CreateSchoolInput {
  tenantId: string;
  code: string;
  displayName: string;
  kind?: "school" | "headquarters";
  jamfInstanceId?: string | null;
}

export interface UpdateSchoolInput {
  code?: string;
  displayName?: string;
  kind?: "school" | "headquarters";
  jamfInstanceId?: string | null;
}

export async function createSchool(input: CreateSchoolInput) {
  if (input.jamfInstanceId) {
    await assertJamfBelongsToTenant(input.tenantId, input.jamfInstanceId);
    await assertJamfNotAlreadyBound(input.jamfInstanceId);
  }
  try {
    const [row] = await db
      .insert(schools)
      .values({
        tenantId: input.tenantId,
        code: input.code,
        displayName: input.displayName,
        kind: input.kind ?? "school",
        jamfInstanceId: input.jamfInstanceId ?? null,
      })
      .returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        "school_code_taken",
        `Code "${input.code}" already exists for this tenant`,
      );
    }
    if (isForeignKeyViolation(err)) {
      throw new AppError(404, "tenant_not_found", "Tenant not found");
    }
    throw err;
  }
}

export function listSchools(tenantId: string) {
  return db
    .select()
    .from(schools)
    .where(eq(schools.tenantId, tenantId))
    .orderBy(schools.kind, schools.code);
}

export async function getSchool(opts: { tenantId: string; schoolId: string }) {
  const row = await db.query.schools.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.schoolId), eqOp(t.tenantId, opts.tenantId)),
  });
  if (!row) throw new AppError(404, "school_not_found", "School not found");
  return row;
}

export async function updateSchool(opts: {
  tenantId: string;
  schoolId: string;
  input: UpdateSchoolInput;
}) {
  if (opts.input.jamfInstanceId !== undefined && opts.input.jamfInstanceId !== null) {
    await assertJamfBelongsToTenant(opts.tenantId, opts.input.jamfInstanceId);
    await assertJamfNotAlreadyBound(opts.input.jamfInstanceId, opts.schoolId);
  }

  const patch: Record<string, unknown> = {};
  if (opts.input.code !== undefined) patch.code = opts.input.code;
  if (opts.input.displayName !== undefined) patch.displayName = opts.input.displayName;
  if (opts.input.kind !== undefined) patch.kind = opts.input.kind;
  if (opts.input.jamfInstanceId !== undefined) {
    patch.jamfInstanceId = opts.input.jamfInstanceId;
  }
  if (Object.keys(patch).length === 0) return getSchool(opts);
  patch.updatedAt = sql`now()`;

  try {
    const [row] = await db
      .update(schools)
      .set(patch)
      .where(and(eq(schools.id, opts.schoolId), eq(schools.tenantId, opts.tenantId)))
      .returning();
    if (!row) throw new AppError(404, "school_not_found", "School not found");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "school_code_taken", "Code already exists for this tenant");
    }
    throw err;
  }
}

export async function deleteSchool(opts: { tenantId: string; schoolId: string }) {
  const [row] = await db
    .delete(schools)
    .where(and(eq(schools.id, opts.schoolId), eq(schools.tenantId, opts.tenantId)))
    .returning({ id: schools.id });
  if (!row) throw new AppError(404, "school_not_found", "School not found");
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
 * 校驗 jamf_instance_id 還沒被其它 school 綁走（1:1）。
 * excludeSchoolId 用於 update：自己原本就綁的不算衝突。
 */
async function assertJamfNotAlreadyBound(jamfInstanceId: string, excludeSchoolId?: string) {
  const row = await db.query.schools.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.jamfInstanceId, jamfInstanceId),
    columns: { id: true },
  });
  if (row && row.id !== excludeSchoolId) {
    throw new AppError(
      409,
      "jamf_instance_already_bound",
      "This Jamf instance is already bound to another school",
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
