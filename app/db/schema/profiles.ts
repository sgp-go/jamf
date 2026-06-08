import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { mdmDevices, platformEnum } from "./devices.ts";
import { deviceGroups, tenants } from "./tenants.ts";

/**
 * 配置描述檔狀態：
 *   draft    - 編輯中，不會被派發
 *   active   - 已發布，可被指派
 *   archived - 已封存，不再派發但保留歷史
 */
export const profileStatusEnum = pgEnum("profile_status", [
  "draft",
  "active",
  "archived",
]);

export const profileAssignmentScopeEnum = pgEnum("profile_assignment_scope", [
  "device_group",
  "device",
]);

export const profileAssignmentStatusEnum = pgEnum("profile_assignment_status", [
  "pending",
  "applied",
  "failed",
  "removed",
]);

/**
 * 配置描述檔（Configuration Profile）。
 *
 * 一份 profile 對應一組相關設定（WiFi、密碼政策、Defender、USB 禁用 等），
 * 內容存在 payload jsonb 中，由各 CSP / Apple Profile 引擎在派發時解讀。
 *
 * version：每次更新內容自增，方便比對設備已套用的版本決定要不要重推。
 * payload 結構範例（Windows）：
 *   {
 *     "csps": [
 *       { "path": "./Vendor/MSFT/Policy/Config/DeviceLock/DevicePasswordEnabled", "value": "1" },
 *       { "path": "./Vendor/MSFT/WiFi/...", "value": "..." }
 *     ]
 *   }
 * payload 結構範例（Apple）：
 *   {
 *     "payloadContent": [
 *       { "PayloadType": "com.apple.wifi.managed", "SSID_STR": "...", ... }
 *     ]
 *   }
 */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    platform: platformEnum().notNull(),
    displayName: text().notNull(),
    description: text(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: profileStatusEnum().notNull().default("draft"),
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("profiles_tenant_idx").on(t.tenantId),
    index("profiles_platform_status_idx").on(t.platform, t.status),
  ],
);

/**
 * Profile × (device_group | device) 指派關係。
 *
 * applied_version：實際套用到設備上的 profile.version；對齊就跳過重推。
 * device 層級指派優先於 device_group（同一設備兩種指派同時存在時取 device 層）。
 */
export const profileAssignments = pgTable(
  "profile_assignments",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    scope: profileAssignmentScopeEnum().notNull(),
    deviceGroupId: uuid().references(() => deviceGroups.id, { onDelete: "cascade" }),
    deviceId: uuid().references(() => mdmDevices.id, { onDelete: "cascade" }),
    status: profileAssignmentStatusEnum().notNull().default("pending"),
    appliedVersion: integer(),
    lastCommandId: uuid(),
    errorMessage: text(),
    assignedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp({ withTimezone: true }),
    removedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("profile_assignments_profile_idx").on(t.profileId),
    index("profile_assignments_device_group_idx").on(t.deviceGroupId),
    index("profile_assignments_device_idx").on(t.deviceId),
    index("profile_assignments_status_idx").on(t.status),
    uniqueIndex("profile_assignments_profile_group_uq")
      .on(t.profileId, t.deviceGroupId)
      .where(sql`${t.scope} = 'device_group' AND ${t.deviceGroupId} IS NOT NULL`),
    uniqueIndex("profile_assignments_profile_device_uq")
      .on(t.profileId, t.deviceId)
      .where(sql`${t.scope} = 'device' AND ${t.deviceId} IS NOT NULL`),
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type ProfileAssignment = typeof profileAssignments.$inferSelect;
