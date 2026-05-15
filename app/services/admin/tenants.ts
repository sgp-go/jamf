import { eq, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { AppError } from "~/lib/errors.ts";

export interface CreateTenantInput {
  slug: string;
  displayName: string;
}

export interface UpdateTenantInput {
  displayName?: string;
  isActive?: boolean;
}

export async function createTenant(input: CreateTenantInput) {
  try {
    const [row] = await db.insert(tenants).values(input).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "tenant_slug_taken", `Slug "${input.slug}" already exists`);
    }
    throw err;
  }
}

export function listTenants() {
  return db.select().from(tenants).orderBy(tenants.createdAt);
}

export async function getTenant(id: string) {
  const row = await db.query.tenants.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, id),
  });
  if (!row) throw new AppError(404, "tenant_not_found", "Tenant not found");
  return row;
}

export async function updateTenant(id: string, input: UpdateTenantInput) {
  // Drizzle 的 $onUpdate 只在執行 .update() 時觸發，set 給空物件會直接回 0 row affected
  if (Object.keys(input).length === 0) {
    return getTenant(id);
  }
  const [row] = await db
    .update(tenants)
    .set({ ...input, updatedAt: sql`now()` })
    .where(eq(tenants.id, id))
    .returning();
  if (!row) throw new AppError(404, "tenant_not_found", "Tenant not found");
  return row;
}

export async function deleteTenant(id: string) {
  const [row] = await db.delete(tenants).where(eq(tenants.id, id)).returning({
    id: tenants.id,
  });
  if (!row) throw new AppError(404, "tenant_not_found", "Tenant not found");
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}
