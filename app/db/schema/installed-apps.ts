import {
  bigint,
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
 * 設備側 MSI / Win32 已裝軟體清單（PRD §4.2 App 安裝清單 Inventory）。
 *
 * 資料來源：Agent 端 InstalledAppsCollector 掃 registry
 *   HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*
 *   HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*
 *   HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*
 *
 * 語意：Agent 每次上報 = 該設備當前完整清單快照（backend upsert，並刪除當次沒回報的 row）。
 * 用途：管理員後台看某台設備裝了什麼軟體，找誤裝 / 授權盤點。
 *
 * MSIX / UWP 軟體走另一路徑（`mdm_windows_apps`，AppInventory CSP pull），本表**不重複**。
 */
export const mdmInstalledWin32Apps = pgTable(
  "mdm_installed_win32_apps",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    /**
     * Uninstall registry key 名（GUID like `{XXXXXXXX-...}` 或 exe 廠商自訂 key 名）。
     * 作為設備內唯一識別；不同軟體不會撞。
     */
    uninstallKey: varchar({ length: 256 }).notNull(),
    displayName: text().notNull(),
    displayVersion: varchar({ length: 64 }),
    publisher: text(),
    /** ISO date string（Registry `InstallDate` 是 YYYYMMDD 格式，Agent 端轉 ISO） */
    installDate: varchar({ length: 32 }),
    /** 佔用空間（KB，registry `EstimatedSize` DWORD） */
    estimatedSizeKb: bigint({ mode: "number" }),
    /** 卸載命令列（供管理員參考；不主動呼叫） */
    uninstallString: text(),
    /** Agent 上次上報此 row 的時間 */
    lastSyncedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mdm_installed_win32_apps_device_key_uq")
      .on(t.deviceId, t.uninstallKey),
    index("mdm_installed_win32_apps_device_idx").on(t.deviceId),
    index("mdm_installed_win32_apps_tenant_idx").on(t.tenantId),
    index("mdm_installed_win32_apps_display_name_idx").on(t.displayName),
  ],
);

export type MdmInstalledWin32App = typeof mdmInstalledWin32Apps.$inferSelect;
export type NewMdmInstalledWin32App = typeof mdmInstalledWin32Apps.$inferInsert;
