import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmCommands, mdmDevices } from "~/db/schema/devices.ts";
import type { MdmCommand, MdmDevice } from "~/db/schema/devices.ts";
import type { AgentReport, DeviceUsageStat } from "~/db/schema/agent.ts";
import { AppError } from "~/lib/errors.ts";
import { getLatestAgentReport, listUsageStats } from "~/services/agent.ts";
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
  deviceGroupId?: string;
  search?: string;
  page: number;
  limit: number;
}) {
  const conditions: SQL[] = [eq(mdmDevices.tenantId, opts.tenantId)];
  if (opts.deviceGroupId)
    conditions.push(eq(mdmDevices.deviceGroupId, opts.deviceGroupId));
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
 * 列設備命令歷史（按 queued_at desc）。
 *
 * 先驗 device 屬於 tenant（不存在 → 404，避免空 list 掩蓋錯誤路徑）。
 * 用 core query db.select 避開 findMany 對 list 的延遲（per project memory）。
 */
export async function listDeviceCommands(opts: {
  tenantId: string;
  deviceId: string;
  page: number;
  limit: number;
}): Promise<{ rows: MdmCommand[]; total: number }> {
  await getDeviceInTenant({ tenantId: opts.tenantId, deviceId: opts.deviceId });

  const where = and(
    eq(mdmCommands.deviceId, opts.deviceId),
    eq(mdmCommands.tenantId, opts.tenantId),
  );

  const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
    db
      .select()
      .from(mdmCommands)
      .where(where)
      .orderBy(desc(mdmCommands.queuedAt))
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db.select({ value: count() }).from(mdmCommands).where(where),
  ]);
  return { rows, total };
}

/**
 * 設備 telemetry：最新一筆 agent_reports + 最近 7 天 device_usage_stats。
 *
 * 先驗 device 屬於 tenant（404 優先於空數據），再並行拉兩個來源。
 */
export async function getDeviceTelemetry(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<{
  latestReport: AgentReport | null;
  usageLastWeek: DeviceUsageStat[];
}> {
  await getDeviceInTenant(opts);
  const sevenDaysAgo = isoDateNDaysAgo(7);
  const [latestReport, usageLastWeek] = await Promise.all([
    getLatestAgentReport(opts),
    listUsageStats({ ...opts, startDate: sevenDaysAgo }),
  ]);
  return {
    latestReport: latestReport ?? null,
    usageLastWeek,
  };
}

function isoDateNDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
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

export interface UpdateDeviceInput {
  /** 重命名（schema 上是 text，限長與業務需求一致取 1-200） */
  deviceName?: string;
  /** 轉組；傳 null 表示移出當前分組（schema 該欄位 nullable） */
  deviceGroupId?: string | null;
}

/**
 * 更新設備：重命名 / 轉組。
 *
 * - 轉組時校驗目標 device_group 屬於同一 tenant（避免跨租戶寫入）
 * - patch 為空時直接回原 row（不走 UPDATE，省一次 write）
 * - updated_at 由 schema $onUpdate 自動維護
 * - 用 .returning() 一次拿回更新後 row，404 由 returning 為空判定
 */
export async function updateDeviceInTenant(opts: {
  tenantId: string;
  deviceId: string;
  input: UpdateDeviceInput;
}): Promise<MdmDevice> {
  if (
    opts.input.deviceGroupId !== undefined &&
    opts.input.deviceGroupId !== null
  ) {
    await assertDeviceGroupBelongsToTenant(
      opts.tenantId,
      opts.input.deviceGroupId,
    );
  }

  const patch: Record<string, unknown> = {};
  if (opts.input.deviceName !== undefined) patch.deviceName = opts.input.deviceName;
  if (opts.input.deviceGroupId !== undefined) {
    patch.deviceGroupId = opts.input.deviceGroupId;
  }
  if (Object.keys(patch).length === 0) return getDeviceInTenant(opts);

  const [row] = await db
    .update(mdmDevices)
    .set(patch)
    .where(
      and(eq(mdmDevices.id, opts.deviceId), eq(mdmDevices.tenantId, opts.tenantId)),
    )
    .returning();
  if (!row) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  return row;
}

async function assertDeviceGroupBelongsToTenant(
  tenantId: string,
  deviceGroupId: string,
): Promise<void> {
  const row = await db.query.deviceGroups.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, deviceGroupId), eqOp(t.tenantId, tenantId)),
    columns: { id: true },
  });
  if (!row) {
    throw new AppError(
      400,
      "device_group_not_in_tenant",
      "Device group does not belong to this tenant",
    );
  }
}

/**
 * 解除設備納管（軟刪）：標記 enrollment_status=unenrolled，**不刪 row**
 * （保 mdm_commands / agent_reports / Jamf 同步歷史的外鍵引用完整）。
 *
 * 冪等：已 unenrolled 再呼叫一次仍回 200 + 當前 row，updated_at 由 $onUpdate 維護。
 */
export async function unenrollDeviceInTenant(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<MdmDevice> {
  const [row] = await db
    .update(mdmDevices)
    .set({ enrollmentStatus: "unenrolled" })
    .where(
      and(eq(mdmDevices.id, opts.deviceId), eq(mdmDevices.tenantId, opts.tenantId)),
    )
    .returning();
  if (!row) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  return row;
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
