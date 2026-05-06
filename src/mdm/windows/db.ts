/** Windows MDM 專用資料庫 helpers（mdm_windows_apps 表 + 平台便利查詢） */

import { getDb } from "../../db/sqlite.ts";
import type { MdmWindowsAppRow } from "../types.ts";

/** 新增或更新一筆 Windows 應用清單（同 udid + PFN 為 UPSERT） */
export function upsertWindowsApp(fields: {
  deviceUdid: string;
  packageFamilyName: string;
  displayName?: string | null;
  version?: string | null;
  installState?: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO mdm_windows_apps (
       device_udid, package_family_name, display_name, version, install_state, last_synced_at
     ) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(device_udid, package_family_name) DO UPDATE SET
       display_name = excluded.display_name,
       version = excluded.version,
       install_state = excluded.install_state,
       last_synced_at = excluded.last_synced_at`
  ).run(
    fields.deviceUdid,
    fields.packageFamilyName,
    fields.displayName ?? null,
    fields.version ?? null,
    fields.installState ?? null
  );
}

/** 列出某裝置的應用清單 */
export function listWindowsAppsByDevice(
  deviceUdid: string
): MdmWindowsAppRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM mdm_windows_apps
       WHERE device_udid = ?
       ORDER BY display_name ASC, package_family_name ASC`
    )
    .all(deviceUdid) as MdmWindowsAppRow[];
}

/** 刪除某裝置的應用清單（裝置被 wipe / unenroll 時清掉） */
export function deleteWindowsAppsByDevice(deviceUdid: string): number {
  return getDb()
    .prepare("DELETE FROM mdm_windows_apps WHERE device_udid = ?")
    .run(deviceUdid);
}

/** 移除單一應用（裝置回報 install_state=NotInstalled 後可呼叫） */
export function deleteWindowsApp(
  deviceUdid: string,
  packageFamilyName: string
): boolean {
  const changes = getDb()
    .prepare(
      `DELETE FROM mdm_windows_apps
       WHERE device_udid = ? AND package_family_name = ?`
    )
    .run(deviceUdid, packageFamilyName);
  return changes > 0;
}
