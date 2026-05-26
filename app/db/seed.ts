import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { encryptSecret } from "~/lib/secrets.ts";
import * as schema from "./schema/index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const sql = postgres(databaseUrl, { max: 1, prepare: false });
const db = drizzle(sql, { schema, casing: "snake_case" });

/**
 * 開發用 seed：建立一個 demo tenant + 1 個 device group + 1 個 Jamf instance + 1 個 ASM。
 * 已存在就 skip（slug / displayName 為 idempotent key）。
 */
async function main() {
  const [tenant] = await db
    .insert(schema.tenants)
    .values({
      slug: "demo",
      displayName: "Demo 教育局",
    })
    .onConflictDoNothing({ target: schema.tenants.slug })
    .returning();

  const tenantId =
    tenant?.id ??
    (
      await db.query.tenants.findFirst({
        where: (t, { eq }) => eq(t.slug, "demo"),
      })
    )?.id;

  if (!tenantId) {
    throw new Error("Failed to upsert demo tenant");
  }

  await db
    .insert(schema.deviceGroups)
    .values({
      tenantId,
      code: "demo-group",
      displayName: "Demo 分組",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.jamfInstances)
    .values({
      tenantId,
      displayName: "Demo Jamf",
      baseUrl: process.env.SEED_JAMF_BASE_URL ?? "https://demo.jamfcloud.com",
      clientId: process.env.SEED_JAMF_CLIENT_ID ?? "demo-client-id",
      clientSecretEnc: encryptSecret(
        process.env.SEED_JAMF_CLIENT_SECRET ?? "demo-client-secret",
      ),
    })
    .onConflictDoNothing();

  await db
    .insert(schema.asmInstances)
    .values({
      tenantId,
      displayName: "Demo ASM",
      orgName: "Demo 教育局",
    })
    .onConflictDoNothing();

  console.log(`Seeded demo tenant: ${tenantId}`);
}

await main();
await sql.end();
