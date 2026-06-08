import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.ts";

/**
 * 一個 tenant 可掛 0..N 個 Jamf Pro 實例。
 * client_id / client_secret 預留 _enc 後綴欄位，Phase 3 啟用 envelope encryption。
 */
export const jamfInstances = pgTable(
  "jamf_instances",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    displayName: text().notNull(),
    baseUrl: text().notNull(),
    clientId: text().notNull(),
    clientSecretEnc: text().notNull(),
    appLockGroupId: integer(),
    isActive: boolean().notNull().default(true),
    notes: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("jamf_instances_tenant_idx").on(t.tenantId),
    uniqueIndex("jamf_instances_tenant_baseurl_uq").on(t.tenantId, t.baseUrl),
  ],
);

/**
 * OAuth token 快取（多副本部署時不必每個 process 自己跑一次 client-credentials grant）。
 * 過期前 60s 自動 refresh；rotate 時硬刷一筆即可。
 */
export const jamfTokenCache = pgTable(
  "jamf_token_cache",
  {
    jamfInstanceId: uuid()
      .primaryKey()
      .references(() => jamfInstances.id, { onDelete: "cascade" }),
    accessToken: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("jamf_token_cache_expiry_idx").on(t.expiresAt)],
);

export type JamfInstance = typeof jamfInstances.$inferSelect;
export type NewJamfInstance = typeof jamfInstances.$inferInsert;
