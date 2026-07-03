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
  buildLostModeAdmxInstall,
  buildLostModeEnable,
  buildLostModeDisable,
  type LostModeEnableInput,
} from "~/services/mdm/windows/csp-lost-mode.ts";
import {
  buildSettingsPageVisibility,
  type SettingsPageVisibilityInput,
} from "~/services/mdm/windows/csp-experience.ts";
import {
  buildDefenderEnforce,
  buildDefenderEnforceAll,
  buildDefenderHealthQuery,
  type DefenderEnforceInput,
  type DefenderHealthNode,
} from "~/services/mdm/windows/csp-defender.ts";
import {
  buildBlockedSites,
  buildIESiteZoneAssignment,
  buildIESiteZoneClear,
  buildEdgeAdmxInstall,
  buildEdgeUrlBlocklist,
  buildEdgeUrlBlocklistClear,
  type BrowserSiteZoneInput,
} from "~/services/mdm/windows/csp-browser.ts";
import {
  buildUpdatePolicy,
  buildUpdateInstallableQuery,
  buildUpdateInstalledQuery,
  buildUpdatePendingRebootQuery,
  type UpdatePolicyInput,
} from "~/services/mdm/windows/csp-update.ts";
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
// Lost Mode（Windows Custom ADMX 推送）
// ============================================================
//
// iOS Lost Mode 走 Apple MDM 命令（既有 app/services/devices.ts），與此模組無關。
// Windows 沒有原生 Lost Mode 指令，靠 ADMX Policy CSP 推 Registry 信箱 →
// Agent GpsCollector 監聽 Enabled 切換 GPS 採集頻率（平時 24h / Lost Mode 30s）。
//
// 每次推送都帶 ADMX install（idempotent Replace），新舊設備無差別；
// 沒法依賴 enrollment hook（既有設備未必 ingest 過 LostMode ADMX）。

export async function pushLostModeToDevice(
  device: WindowsDevice,
  input: LostModeEnableInput,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "LostMode",
    [buildLostModeAdmxInstall(), ...buildLostModeEnable(input)],
    "Lost Mode input is required",
  );
}

export async function removeLostModeFromDevice(
  device: WindowsDevice,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "LostMode",
    [buildLostModeAdmxInstall(), ...buildLostModeDisable()],
    "Lost Mode disable command build failed",
  );
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

// ============================================================
// Defender（PRD §4.1.2 惡意軟體限制）
// ============================================================
//
// 兩個能力：
//   1. push — Policy CSP 強制啟用 Realtime / Behavior / Cloud / IOAV /
//              Network / PUA。all=true 走 buildDefenderEnforceAll 全開套餐，
//              custom 走 buildDefenderEnforce 依欄位覆蓋。
//   2. query — Get Defender/Health/<node>，供 admin 主動拉當前防護狀態。
//              裝置回覆走既有 Get result → mdm_commands.response_payload
//              路徑；admin 前端讀該欄位即可。

export interface PushDefenderInput {
  /** true = 套用全開預設；與 custom 同時提供時 custom 覆蓋對應欄位 */
  all?: boolean;
  /** 細項覆蓋；與 all 都不提供時拋 empty_input */
  custom?: DefenderEnforceInput;
}

export async function pushDefenderPolicyToDevice(
  device: WindowsDevice,
  input: PushDefenderInput,
): Promise<string[]> {
  const baseCmds = input.all ? buildDefenderEnforceAll() : [];
  const customCmds = input.custom ? buildDefenderEnforce(input.custom) : [];
  // custom 覆蓋 base 中同 LocURI 的命令，保留 base 未覆寫部分
  const customTargets = new Set(customCmds.map((c) => c.target));
  const merged = [
    ...baseCmds.filter((c) => !customTargets.has(c.target)),
    ...customCmds,
  ];
  return enqueueBatch(
    device,
    "DefenderPolicy",
    merged,
    "至少需提供 all=true 或 custom 任一欄位",
  );
}

export async function queryDefenderHealthOnDevice(
  device: WindowsDevice,
  nodes?: DefenderHealthNode[],
): Promise<string[]> {
  const cmds = nodes && nodes.length > 0
    ? buildDefenderHealthQuery(nodes)
    : buildDefenderHealthQuery();
  return enqueueBatch(
    device,
    "DefenderHealthQuery",
    cmds,
    "nodes 為空且無預設，這不可能發生",
  );
}

// ============================================================
// 網站黑名單（PRD §4.1.1）
// ============================================================
//
// IE Security Zone 4 (Restricted) 對 Edge Chromium 仍生效（Windows Security
// Zones 機制）。單一 Replace 承載整份清單，重推 = 覆蓋（不是 append）。

export type PushBlockedSitesInput =
  | { hosts: string[]; scope?: "device" | "user" }
  | { sites: BrowserSiteZoneInput["sites"]; scope?: "device" | "user" };

