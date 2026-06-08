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
 * LAPS-like 密碼託管：納管後 Agent 自動將管理員密碼改為每台隨機值，加密存後端。
 *
 * 每次輪換建一筆 row（audit trail），IT 查的是最新 confirmed 記錄。
 * status 流轉：pending → confirmed | failed
 */
export const mdmWindowsLaps = pgTable(
  "mdm_windows_laps",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    rotationId: uuid().notNull(),
    adminAccount: varchar({ length: 64 }).notNull(),
    passwordEnc: text().notNull(),
    status: varchar({ length: 16 }).notNull().default("pending"),
    commandUuid: varchar({ length: 64 }),
    triggeredBy: varchar({ length: 32 }).notNull().default("auto"),
    confirmedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mdm_windows_laps_device_created_idx").on(t.deviceId, t.createdAt),
    index("mdm_windows_laps_tenant_idx").on(t.tenantId),
    uniqueIndex("mdm_windows_laps_rotation_id_uq").on(t.rotationId),
  ],
);

export type MdmWindowsLaps = typeof mdmWindowsLaps.$inferSelect;
export type NewMdmWindowsLaps = typeof mdmWindowsLaps.$inferInsert;
