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

  // self_mdm_config：自建 MDM 的 per-tenant CA + enrollment 配置。
  // CA 從 src/ 既有的 certs/ca_*.pem 讀進來重用，這樣 W1-8 真機 enroll 過的
  // device cert 仍被同一根 CA 認（換 CA 會讓既有 device cert 失效）。
  let caCertPem: string | null = null;
  let caKeyPem: string | null = null;
  try {
    caCertPem = Deno.readTextFileSync("certs/ca_cert.pem");
    caKeyPem = Deno.readTextFileSync("certs/ca_key.pem");
  } catch {
    console.warn(
      "[seed] certs/ca_*.pem 不存在，self_mdm_config CA 留 null（enrollment 前需補 CA）",
    );
  }

  await db
    .insert(schema.selfMdmConfigs)
    .values({
      tenantId,
      publicBaseUrl: process.env.SEED_PUBLIC_BASE_URL ??
        "https://example.ngrok-free.app",
      caCertPem,
      caKeyPemEnc: caKeyPem ? encryptSecret(caKeyPem) : null,
    })
    .onConflictDoNothing({ target: schema.selfMdmConfigs.tenantId });

  console.log(
    `Seeded demo tenant: ${tenantId} (self_mdm_config CA: ${
      caCertPem ? "from certs/" : "null"
    })`,
  );
}

await main();
await sql.end();
