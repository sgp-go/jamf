/**
 * Geofence 地理圍欄（PRD §6 Future）。
 *
 * 學校場景「設備離開校園觸發警報」：admin 定義多邊形圍欄，設備關聯後 Agent
 * GPS 上報時後端計算 point-in-polygon，發生 inside↔outside 切換就發 webhook
 * `device.geofence_enter` / `device.geofence_exit`。前端接 webhook 可自動派
 * Lost Mode / 鎖屏 / 通知老師。
 *
 * MVP schema 設計要點：
 *   - polygon 用 jsonb 存 `{lat, lng}[]` 陣列（3+ 個頂點；閉合由 Ray casting 算法處理）
 *   - 不用 PostGIS 擴展（部署簡單；學校規模 point-in-polygon 純 JS 秒級足夠）
 *   - 多對多 assignment：一台設備可屬多個 geofence（跨校區）；一個 geofence 可覆蓋多台
 *   - state 表只保當前狀態 + 最後 transition 時間，歷史事件靠 webhook 分發（避免建
 *     transition 歷史表；有需要看 webhook_deliveries）
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { mdmDevices } from "./devices.ts";
import { tenants } from "./tenants.ts";

/** polygon 頂點：GPS 座標 (WGS84) */
export interface GeofencePoint {
  lat: number;
  lng: number;
}

/**
 * Geofence 定義。
 * polygon 至少 3 個頂點；閉合由算法內部處理（不強制首尾相同）。
 */
export const geofences = pgTable(
  "geofences",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar({ length: 128 }).notNull(),
    description: text(),
    /** 多邊形頂點陣列，順時針 / 逆時針皆可 */
    polygon: jsonb().$type<GeofencePoint[]>().notNull(),
    /** 啟用中的 geofence 才會參與計算；false=暫停 */
    isActive: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("geofences_tenant_idx").on(t.tenantId),
    index("geofences_active_idx").on(t.isActive),
    uniqueIndex("geofences_tenant_name_uq").on(t.tenantId, t.name),
  ],
);

/**
 * 設備 × geofence 多對多 assignment。
 * 台灣團隊 UI 可批量選設備 assign / unassign。
 */
export const deviceGeofenceAssignments = pgTable(
  "device_geofence_assignments",
  {
    deviceId: uuid()
      .notNull()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    geofenceId: uuid()
      .notNull()
      .references(() => geofences.id, { onDelete: "cascade" }),
    assignedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.geofenceId] }),
    index("device_geofence_assignments_geofence_idx").on(t.geofenceId),
  ],
);

/**
 * 設備 × geofence 的當前 inside/outside 狀態。
 *
 * 為什麼獨立表而不用 assignment.status：
 *   - 未 assign 但誤採到 GPS 的設備不會落 state，減少無效資料
 *   - assignment 語意=admin 管理意圖；state 語意=實測位置。分離避免混淆
 *
 * 唯一約束 (deviceId, geofenceId)：一筆 row 只代表一組關係的當前狀態，
 * 每次 transition upsert 覆蓋。歷史事件靠 webhook 分發（webhook_deliveries
 * 表本身是完整審計，不再建 transition 歷史表）。
 */
export const deviceGeofenceStates = pgTable(
  "device_geofence_states",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    geofenceId: uuid()
      .notNull()
      .references(() => geofences.id, { onDelete: "cascade" }),
    /** inside | outside — 當前狀態 */
    status: varchar({ length: 16 }).notNull(),
    /** 對應 GPS 座標（transition 發生時的位置） */
    lastLatitude: text().notNull(),
    lastLongitude: text().notNull(),
    /** 最近一次 transition（enter or exit）發生時間；no transition 時等於首次落表時間 */
    lastTransitionAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** 最近一次 GPS 上報時間（有無 transition 都更新，供「多久沒動」判斷）*/
    lastCheckedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("device_geofence_states_device_geofence_uq").on(
      t.deviceId,
      t.geofenceId,
    ),
    index("device_geofence_states_tenant_idx").on(t.tenantId),
    index("device_geofence_states_status_idx").on(t.status),
  ],
);

export type Geofence = typeof geofences.$inferSelect;
export type NewGeofence = typeof geofences.$inferInsert;
export type DeviceGeofenceAssignment = typeof deviceGeofenceAssignments.$inferSelect;
export type NewDeviceGeofenceAssignment =
  typeof deviceGeofenceAssignments.$inferInsert;
export type DeviceGeofenceState = typeof deviceGeofenceStates.$inferSelect;
export type NewDeviceGeofenceState = typeof deviceGeofenceStates.$inferInsert;

/** state.status 允許值 */
export const GEOFENCE_STATUS = {
  INSIDE: "inside",
  OUTSIDE: "outside",
} as const;
export type GeofenceStatus = typeof GEOFENCE_STATUS[keyof typeof GEOFENCE_STATUS];
