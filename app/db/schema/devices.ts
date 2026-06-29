import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
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
import { asmInstances } from "./asm.ts";
import { jamfInstances } from "./jamf.ts";
import { selfMdmConfigs } from "./self-mdm.ts";
import { deviceGroups, tenants } from "./tenants.ts";

export const platformEnum = pgEnum("device_platform", ["apple", "windows"]);
export const enrollmentStatusEnum = pgEnum("mdm_enrollment_status", [
  "pending",
  "enrolled",
  "unenrolled",
  "failed",
]);
export const commandStatusEnum = pgEnum("mdm_command_status", [
  "queued",
  "sent",
  "acknowledged",
  "error",
  "not_now",
  "idle",
  "expired",
]);

/**
 * MDM 設備（Apple + Windows 共用本表）。
 *
 * - tenant_id：所有查詢的第一條件
 * - device_group_id：設備分組歸屬（操作員可見性邊界 + 批次派送單位）
 * - jamf_instance_id：若同時被 Jamf 管理（遷移過渡期可能與 self_mdm_managed=true 並存）
 * - self_mdm_managed：是否被本系統的自建 MDM 直接管理
 * - asm_instance_id：DEP 註冊來源（若非 DEP 註冊則為 null）
 */
export const mdmDevices = pgTable(
  "mdm_devices",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    deviceGroupId: uuid().references(() => deviceGroups.id, { onDelete: "set null" }),
    jamfInstanceId: uuid().references(() => jamfInstances.id, { onDelete: "set null" }),
    asmInstanceId: uuid().references(() => asmInstances.id, { onDelete: "set null" }),
    selfMdmConfigId: uuid().references(() => selfMdmConfigs.id, { onDelete: "set null" }),

    platform: platformEnum().notNull().default("apple"),
    udid: varchar({ length: 64 }),
    serialNumber: varchar({ length: 64 }),
    deviceName: text(),
    model: text(),
    osVersion: text(),

    // Jamf 那邊的 id（同步時填寫，用於後續命令派發）
    jamfDeviceId: varchar({ length: 32 }),
    jamfManagementId: varchar({ length: 64 }),
    lastSyncedAt: timestamp({ withTimezone: true }),

    // Apple MDM 協議用
    pushToken: text(),
    pushMagic: text(),
    unlockToken: text(),
    topic: text(),

    // Windows MDM
    windowsDeviceId: text(),
    windowsHardwareId: text(),
    wnsChannelUri: text(),
    wnsChannelExpiry: timestamp({ withTimezone: true }),
    managementSessionState: jsonb().$type<Record<string, unknown>>(),

    // Lost Mode
    lostModeEnabled: boolean().notNull().default(false),
    lostModeMessage: text(),
    lostModePhone: text(),
    lostModeFootnote: text(),
    lostModeEnabledAt: timestamp({ withTimezone: true }),

    // Agent App 對接（install-agent 一鍵流程）
    agentTokenHash: varchar({ length: 128 }),
    agentTokenIssuedAt: timestamp({ withTimezone: true }),
    agentInstalledAt: timestamp({ withTimezone: true }),
    agentAppId: uuid(),

    // 採購 Inventory（PRD §5.7 — 設備生命週期管理用）
    // purchasePriceCents：用 cents 整數避免浮點；purchaseCurrency 預設 TWD
    purchaseDate: date(),
    purchaseVendor: text(),
    purchasePriceCents: bigint({ mode: "number" }),
    purchaseCurrency: varchar({ length: 3 }),
    warrantyEndDate: date(),

    selfMdmManaged: boolean().notNull().default(false),
    enrollmentType: varchar({ length: 32 }).default("dep"),
    enrollmentStatus: enrollmentStatusEnum().notNull().default("pending"),
    enrolledAt: timestamp({ withTimezone: true }).defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }),

    deviceInfo: jsonb().$type<Record<string, unknown>>(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("mdm_devices_tenant_idx").on(t.tenantId),
    index("mdm_devices_device_group_idx").on(t.deviceGroupId),
    index("mdm_devices_jamf_idx").on(t.jamfInstanceId),
    index("mdm_devices_platform_idx").on(t.platform),
    uniqueIndex("mdm_devices_tenant_udid_uq")
      .on(t.tenantId, t.udid)
      .where(sql`${t.udid} IS NOT NULL`),
    uniqueIndex("mdm_devices_tenant_serial_uq")
      .on(t.tenantId, t.serialNumber)
      .where(sql`${t.serialNumber} IS NOT NULL`),
    uniqueIndex("mdm_devices_windows_device_id_uq")
      .on(t.windowsDeviceId)
      .where(sql`${t.windowsDeviceId} IS NOT NULL`),
    // 同個 Jamf 實例底下 jamf_device_id 唯一（同步用 upsert 鍵）
    uniqueIndex("mdm_devices_jamf_instance_device_id_uq")
      .on(t.jamfInstanceId, t.jamfDeviceId)
      .where(sql`${t.jamfDeviceId} IS NOT NULL`),
  ],
);

