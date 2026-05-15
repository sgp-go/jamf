import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import type { MdmDevice } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { JamfClient } from "~/services/jamf/client.ts";
import { DeviceService } from "~/services/jamf/devices.ts";
import type { CommandPayload } from "~/services/jamf/types.ts";

/**
 * 業務層的 device-centric 入口。
 * 所有方法只認 tenantId + deviceId（內部 UUID），不再要求 caller 知道 Jamf instance。
 * 內部用 device.jamfInstanceId 自動建立 JamfClient 對上游派命令。
 */

export async function listDevicesInTenant(opts: {
  tenantId: string;
  schoolId?: string;
  search?: string;
  page: number;
  limit: number;
}) {
  const conditions: SQL[] = [eq(mdmDevices.tenantId, opts.tenantId)];
  if (opts.schoolId) conditions.push(eq(mdmDevices.schoolId, opts.schoolId));
  if (opts.search) {
    const like = `%${opts.search}%`;
    const matchSerial = ilike(mdmDevices.serialNumber, like);
    const matchName = ilike(mdmDevices.deviceName, like);
    const matchUdid = ilike(mdmDevices.udid, like);
    const orExpr = or(matchSerial, matchName, matchUdid);
    if (orExpr) conditions.push(orExpr);
  }
  const where = and(...conditions);

  const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
    db
      .select()
      .from(mdmDevices)
      .where(where)
      .orderBy(desc(mdmDevices.lastSyncedAt), mdmDevices.serialNumber)
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db.select({ value: count() }).from(mdmDevices).where(where),
  ]);
  return { rows, total };
}

export async function getDeviceInTenant(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<MdmDevice> {
  const row = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.deviceId), eqOp(t.tenantId, opts.tenantId)),
  });
  if (!row) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  return row;
}

/**
 * 取 device 詳情 + 即時打 Jamf 補頂層資料。
 * Jamf 那邊失敗時降級回 DB 快取版本，加 upstream_unavailable 旗標讓前端知道。
 */
export async function getDeviceFullDetail(opts: {
  tenantId: string;
  deviceId: string;
}) {
  const device = await getDeviceInTenant(opts);
  if (!device.jamfInstanceId || !device.jamfDeviceId) {
    return { device, jamf: null, jamfError: "device_not_synced" as const };
  }

  try {
    const client = await JamfClient.forInstance({
      tenantId: opts.tenantId,
      instanceId: device.jamfInstanceId,
    });
    const svc = new DeviceService(client);
    const [detail, lostMode] = await Promise.all([
      svc.getMobileDevice(device.jamfDeviceId),
      svc.getLostModeStatus(device.jamfDeviceId),
    ]);
    return { device, jamf: { detail, lostMode }, jamfError: null };
  } catch (err) {
    return {
      device,
      jamf: null,
      jamfError: err instanceof Error ? err.message : "upstream_failed",
    };
  }
}

/**
 * 派命令：caller 只提供 deviceId + 命令名。
 * 服務端從 device.jamf_instance_id 自動找對應 Jamf 派命令。
 */
export async function sendCommandToDevice(opts: {
  tenantId: string;
  deviceId: string;
  payload: CommandPayload;
}): Promise<unknown> {
  const device = await getDeviceInTenant(opts);
  if (!device.jamfInstanceId) {
    throw new AppError(
      409,
      "device_not_jamf_managed",
      "Device is not bound to any Jamf instance; run sync first",
    );
  }
  if (!device.jamfManagementId) {
    throw new AppError(
      409,
      "device_missing_management_id",
      "Device has no jamf_management_id; re-sync from Jamf to populate",
    );
  }

  const client = await JamfClient.forInstance({
    tenantId: opts.tenantId,
    instanceId: device.jamfInstanceId,
  });
  return new DeviceService(client).sendCommand(device.jamfManagementId, opts.payload);
}

export async function toggleAppLock(opts: {
  tenantId: string;
  deviceId: string;
  enable: boolean;
}): Promise<void> {
  const device = await getDeviceInTenant(opts);
  if (!device.jamfInstanceId || !device.jamfDeviceId) {
    throw new AppError(
      409,
      "device_not_jamf_managed",
      "Device is not bound to any Jamf instance",
    );
  }

  const instance = await db.query.jamfInstances.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(
        eqOp(t.id, device.jamfInstanceId!),
        eqOp(t.tenantId, opts.tenantId),
      ),
    columns: { appLockGroupId: true },
  });
  if (!instance) {
    throw new AppError(404, "jamf_instance_not_found", "Jamf instance not found");
  }

  const client = await JamfClient.forInstance({
    tenantId: opts.tenantId,
    instanceId: device.jamfInstanceId,
  });
  const svc = new DeviceService(client);
  if (opts.enable) {
    await svc.enableAppLock(device.jamfDeviceId, instance.appLockGroupId);
  } else {
    await svc.disableAppLock(device.jamfDeviceId, instance.appLockGroupId);
  }
}
