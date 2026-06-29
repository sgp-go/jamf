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
  buildCameraPolicy,
  buildFirewallPolicy,
  buildSetComputerName,
  type WiFiProfileInput,
  type PersonalizationInput,
  type PasswordPolicyInput,
  type UsbPolicyInput,
  type AppLockerRuleCollection,
  type AppLockerEnforcementMode,
  type AppLockerRule,
  type FirewallPolicyInput,
} from "~/services/mdm/windows/csp.ts";
import {
  buildVpnProfile,
  buildVpnRemove,
  type VpnProfileInput,
} from "~/services/mdm/windows/csp-vpn.ts";
import {
  buildSettingsPageVisibility,
  type SettingsPageVisibilityInput,
} from "~/services/mdm/windows/csp-experience.ts";
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

// ============================================================
// VPN
// ============================================================

export async function pushVpnToDevice(
  device: WindowsDevice,
  input: VpnProfileInput,
): Promise<string[]> {
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "VpnProfile",
    command: buildVpnProfile(input),
  });
  return [id];
}

export async function removeVpnFromDevice(
  device: WindowsDevice,
  profileName: string,
): Promise<string[]> {
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "VpnRemove",
    command: buildVpnRemove(profileName),
  });
  return [id];
}

// ============================================================
// Camera 禁用
// ============================================================

export async function pushCameraPolicyToDevice(
  device: WindowsDevice,
  allow: boolean,
): Promise<string[]> {
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "CameraPolicy",
    command: buildCameraPolicy(allow),
  });
  return [id];
}

// ============================================================
// 防火牆
// ============================================================

export async function pushFirewallPolicyToDevice(
  device: WindowsDevice,
  input: FirewallPolicyInput,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "FirewallPolicy",
    buildFirewallPolicy(input),
    "At least one firewall policy field is required",
  );
}

// ============================================================
// 設備命名
// ============================================================
//
// service 層支援兩種輸入：
//   1. explicitName：直接派發指定名稱（admin 自行決定，例如測試）
//   2. template + 替換變數：依規則生成（PRD §5.1 自動設備命名）
//
// 模板變數（同 Jamf 命名規則風格）：
//   - {schoolCode}  device_group.code（無關聯 group 時為空字串）
//   - {serial}      device.serialNumber（全段）
//   - {serial4}     serialNumber 後 4 碼（不足補 0）
//   - {udid8}       device.udid 前 8 碼
//
// 範例：template="TPE001-{serial4}" + serial="ABC1234" → "TPE001-1234"

export interface RenameTemplateContext {
  schoolCode: string | null;
  serialNumber: string | null;
  udid: string | null;
}

export function renderDeviceNameTemplate(
  template: string,
  ctx: RenameTemplateContext,
): string {
  const serial = ctx.serialNumber ?? "";
  const serial4 = serial.length >= 4
    ? serial.slice(-4)
    : serial.padStart(4, "0");
  const udid8 = (ctx.udid ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  const schoolCode = ctx.schoolCode ?? "";

  return template
    .replace(/\{schoolCode\}/g, schoolCode)
    .replace(/\{serial4\}/g, serial4)
    .replace(/\{serial\}/g, serial)
    .replace(/\{udid8\}/g, udid8);
}

export interface RenameDeviceInput {
  /** 直接指定名稱（與 template 二選一） */
  explicitName?: string;
  /** 命名模板（與 explicitName 二選一）；變數見 renderDeviceNameTemplate */
  template?: string;
}

export async function pushDeviceRenameToDevice(
  device: WindowsDevice,
  input: RenameDeviceInput,
  ctx: RenameTemplateContext,
): Promise<{ commandIds: string[]; appliedName: string }> {
  if (!input.explicitName && !input.template) {
    throw new AppError(
      400,
      "rename_input_required",
      "Provide either explicitName or template",
    );
  }
  const appliedName = input.explicitName
    ?? renderDeviceNameTemplate(input.template!, ctx);

  // buildSetComputerName 會驗證長度與字元；非法直接拋
  let cmd: SyncMLCommand;
  try {
    cmd = buildSetComputerName(appliedName);
  } catch (e) {
    throw new AppError(
      400,
      "invalid_computer_name",
      e instanceof Error ? e.message : String(e),
    );
  }
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "RenameDevice",
    command: cmd,
  });
  return { commandIds: [id], appliedName };
}

// ============================================================
// 設備功能限制（Settings 頁面可見性）
// ============================================================

export async function pushSettingsRestrictionToDevice(
  device: WindowsDevice,
  input: SettingsPageVisibilityInput,
): Promise<string[]> {
  const id = await enqueueWindowsCommand({
    deviceUdid: device.udid!,
    commandType: "SettingsPageVisibility",
    command: buildSettingsPageVisibility(input),
  });
  return [id];
}
