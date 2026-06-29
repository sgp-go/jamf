/**
 * 設備策略推送 service 層。
 *
 * 把已實現的 CSP build 函式包裝為友善的業務操作，
 * 經 `enqueueWindowsCommandsBatch` 在單一 transaction 內排入命令佇列
 * （N 條 SyncML 全成功或全 rollback，避免設備收到部分政策）。
 *
 * 每個函式回傳 commandIds（排入的命令 UUID 列表），
 * 呼叫端回 202 Accepted 告知管理員命令已排入。
 */

import { db } from "~/db/client.ts";
import type { MdmDevice } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import {
  enqueueWindowsCommand,
  enqueueWindowsCommandsBatch,
} from "~/services/mdm/windows/command.ts";
import {
  buildWiFiProfile,
  buildWiFiRemove,
  buildPersonalization,
  buildPasswordPolicy,
  buildUsbPolicy,
  buildAppLockerPolicy,
  type WiFiProfileInput,
  type PersonalizationInput,
  type PasswordPolicyInput,
  type UsbPolicyInput,
  type AppLockerRuleCollection,
  type AppLockerEnforcementMode,
  type AppLockerRule,
} from "~/services/mdm/windows/csp.ts";
import type { SyncMLCommand } from "~/services/mdm/windows/syncml.ts";

// ============================================================
// 共用：取設備 + 驗證 Windows + 有 UDID
// ============================================================

/**
 * 僅 select 推送策略所需欄位（id / tenantId / platform / udid）。
 */
export async function getWindowsDeviceForPolicy(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<Pick<MdmDevice, "id" | "tenantId" | "platform" | "udid">> {
  const device = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.deviceId), eqOp(t.tenantId, opts.tenantId)),
    columns: { id: true, tenantId: true, platform: true, udid: true },
  });
  if (!device) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  if (device.platform !== "windows") {
    throw new AppError(400, "device_not_windows", "Policy push only supports Windows devices");
  }
  if (!device.udid) {
    throw new AppError(400, "device_missing_udid", "Device has no UDID (not enrolled)");
  }
  return device;
}

type WindowsDevice = Pick<MdmDevice, "id" | "tenantId" | "platform" | "udid">;

/**
 * 對「build 出 N 條 SyncML 命令」的 push 模式統一封裝：
 *   1. 命令數為 0 → 拋 400 `empty_input`
 *   2. 否則整批走 transaction 入隊（all-or-nothing）+ 單次 WNS push
 *
 * @param commandType 同類命令共用同一個 type 標籤
 */
async function enqueueBatch(
  device: WindowsDevice,
  commandType: string,
  cmds: SyncMLCommand[],
  emptyMessage: string,
): Promise<string[]> {
  if (cmds.length === 0) {
    throw new AppError(400, "empty_input", emptyMessage);
  }
  return await enqueueWindowsCommandsBatch({
    deviceUdid: device.udid!,
    commands: cmds.map((c) => ({ commandType, command: c })),
  });
}

// ============================================================
// WiFi
// ============================================================

export async function pushWiFiToDevice(
  device: WindowsDevice,
  input: WiFiProfileInput,
): Promise<string[]> {
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "WiFiProfile",
    command: buildWiFiProfile(input),
  });
  return [id];
}

export async function removeWiFiFromDevice(
  device: WindowsDevice,
  ssid: string,
): Promise<string[]> {
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "WiFiRemove",
    command: buildWiFiRemove(ssid),
  });
  return [id];
}

// ============================================================
// 桌布 / 鎖屏
// ============================================================

export async function pushWallpaperToDevice(
  device: WindowsDevice,
  input: PersonalizationInput,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "Personalization",
    buildPersonalization(input),
    "At least one of desktopImageUrl or lockScreenImageUrl is required",
  );
}

// ============================================================
// 密碼政策
// ============================================================

export async function pushPasswordPolicyToDevice(
  device: WindowsDevice,
  input: PasswordPolicyInput,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "PasswordPolicy",
    buildPasswordPolicy(input),
    "At least one password policy field is required",
  );
}

// ============================================================
// USB 存儲管控
// ============================================================

export async function pushUsbPolicyToDevice(
  device: WindowsDevice,
  input: UsbPolicyInput,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "UsbPolicy",
    buildUsbPolicy(input),
    "At least one USB policy field is required",
  );
}

// ============================================================
// AppLocker（應用限制 / 白名單）
// ============================================================

export interface AppRestrictionInput {
  grouping: string;
  ruleCollection: AppLockerRuleCollection;
  enforcementMode?: AppLockerEnforcementMode;
  rules: AppLockerRule[];
}

export async function pushAppRestrictionToDevice(
  device: WindowsDevice,
  input: AppRestrictionInput,
): Promise<string[]> {
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "AppLocker",
    command: buildAppLockerPolicy(input),
  });
  return [id];
}
