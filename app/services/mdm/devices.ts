/**
 * MDM 設備 DB helper（Drizzle / PostgreSQL）
 *
 * 對應 src/db/sqlite.ts 中的 getMdmDevice / getMdmDeviceByWindowsId /
 * upsertMdmDevice。W2 Day 1 OMA-DM 協議層搬遷時用。
 *
 * 設計取捨：
 * - upsertMdmDevice 只做 UPDATE（src/ 版本同時支援 INSERT）。app/ 端
 *   mdm_devices.tenantId 是 NOT NULL，INSERT 必須帶 tenantId，但
 *   command.ts / checkin.ts 內所有 upsert 呼叫都是設備已存在的更新場景
 *   （enrollment 流程才會 INSERT），因此這裡不處理 INSERT。udid 找不到 →
 *   log warning 並回傳 0 affected。
 * - wnsChannelExpiry 在 src/ 是 epoch ms (number)，app/ schema 是 timestamp。
 *   轉換時 `new Date(epoch)`。
 * - managementSessionState 在 src/ 是 JSON string，app/ schema 是 jsonb。
 *   接受 string 也接受 object（轉換時 parse）。
 * - deviceInfo 同上 jsonb 處理。
 */

import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  type MdmDevice,
  mdmDevices,
} from "~/db/schema/devices.ts";

export async function getMdmDevice(udid: string): Promise<MdmDevice | undefined> {
  return db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.udid, udid),
  });
}

export async function getMdmDeviceByWindowsId(
  windowsDeviceId: string,
): Promise<MdmDevice | undefined> {
  return db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.windowsDeviceId, windowsDeviceId),
  });
}

/**
 * 部分更新 mdm_devices row（by udid）。
 *
 * @returns affected rows（0 = udid 找不到、log warning）
 */
export async function upsertMdmDevice(
  udid: string,
  fields: UpsertMdmDeviceFields,
): Promise<number> {
  const patch: Partial<typeof mdmDevices.$inferInsert> = {};

  if (fields.serialNumber !== undefined) patch.serialNumber = fields.serialNumber;
  if (fields.deviceName !== undefined) patch.deviceName = fields.deviceName;
  if (fields.model !== undefined) patch.model = fields.model;
  if (fields.osVersion !== undefined) patch.osVersion = fields.osVersion;
  if (fields.pushToken !== undefined) patch.pushToken = fields.pushToken;
  if (fields.pushMagic !== undefined) patch.pushMagic = fields.pushMagic;
  if (fields.unlockToken !== undefined) patch.unlockToken = fields.unlockToken;
  if (fields.topic !== undefined) patch.topic = fields.topic;
  if (fields.enrollmentStatus !== undefined) patch.enrollmentStatus = fields.enrollmentStatus;
  if (fields.enrollmentType !== undefined) patch.enrollmentType = fields.enrollmentType;
  if (fields.platform !== undefined) patch.platform = fields.platform;
  if (fields.windowsDeviceId !== undefined) patch.windowsDeviceId = fields.windowsDeviceId;
  if (fields.windowsHardwareId !== undefined) patch.windowsHardwareId = fields.windowsHardwareId;
  if (fields.wnsChannelUri !== undefined) patch.wnsChannelUri = fields.wnsChannelUri;
  if (fields.lostModeEnabled !== undefined) patch.lostModeEnabled = fields.lostModeEnabled;
  if (fields.lostModeMessage !== undefined) patch.lostModeMessage = fields.lostModeMessage;
  if (fields.lostModePhone !== undefined) patch.lostModePhone = fields.lostModePhone;
  if (fields.lostModeFootnote !== undefined) patch.lostModeFootnote = fields.lostModeFootnote;

  // epoch ms (number) → timestamp（保留 null）
  if (fields.wnsChannelExpiry !== undefined) {
    patch.wnsChannelExpiry = fields.wnsChannelExpiry === null
      ? null
      : new Date(fields.wnsChannelExpiry);
  }

  // ISO string → Date
  if (fields.lostModeEnabledAt !== undefined) {
    patch.lostModeEnabledAt = fields.lostModeEnabledAt === null
      ? null
      : new Date(fields.lostModeEnabledAt);
  }

  // JSON string or object → jsonb
  if (fields.managementSessionState !== undefined) {
    patch.managementSessionState = parseJsonbField(fields.managementSessionState);
  }
  if (fields.deviceInfo !== undefined) {
    patch.deviceInfo = parseJsonbField(fields.deviceInfo);
  }

  if (Object.keys(patch).length === 0) return 0;

  const result = await db
    .update(mdmDevices)
    .set(patch)
    .where(eq(mdmDevices.udid, udid))
    .returning({ id: mdmDevices.id });

  if (result.length === 0) {
    console.warn(`[mdm devices] upsertMdmDevice: udid ${udid} not found, skipped`);
  }
  return result.length;
}

function parseJsonbField(
  value: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

export interface UpsertMdmDeviceFields {
  serialNumber?: string;
  deviceName?: string;
  model?: string;
  osVersion?: string;
  pushToken?: string;
  pushMagic?: string;
  unlockToken?: string;
  topic?: string;
  enrollmentStatus?: "pending" | "enrolled" | "unenrolled" | "failed";
  enrollmentType?: string;
  deviceInfo?: string | Record<string, unknown> | null;
  lostModeEnabled?: boolean;
  lostModeMessage?: string | null;
  lostModePhone?: string | null;
  lostModeFootnote?: string | null;
  lostModeEnabledAt?: string | null;
  platform?: "apple" | "windows";
  windowsDeviceId?: string | null;
  windowsHardwareId?: string | null;
  wnsChannelUri?: string | null;
  wnsChannelExpiry?: number | null;
  managementSessionState?: string | Record<string, unknown> | null;
}