/**
 * MDM 命令（Apple plist 與 Windows SyncML 共用）。
 */
export const mdmCommands = pgTable(
  "mdm_commands",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    commandUuid: varchar({ length: 64 }).notNull(),
    platform: platformEnum().notNull().default("apple"),
    commandType: varchar({ length: 64 }).notNull(),
    status: commandStatusEnum().notNull().default("queued"),
    requestPayload: jsonb().notNull(),
    responsePayload: jsonb(),
    errorChain: jsonb(),

    // Windows MDM SyncML 專用
    cspPath: text(),
    syncmlVerb: varchar({ length: 16 }),
    syncmlData: text(),
    syncmlFormat: varchar({ length: 16 }),
    sessionMsgId: varchar({ length: 32 }),

    queuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp({ withTimezone: true }),
    respondedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("mdm_commands_uuid_uq").on(t.commandUuid),
    index("mdm_commands_device_idx").on(t.deviceId),
    index("mdm_commands_status_idx").on(t.status),
    index("mdm_commands_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Jamf → 自建 MDM 遷移狀態（每台設備一筆）。
 */
export const mdmMigrations = pgTable(
  "mdm_migrations",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid().references(() => mdmDevices.id, { onDelete: "set null" }),
    serialNumber: varchar({ length: 64 }).notNull(),
    jamfDeviceId: text(),
    jamfManagementId: text(),
    status: varchar({ length: 32 }).notNull().default("pending"),
    errorMessage: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("mdm_migrations_tenant_idx").on(t.tenantId),
    index("mdm_migrations_serial_idx").on(t.serialNumber),
  ],
);

/**
 * Windows 設備上的 App 清單（裝置回報 AppInventory 後 upsert）。
 *
 * 對應 src/ 端 mdm_windows_apps（SQLite，W2 OMA-DM 協議層搬遷時遷過來）。
 * 差異：device_udid TEXT FK → deviceId UUID FK + 多了 tenantId。
 */
export const mdmWindowsApps = pgTable(
  "mdm_windows_apps",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    packageFamilyName: text().notNull(),
    displayName: text(),
    version: text(),
    installState: varchar({ length: 32 }),
    lastSyncedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mdm_windows_apps_device_pfn_uq").on(t.deviceId, t.packageFamilyName),
    index("mdm_windows_apps_device_idx").on(t.deviceId),
    index("mdm_windows_apps_tenant_idx").on(t.tenantId),
  ],
);

export type MdmDevice = typeof mdmDevices.$inferSelect;
export type NewMdmDevice = typeof mdmDevices.$inferInsert;
export type MdmCommand = typeof mdmCommands.$inferSelect;
export type MdmWindowsApp = typeof mdmWindowsApps.$inferSelect;
