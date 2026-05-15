import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.ts";

/**
 * Apple School Manager 實例。
 * 一個 tenant 可有多個 ASM（不同教育局 / 不同採購批次）。
 * 與 jamfInstances 是多對多：實際綁定關係由設備上的 jamf_instance_id 自然決定。
 */
export const asmInstances = pgTable(
  "asm_instances",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    displayName: text().notNull(),
    orgName: text(),
    orgEmail: text(),
    orgAddress: text(),
    isActive: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("asm_instances_tenant_idx").on(t.tenantId)],
);

/**
 * DEP server token（由 ABM 上傳的 .p7m 解密後得到的 OAuth 憑據）。
 * 一個 ASM 通常只有一張 active token，輪換時可能短暫並存兩張。
 */
export const depTokens = pgTable(
  "dep_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    asmInstanceId: uuid()
      .notNull()
      .references(() => asmInstances.id, { onDelete: "cascade" }),
    serverName: text(),
    consumerKey: text().notNull(),
    consumerSecretEnc: text().notNull(),
    accessToken: text().notNull(),
    accessSecretEnc: text().notNull(),
    tokenExpiry: timestamp({ withTimezone: true }),
    isActive: boolean().notNull().default(true),
    lastSyncedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("dep_tokens_asm_idx").on(t.asmInstanceId),
    index("dep_tokens_expiry_idx").on(t.tokenExpiry),
    uniqueIndex("dep_tokens_active_per_asm_uq")
      .on(t.asmInstanceId)
      .where(sql`${t.isActive} = true`),
  ],
);

/**
 * 從 DEP 同步回來的設備清單（裝置註冊前的「待領」狀態）。
 * 註冊完成後與 mdm_devices 對齊。
 */
export const depDevices = pgTable(
  "dep_devices",
  {
    id: uuid().primaryKey().defaultRandom(),
    asmInstanceId: uuid()
      .notNull()
      .references(() => asmInstances.id, { onDelete: "cascade" }),
    serialNumber: varchar({ length: 64 }).notNull(),
    model: text(),
    description: text(),
    color: text(),
    deviceFamily: text(),
    os: text(),
    profileUuid: varchar({ length: 64 }),
    profileStatus: varchar({ length: 32 }).default("empty"),
    extra: jsonb().$type<Record<string, unknown>>(),
    depSyncedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dep_devices_asm_serial_uq").on(t.asmInstanceId, t.serialNumber),
    index("dep_devices_serial_idx").on(t.serialNumber),
  ],
);

export type AsmInstance = typeof asmInstances.$inferSelect;
export type DepToken = typeof depTokens.$inferSelect;
export type DepDevice = typeof depDevices.$inferSelect;
