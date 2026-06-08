import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { mdmDevices } from "./devices.ts";
import { tenants } from "./tenants.ts";

/**
 * BitLocker Recovery Key 託管：加密後 Agent 捕獲 Recovery Password 上報存儲。
 *
 * 每次加密建一筆 row（audit trail），IT 查的是最新 confirmed 記錄。
 * status 流轉：pending → confirmed | failed
 */
export const mdmWindowsBitlocker = pgTable(
  "mdm_windows_bitlocker",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    encryptionId: uuid().notNull(),
    recoveryPasswordEnc: text(),
    encryptionMethod: varchar({ length: 32 }),
    status: varchar({ length: 16 }).notNull().default("pending"),
    commandUuid: varchar({ length: 64 }),
    triggeredBy: varchar({ length: 32 }).notNull().default("auto"),
    confirmedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mdm_windows_bitlocker_device_created_idx").on(t.deviceId, t.createdAt),
    index("mdm_windows_bitlocker_tenant_idx").on(t.tenantId),
    uniqueIndex("mdm_windows_bitlocker_encryption_id_uq").on(t.encryptionId),
  ],
);

export type MdmWindowsBitlocker = typeof mdmWindowsBitlocker.$inferSelect;
export type NewMdmWindowsBitlocker = typeof mdmWindowsBitlocker.$inferInsert;