/**
 * 一次派 3 條 batch，覆蓋 Edge Chromium + IE 兩層：
 *   1. Edge ADMX install（idempotent Replace，多次派無副作用）
 *   2. Edge URLBlocklist Set（Chromium hive，主要封鎖鏈路）
 *   3. IE Site Zone 4 Set（IE 11 / Edge IE Mode / ActiveX fallback）
 *
 * scope=user 時 IE Zone 走 user 節點，Edge policy 仍是 Machine class（Edge
 * Chromium 政策只有 HKLM 一個位置）。
 *
 * host 純 host 名的清單會被兩層轉譯：
 *   - IE Zone 4：host + zone 對應
 *   - Edge：`*://<host>/*` pattern
 * sites 進階用法（明確指定 zone）**只**寫 IE，不同時派 Edge blocklist（因為
 * 只有 zone=4 才是「封鎖」語義）。
 */
export async function pushBlockedSitesToDevice(
  device: WindowsDevice,
  input: PushBlockedSitesInput,
): Promise<string[]> {
  const cmds: SyncMLCommand[] = [];

  if ("sites" in input) {
    // 進階模式：混合 zone；只寫 IE Zone，不觸發 Edge blocklist
    cmds.push(buildIESiteZoneAssignment({ sites: input.sites, scope: input.scope }));
    // 針對 zone=4 的 host 額外派 Edge blocklist
    const blockedHosts = input.sites.filter((s) => s.zone === 4).map((s) => s.host);
    if (blockedHosts.length > 0) {
      cmds.push(buildEdgeAdmxInstall(), buildEdgeUrlBlocklist(blockedHosts));
    }
  } else {
    // 簡易模式：hosts 統一封鎖，兩層一起派
    cmds.push(
      buildEdgeAdmxInstall(),
      buildEdgeUrlBlocklist(input.hosts),
      buildBlockedSites(input.hosts, input.scope ?? "device"),
    );
  }

  return enqueueBatch(
    device,
    "BlockedSites",
    cmds,
    "hosts 或 sites 需至少一個非空",
  );
}

export async function clearBlockedSitesFromDevice(
  device: WindowsDevice,
  scope: "device" | "user" = "device",
): Promise<string[]> {
  return enqueueBatch(
    device,
    "BlockedSitesClear",
    [
      buildEdgeAdmxInstall(),
      buildEdgeUrlBlocklistClear(),
      buildIESiteZoneClear(scope),
    ],
    "clear 命令構建失敗",
  );
}

// ============================================================
// OS 更新管理（PRD §5.6）
// ============================================================
//
// Windows Update 沒有「立即觸發」MDM 命令；能做的是強制 policy + 短時段，
// 讓下個 update poll cycle（通常幾分鐘內）依政策執行。「立即觸發」用便捷
// 路徑 triggerOsUpdateNow：AllowAutoUpdate=4（強制無用戶控制） +
// ScheduledInstallDay=0（每日） + ScheduledInstallTime=(now+delayHours)%24。
//
// 狀態查詢直接 Get Update CSP 三個節點；裝置回覆的 XML 由既有 SyncML ack
// 路徑寫回 mdm_commands.response_payload。

export async function pushUpdatePolicyToDevice(
  device: WindowsDevice,
  input: UpdatePolicyInput,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "UpdatePolicy",
    buildUpdatePolicy(input),
    "至少需提供一個 Update policy 欄位",
  );
}

/**
 * 「立即觸發」語義：組一份強制自動更新 + 短時段 policy 派下去。
 *
 * 裝置在下個 WU poll cycle（幾分鐘至半小時）依 policy 執行。
 *
 * @param delayHours 排程小時偏移，預設 0（即當前小時，若已過則今日不觸發，
 *                    改用下一天。實務給 0-2 即可）
 * @param now        供測試注入固定時間；生產不傳
 */
export async function triggerOsUpdateNow(
  device: WindowsDevice,
  delayHours = 0,
  now: Date = new Date(),
): Promise<{ commandIds: string[]; scheduledHour: number }> {
  if (!Number.isInteger(delayHours) || delayHours < 0 || delayHours > 6) {
    throw new AppError(
      400,
      "invalid_delay_hours",
      "delayHours 必須是 0-6 的整數",
    );
  }
  const scheduledHour = (now.getHours() + delayHours) % 24;
  const commandIds = await enqueueBatch(
    device,
    "UpdatePolicy",
    buildUpdatePolicy({
      autoUpdate: 4, // 強制安裝不需使用者確認
      scheduledDay: 0, // 每日
      scheduledHour,
    }),
    "triggerOsUpdateNow build 出的命令為空",
  );
  return { commandIds, scheduledHour };
}

export type UpdateStatusScope = "installable" | "installed" | "pendingReboot";

export async function queryUpdateStatusOnDevice(
  device: WindowsDevice,
  include: UpdateStatusScope[],
): Promise<string[]> {
  const cmds: SyncMLCommand[] = [];
  if (include.includes("installable")) cmds.push(buildUpdateInstallableQuery());
  if (include.includes("installed")) cmds.push(buildUpdateInstalledQuery());
  if (include.includes("pendingReboot")) cmds.push(buildUpdatePendingRebootQuery());
  return enqueueBatch(
    device,
    "UpdateStatusQuery",
    cmds,
    "include 需至少含 installable / installed / pendingReboot 其中之一",
  );
}
