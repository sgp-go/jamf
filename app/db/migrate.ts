import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

// migration 用單獨連線（max=1）跑完即關，避免 dev server pool 卡住
const sql = postgres(databaseUrl, { max: 1, prepare: false });
const db = drizzle(sql);

console.log("Running migrations...");
await migrate(db, { migrationsFolder: "./app/db/migrations" });
console.log("Migrations complete.");

await sql.end();
