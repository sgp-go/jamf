import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { mdmDevices } from "./devices.ts";
import { tenants } from "./tenants.ts";

/**
 * Agent App 端上報的設備狀態（電量、儲存、網路、亮度等）。
 * device_id 用內部 UUID（不再依賴外部 jamfId 或 serial）以維持與 mdm_devices 一致。
 */
export const agentReports = pgTable(
  "agent_reports",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => mdmDevices.id, { onDelete: "cascade" }),
    serialNumber: varchar({ length: 64 }),
    batteryLevel: integer(),
    storageAvailableMb: integer(),
    storageTotalMb: integer(),
    networkType: varchar({ length: 32 }),
    networkSsid: text(),
    screenBrightness: real(),
    osVersion: text(),
    appVersion: text(),
    extraData: jsonb().$type<Record<string, unknown>>(),
    reportedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_reports_device_time_idx").on(t.deviceId, t.reportedAt),
    index("agent_reports_tenant_idx").on(t.tenantId),
  ],
);

/**
 * 每日使用時長統計（一台設備一天一筆，pickup/連續使用峰值/分時段統計）。
 */
export const deviceUsageStats = pgTable(
  "device_usage_stats",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => mdmDevices.id, { onDelete: "cascade" }),
    sessionId: text(),
    date: varchar({ length: 10 }).notNull(),
    totalMinutes: integer().notNull().default(0),
    pickup: integer().notNull().default(0),
    maxContinuous: integer().notNull().default(0),
    timeStats: jsonb().$type<Record<string, number>>(),
    reportedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("device_usage_device_date_uq").on(t.deviceId, t.date),
    index("device_usage_tenant_date_idx").on(t.tenantId, t.date),
  ],
);

export type AgentReport = typeof agentReports.$inferSelect;
export type DeviceUsageStat = typeof deviceUsageStats.$inferSelect;
