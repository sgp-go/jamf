import { sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { JamfClient } from "~/services/jamf/client.ts";
import { DeviceService } from "~/services/jamf/devices.ts";

/**
 * 從一個 Jamf instance 拉全部 mobile devices，upsert 進 mdm_devices。
 *
 * upsert 鍵：(jamf_instance_id, jamf_device_id) — 不用 (tenantId, serialNumber)
 *   的理由是同一台機器可能換過 Jamf 帳號（重新註冊），這時 serialNumber 不變
 *   但 jamf_device_id 變，視為新 row 是正確的；反過來 Jamf 內 id 改不了。
 *
 * 也會強制把同 school 的 jamfInstanceId 寫進 device（這樣後續命令派發直接讀
 * device.jamfInstanceId 不必再 join schools）。
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
  // 先確認該 jamf 被某 school 綁定（沒綁也允許，devices 的 school_id 留 null）
  const school = await db.query.schools.findFirst({
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
    const resp = await svc.listMobileDevices({ page, pageSize: PAGE_SIZE });
    totalFromJamf = resp.totalCount;
    if (resp.results.length === 0) break;

    for (const d of resp.results) {
      await db
        .insert(mdmDevices)
        .values({
          tenantId: opts.tenantId,
          schoolId: school?.id ?? null,
          jamfInstanceId: opts.jamfInstanceId,
          platform: "apple",
          udid: null,
          serialNumber: d.serialNumber ?? null,
          deviceName: d.name ?? null,
          jamfDeviceId: String(d.id),
          jamfManagementId: d.managementId ?? null,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [mdmDevices.jamfInstanceId, mdmDevices.jamfDeviceId],
          // partial unique index 需要在這裡帶上相同的 WHERE 子句才能匹配
          targetWhere: sql`${mdmDevices.jamfDeviceId} IS NOT NULL`,
          set: {
            schoolId: school?.id ?? sql`${mdmDevices.schoolId}`,
            serialNumber: d.serialNumber ?? sql`${mdmDevices.serialNumber}`,
            deviceName: d.name ?? sql`${mdmDevices.deviceName}`,
            jamfManagementId: d.managementId ?? sql`${mdmDevices.jamfManagementId}`,
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
