/**
 * mdm_windows_apps DB helper（Drizzle / PostgreSQL）
 *
 * 對應 src/mdm/windows/db.ts 的 upsertWindowsApp。設備透過 AppInventoryQuery
 * 回報的 Windows App 清單寫入這張表，後續查詢給 admin UI / webhook 用。
 *
 * 關鍵差異 vs src/：
 * - src/ 用 device_udid TEXT FK + UNIQUE(device_udid, package_family_name)
 * - app/ 用 deviceId UUID FK + UNIQUE(device_id, package_family_name) +
 *   tenantId NOT NULL
 * - upsert 對齊 schema：on conflict (device_id, package_family_name) update
 */

import { eq, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices, mdmWindowsApps } from "~/db/schema/devices.ts";

export interface UpsertWindowsAppFields {
  deviceUdid: string;
  packageFamilyName: string;
  displayName?: string | null;
  version?: string | null;
  installState?: string | null;
}

/**
 * 寫入或更新一筆 Windows App 清單。需先 lookup deviceUdid → deviceId + tenantId。
 *
 * 若 deviceUdid 找不到 → log warning 並 silent skip（同 device 已被 unenroll
 * 場景，不該因為 inventory 上報失敗整條 SyncML session 掛掉）。
 */
export async function upsertWindowsApp(fields: UpsertWindowsAppFields): Promise<void> {
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.udid, fields.deviceUdid),
    columns: { id: true, tenantId: true },
  });
  if (!device) {
    console.warn(
      `[windows-apps] upsertWindowsApp: device udid=${fields.deviceUdid} not found, skipped`,
    );
    return;
  }

  await db
    .insert(mdmWindowsApps)
    .values({
      tenantId: device.tenantId,
      deviceId: device.id,
      packageFamilyName: fields.packageFamilyName,
      displayName: fields.displayName ?? null,
      version: fields.version ?? null,
      installState: fields.installState ?? null,
    })
    .onConflictDoUpdate({
      target: [mdmWindowsApps.deviceId, mdmWindowsApps.packageFamilyName],
      set: {
        displayName: fields.displayName ?? null,
        version: fields.version ?? null,
        installState: fields.installState ?? null,
        lastSyncedAt: sql`now()`,
      },
    });
}
