/**
 * 設備策略推送 service 層。
 *
 * 把已實現的 CSP build 函式包裝為友善的業務操作，
 * 經 enqueueWindowsCommand 排入命令佇列。
 *
 * 每個函式回傳 commandIds（排入的命令 UUID 列表），
 * 呼叫端回 202 Accepted 告知管理員命令已排入。
 */

import { db } from "~/db/client.ts";
import type { MdmDevice } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { enqueueWindowsCommand } from "~/services/mdm/windows/command.ts";
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

// ============================================================
// 共用：取設備 + 驗證 Windows + 有 UDID
// ============================================================

export async function getWindowsDeviceForPolicy(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<MdmDevice> {
  const device = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.deviceId), eqOp(t.tenantId, opts.tenantId)),
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

// ============================================================
// WiFi
// ============================================================

export async function pushWiFiToDevice(
  device: MdmDevice,
  input: WiFiProfileInput,
): Promise<string[]> {
  const cmd = buildWiFiProfile(input);
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "WiFiProfile",
    command: cmd,
  });
  return [id];
}

export async function removeWiFiFromDevice(
  device: MdmDevice,
  ssid: string,
): Promise<string[]> {
  const cmd = buildWiFiRemove(ssid);
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "WiFiRemove",
    command: cmd,
  });
  return [id];
}

// ============================================================
// 桌布 / 鎖屏
// ============================================================

export async function pushWallpaperToDevice(
  device: MdmDevice,
  input: PersonalizationInput,
): Promise<string[]> {
  const cmds = buildPersonalization(input);
  if (cmds.length === 0) {
    throw new AppError(400, "empty_input", "At least one of desktopImageUrl or lockScreenImageUrl is required");
  }
  const ids: string[] = [];
  for (const cmd of cmds) {
    const id = await enqueueWindowsCommand({
      deviceUdid: device.udid!,
      commandType: "Personalization",
      command: cmd,
    });
    ids.push(id);
  }
  return ids;
}

// ============================================================
// 密碼政策
// ============================================================

export async function pushPasswordPolicyToDevice(
  device: MdmDevice,
  input: PasswordPolicyInput,
): Promise<string[]> {
  const cmds = buildPasswordPolicy(input);
  if (cmds.length === 0) {
    throw new AppError(400, "empty_input", "At least one password policy field is required");
  }
  const ids: string[] = [];
  for (const cmd of cmds) {
    const id = await enqueueWindowsCommand({
      deviceUdid: device.udid!,
      commandType: "PasswordPolicy",
      command: cmd,
    });
    ids.push(id);
  }
  return ids;
}

// ============================================================
// USB 存儲管控
// ============================================================

export async function pushUsbPolicyToDevice(
  device: MdmDevice,
  input: UsbPolicyInput,
): Promise<string[]> {
  const cmds = buildUsbPolicy(input);
  if (cmds.length === 0) {
    throw new AppError(400, "empty_input", "At least one USB policy field is required");
  }
  const ids: string[] = [];
  for (const cmd of cmds) {
    const id = await enqueueWindowsCommand({
      deviceUdid: device.udid!,
      commandType: "UsbPolicy",
      command: cmd,
    });
    ids.push(id);
  }
  return ids;
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
  device: MdmDevice,
  input: AppRestrictionInput,
): Promise<string[]> {
  const cmd = buildAppLockerPolicy(input);
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "AppLocker",
    command: cmd,
  });
  return [id];
}
