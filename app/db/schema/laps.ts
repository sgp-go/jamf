import {
  boolean,
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
 * 使用者密碼託管（原 LAPS，2026-07-03 擴展成通用「重設任意本機帳號密碼」）：
 *
 * 兩類語意共用此表：
 *   - accountType='admin'：LAPS 自動輪換 / 手動觸發 admin 密碼隨機化，IT 查最新明文用
 *   - accountType='student'：管理員手動重設學生帳號密碼（明碼指定 / 隨機生成）
 *
 * 每次重設建一筆 row（audit trail），IT 查的是最新 confirmed 記錄。
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
    /** 目標本機帳號名（原 adminAccount 語意擴展）；與 accountType 一起決定用途 */
    adminAccount: varchar({ length: 64 }).notNull(),
    /** 'admin' = LAPS 自動輪換管理員；'student' = 管理員重設學生帳號；'other' 保留擴展 */
    accountType: varchar({ length: 16 }).notNull().default("admin"),
    /** true = 派發時附帶 net user /logonpasswordchg:yes，強制帳號下次登入改密 */
    requireChangeOnFirstLogon: boolean().notNull().default(false),
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
    // 便於查詢：某設備上某帳號的最新 confirmed 密碼
    index("mdm_windows_laps_device_account_idx").on(
      t.deviceId,
      t.adminAccount,
      t.createdAt,
    ),
    uniqueIndex("mdm_windows_laps_rotation_id_uq").on(t.rotationId),
  ],
);

export type MdmWindowsLaps = typeof mdmWindowsLaps.$inferSelect;
export type NewMdmWindowsLaps = typeof mdmWindowsLaps.$inferInsert;
