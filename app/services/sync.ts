import { sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { JamfClient } from "~/services/jamf/client.ts";
import { DeviceService } from "~/services/jamf/devices.ts";
import { parseJamfDate, roundOrNull } from "~/services/jamf/inventory.ts";

/**
 * 從一個 Jamf instance 拉全部 mobile devices，upsert 進 mdm_devices。
 *
 * upsert 鍵：(jamf_instance_id, jamf_device_id) — 不用 (tenantId, serialNumber)
 *   的理由是同一台機器可能換過 Jamf 帳號（重新註冊），這時 serialNumber 不變
 *   但 jamf_device_id 變，視為新 row 是正確的；反過來 Jamf 內 id 改不了。
 *
 * 也會強制把同 device_group 的 jamfInstanceId 寫進 device（這樣後續命令派發直接讀
 * device.jamfInstanceId 不必再 join device_groups）。
 */
export interface SyncResult {
  pagesFetched: number;
  totalFromJamf: number;
  upserted: number;
}

const PAGE_SIZE = 200;

export async function syncDevicesFromJamf(opts: {
  tenantId: string;
  jamfInstanceId: string;
}): Promise<SyncResult> {
  // 先確認該 jamf 被某 device_group 綁定（沒綁也允許，devices 的 device_group_id 留 null）
  const deviceGroup = await db.query.deviceGroups.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.jamfInstanceId, opts.jamfInstanceId)),
    columns: { id: true },
  });

  const client = await JamfClient.forInstance({
    tenantId: opts.tenantId,
    instanceId: opts.jamfInstanceId,
  });
  const svc = new DeviceService(client);

  const now = new Date();
  let page = 0;
  let upserted = 0;
  let totalFromJamf = 0;

  for (;;) {
    // 用批量庫存端點（含 GENERAL + HARDWARE section）取代 summary 端點，
    // 一次分頁即帶回電量 / 儲存 / OS / 納管日期，寫進 mdm_devices 對應欄位。
    const resp = await svc.listMobileDevicesDetail({ page, pageSize: PAGE_SIZE });
    totalFromJamf = resp.totalCount;
    if (resp.results.length === 0) break;

    for (const d of resp.results) {
      const g = d.general;
      const h = d.hardware;
      const serialNumber = h?.serialNumber ?? null;
      const deviceName = g?.displayName ?? null;
      const managementId = g?.managementId ?? null;
      const osVersion = g?.osVersion ?? null;
      const batteryLevel = roundOrNull(h?.batteryLevel);
      const storageTotalMb = roundOrNull(h?.capacityMb);
      const storageAvailableMb = roundOrNull(h?.availableSpaceMb);
      const enrolledAt = parseJamfDate(g?.lastEnrolledDate);

      await db
        .insert(mdmDevices)
        .values({
          tenantId: opts.tenantId,
          deviceGroupId: deviceGroup?.id ?? null,
          jamfInstanceId: opts.jamfInstanceId,
          platform: "apple",
          udid: null,
          serialNumber,
          deviceName,
          osVersion,
          batteryLevel,
          storageTotalMb,
          storageAvailableMb,
          // 有 Jamf 納管日期就寫真值；沒有則不設此欄，讓 schema defaultNow() 兜底
          ...(enrolledAt ? { enrolledAt } : {}),
          jamfDeviceId: String(d.mobileDeviceId),
          jamfManagementId: managementId,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [mdmDevices.jamfInstanceId, mdmDevices.jamfDeviceId],
          // partial unique index 需要在這裡帶上相同的 WHERE 子句才能匹配
          targetWhere: sql`${mdmDevices.jamfDeviceId} IS NOT NULL`,
          set: {
            deviceGroupId: deviceGroup?.id ?? sql`${mdmDevices.deviceGroupId}`,
            serialNumber: serialNumber ?? sql`${mdmDevices.serialNumber}`,
            deviceName: deviceName ?? sql`${mdmDevices.deviceName}`,
            osVersion: osVersion ?? sql`${mdmDevices.osVersion}`,
            // 電量可能為 0（真值），?? 只在 null/undefined 時保留原值，不會誤判 0
            batteryLevel: batteryLevel ?? sql`${mdmDevices.batteryLevel}`,
            storageTotalMb: storageTotalMb ?? sql`${mdmDevices.storageTotalMb}`,
            storageAvailableMb: storageAvailableMb ?? sql`${mdmDevices.storageAvailableMb}`,
            enrolledAt: enrolledAt ?? sql`${mdmDevices.enrolledAt}`,
            jamfManagementId: managementId ?? sql`${mdmDevices.jamfManagementId}`,
            lastSyncedAt: now,
          },
        });
      upserted++;
    }

    page++;
    if (resp.results.length < PAGE_SIZE) break;
    if (page > 100) {
      // 安全閥：避免 Jamf 回傳異常造成無限循環
      throw new AppError(
        500,
        "sync_aborted_too_many_pages",
        `Sync exceeded ${page} pages, aborting to prevent infinite loop`,
      );
    }
  }

  return { pagesFetched: page + 1, totalFromJamf, upserted };
}
