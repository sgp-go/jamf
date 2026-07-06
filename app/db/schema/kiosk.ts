import { sql } from "drizzle-orm";
import {
  boolean,
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
import { mdmDevices } from "./devices.ts";
import { deviceGroups, tenants } from "./tenants.ts";

/**
 * Kiosk Mode（PRD Phase 3 — 單一 App 模式）
 *
 * Windows AssignedAccess CSP 單 App Kiosk：
 *   - `edge_kiosk`：鎖 Microsoft Edge，兩個子模式 public-browsing / digital-signage
 *   - `uwp`：鎖任意 UWP，需指定 AUMID
 *
 * SKU 限制：Win10/11 Pro 只支援單 App UWP Kiosk（含 Edge Kiosk）。
 * Win32 exe Kiosk 需要 Enterprise/Education（Shell Launcher CSP），本期不做。
 *
 * 退出機制（兩條路徑）：
 *   1) 主要：服務端 admin API `/kiosk/disable` → Delete verb 撤除 → 恢復桌面
 *   2) 應急：可選 breakoutSequence（如 Ctrl+Alt+B）+ ITAdmin 帳戶登入
 *      （密碼走現有 LAPS 通道查詢；學生本人無 admin 密碼故無法退出）
 */

export const kioskAppTypeEnum = pgEnum("kiosk_app_type", [
  "edge_kiosk",
  "uwp",
]);

export const kioskEdgeVariantEnum = pgEnum("kiosk_edge_variant", [
  "public_browsing",
  "digital_signage",
]);

export const kioskAssignmentScopeEnum = pgEnum("kiosk_assignment_scope", [
  "device_group",
  "device",
]);

export const kioskStateStatusEnum = pgEnum("kiosk_state_status", [
  "pending",
  "active",
  "failed",
  "removed",
]);

/**
 * Kiosk profile 模板（tenant scoped）。
 *
 * version：每次更新 payload（appType/edgeUrl/aumid/breakout 等）自增，
 *          device state 比對 appliedVersion 決定是否需重派。
 * CHECK constraint（migration 手動加）：
 *   appType='edge_kiosk' → edgeUrl NOT NULL AND edgeVariant NOT NULL
 *   appType='uwp'        → aumid NOT NULL
 */
export const kioskProfiles = pgTable(
  "kiosk_profiles",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar({ length: 128 }).notNull(),
    description: text(),
    appType: kioskAppTypeEnum().notNull(),
    /** edge_kiosk：啟動 URL（如 https://exam.school.edu.tw） */
    edgeUrl: varchar({ length: 2048 }),
    /** edge_kiosk：public_browsing=考試/公用；digital_signage=展示 */
    edgeVariant: kioskEdgeVariantEnum(),
    /** uwp：AppUserModelId（Get-StartApps 取得） */
    aumid: text(),
    /** AutoLogon 的本機帳號（PPKG 建的學生帳號） */
    autoLogonAccount: varchar({ length: 64 }).notNull().default("student"),
    /**
     * 應急退出組合鍵，e.g. "Ctrl+B"；null=完全禁止 breakout。
     * ⚠️ **必須雙鍵（modifier + key），三鍵組合如 Ctrl+Alt+B 不生效**——
     * Alt 修飾鍵在 Chromium Edge Kiosk 全屏下被 Edge/Windows shell 攔截
     * （PF5XSMN1 2026-07-06 真機驗證）。MS 官方所有 sample 都是雙鍵。
     * 觸發後需輸入 admin 密碼（ITAdmin，走現有 LAPS 通道查詢）。
     */
    breakoutSequence: varchar({ length: 64 }),
    /**
     * Edge URL 白名單（可選，僅對 edge_kiosk 生效）：非 null 表示 kiosk 期間
     * Edge 只准訪問這裡列出的 URL pattern，其他一律 blocked。null 或空陣列 =
     * 不加白名單，靠 --edge-kiosk-type=public-browsing 本身的限制。
     * 語法同 Chromium `URLAllowlist` policy（例：
     * `["exam.school.edu.tw", "*.gov.edu.tw"]`）。
     */
    allowedUrls: jsonb().$type<string[]>(),
    version: integer().notNull().default(1),
    createdBy: varchar({ length: 128 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("kiosk_profiles_tenant_idx").on(t.tenantId),
    uniqueIndex("kiosk_profiles_tenant_name_uq").on(t.tenantId, t.name),
  ],
);

/**
 * Kiosk × (device_group | device) 指派關係。
 * device 層級指派優先於 device_group（同一設備同時存在時取 device 層）。
 * 每台設備同時只能有一個生效的 kiosk profile。
 */
export const kioskAssignments = pgTable(
  "kiosk_assignments",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    profileId: uuid()
      .notNull()
      .references(() => kioskProfiles.id, { onDelete: "cascade" }),
    scope: kioskAssignmentScopeEnum().notNull(),
    deviceGroupId: uuid().references(() => deviceGroups.id, {
      onDelete: "cascade",
    }),
    deviceId: uuid().references(() => mdmDevices.id, { onDelete: "cascade" }),
    createdBy: varchar({ length: 128 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("kiosk_assignments_profile_idx").on(t.profileId),
    index("kiosk_assignments_device_group_idx").on(t.deviceGroupId),
    index("kiosk_assignments_device_idx").on(t.deviceId),
    uniqueIndex("kiosk_assignments_profile_group_uq")
      .on(t.profileId, t.deviceGroupId)
      .where(sql`${t.scope} = 'device_group' AND ${t.deviceGroupId} IS NOT NULL`),
    uniqueIndex("kiosk_assignments_profile_device_uq")
      .on(t.profileId, t.deviceId)
      .where(sql`${t.scope} = 'device' AND ${t.deviceId} IS NOT NULL`),
  ],
);

/**
 * 每設備當前生效的 kiosk 狀態（一台設備最多一筆）。
 * status='removed' 表示曾派過但已 disable。
 */
export const kioskDeviceStates = pgTable(
  "kiosk_device_states",
  {
    deviceId: uuid()
      .primaryKey()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    profileId: uuid().references(() => kioskProfiles.id, {
      onDelete: "set null",
    }),
    status: kioskStateStatusEnum().notNull().default("pending"),
    /** 上次成功 apply 到設備的 profile.version；null=尚未確認 */
    appliedVersion: integer(),
    lastCommandId: uuid(),
    errorDetail: text(),
    deployedAt: timestamp({ withTimezone: true }),
    removedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("kiosk_device_states_tenant_idx").on(t.tenantId),
    index("kiosk_device_states_status_idx").on(t.status),
  ],
);

export type KioskProfile = typeof kioskProfiles.$inferSelect;
export type NewKioskProfile = typeof kioskProfiles.$inferInsert;
export type KioskAssignment = typeof kioskAssignments.$inferSelect;
export type NewKioskAssignment = typeof kioskAssignments.$inferInsert;
export type KioskDeviceState = typeof kioskDeviceStates.$inferSelect;
export type NewKioskDeviceState = typeof kioskDeviceStates.$inferInsert;
