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
import { type MdmDevice, mdmDevices } from "~/db/schema/devices.ts";
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
  assertValidComputerName,
  buildRenameAdmxInstall,
  buildDeviceRename,
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
  buildDeviceInstallPolicy,
  buildDeviceInstallPolicyClear,
  type DeviceInstallPolicyInput,
} from "~/services/mdm/windows/csp-device-install.ts";
import {
  buildSoftWipeAdmxInstall,
  buildSoftWipeReset,
  buildSoftWipeTrigger,
  type SoftWipeWhitelist,
} from "~/services/mdm/windows/csp-soft-wipe.ts";
import { apps } from "~/db/schema/apps.ts";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  buildBlockedSites,
  buildIESiteZoneAssignment,
  buildIESiteZoneClear,
  buildEdgeAdmxInstall,
  buildEdgeUrlBlocklist,
  buildEdgeUrlBlocklistClear,
  buildEdgeBrowserSignin,
  buildEdgeBrowserSigninClear,
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

/** template 是否依賴序號（{serial} / {serial4}）。含序號變數時，enroll 當下序號尚未 pull，
 * 需等 agent 首次上報 backfill 序號後才能算出最終名稱。 */
export function templateNeedsSerial(template: string): boolean {
  return /\{serial4?\}/.test(template);
}

export type DeviceRenameSkipReason =
  | "no_template" // tenant 未設 namingTemplate
  | "awaiting_serial" // template 需序號但序號尚未 sync（等下次上報）
  | "already_applied"; // 目標名 == 已派名，無需重派

export type DeviceRenameDecision =
  | { action: "dispatch"; desiredName: string }
  | { action: "skip"; reason: DeviceRenameSkipReason; desiredName?: string };

/**
 * 自動命名純決策：給定 template / 當前 context / 已派名（assignedName），
 * 判斷是否需要派 rename。無副作用，供 reconcile 與單元測試共用。
 *
 * - 無 template → skip no_template
 * - template 需序號但序號缺 → skip awaiting_serial（避免派出 {serial4}=0000 的錯名）
 * - 算出的目標名 == assignedName → skip already_applied（去重，避免每次上報重派）
 * - 否則 → dispatch desiredName
 */
export function decideDeviceRename(opts: {
  template: string | null | undefined;
  ctx: RenameTemplateContext;
  assignedName: string | null;
}): DeviceRenameDecision {
  const template = opts.template?.trim();
  if (!template) return { action: "skip", reason: "no_template" };
  if (templateNeedsSerial(template) && !opts.ctx.serialNumber) {
    return { action: "skip", reason: "awaiting_serial" };
  }
  const desiredName = renderDeviceNameTemplate(template, opts.ctx);
  if (desiredName === opts.assignedName) {
    return { action: "skip", reason: "already_applied", desiredName };
  }
  return { action: "dispatch", desiredName };
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

  // 驗證計算機名（≤15 字、無非法字元）；非法直接拋 400
  try {
    assertValidComputerName(appliedName);
  } catch (e) {
    throw new AppError(
      400,
      "invalid_computer_name",
      e instanceof Error ? e.message : String(e),
    );
  }

  // Accounts CSP Domain/ComputerName 對 workgroup / PPKG 設備 406 不支援（真機 PF5XSMN1 驗），
  // 改走 agent 信箱：ADMX ingest（idempotent，確保信箱存在）+ DeviceRename policy Replace 同 batch，
  // Agent RenameWatcher 讀 HKLM\Software\CoGrow\Agent\Rename 跑 Rename-Computer（reboot 生效）。
  const renameId = crypto.randomUUID();
  const commandIds = await enqueueWindowsCommandsBatch({
    deviceUdid: device.udid!,
    commands: [
      { commandType: "policy_admx_install", command: buildRenameAdmxInstall() },
      {
        commandType: "RenameDevice",
        command: buildDeviceRename({ newName: appliedName, renameId })[0],
      },
    ],
  });
  // 持久化「已派的目標名」——所有 rename 路徑（admin 手動 + 自動 reconcile）都經此，
  // 讓 reconcileDeviceName 能靠 assignedName 去重，不會每次上報重派同名 rename。
  await db.update(mdmDevices).set({ assignedName: appliedName, updatedAt: new Date() })
    .where(eq(mdmDevices.id, device.id));
  return { commandIds, appliedName };
}

/**
 * 自動命名 reconcile（PRD §5.1）：把設備名對齊到 tenant 的 namingTemplate 展開結果。
 *
 * enroll 當下序號通常還沒 pull（含 {serial*} 的 template 算不出最終名），故不在 enroll 硬派；
 * 改由此函式在「① enroll hook ② agent 每次上報（序號已 backfill）」被呼叫，做 desired-state
 * 收斂：序號到位、且目標名 != 已派名時才派一次 rename（agent 信箱），之後上報自動 skip。
 *
 * 非 Windows / 無 udid / 無 template / 序號未到 / 已套用 → 一律安全 skip，不拋。
 */
export async function reconcileDeviceName(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<DeviceRenameDecision | { action: "skip"; reason: "not_windows" }> {
  const cfg = await db.query.selfMdmConfigs.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.isActive, true)),
    columns: { namingTemplate: true },
  });

  const device = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.deviceId), eqOp(t.tenantId, opts.tenantId)),
    columns: {
      id: true,
      tenantId: true,
      platform: true,
      udid: true,
      serialNumber: true,
      deviceGroupId: true,
      assignedName: true,
    },
  });
  if (!device || device.platform !== "windows" || !device.udid) {
    return { action: "skip", reason: "not_windows" };
  }

  const schoolCode = device.deviceGroupId
    ? (await db.query.deviceGroups.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.id, device.deviceGroupId!),
      columns: { code: true },
    }))?.code ?? null
    : null;

  const ctx: RenameTemplateContext = {
    schoolCode,
    serialNumber: device.serialNumber,
    udid: device.udid,
  };
  const decision = decideDeviceRename({
    template: cfg?.namingTemplate,
    ctx,
    assignedName: device.assignedName,
  });
  if (decision.action === "dispatch") {
    await pushDeviceRenameToDevice(device, { template: cfg!.namingTemplate! }, ctx);
  }
  return decision;
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

/**
 * Edge BrowserSignin policy 推送。
 *
 * URLBlocklist 生產配套：學校場景推 mode=0（禁止 Edge 登入 MS 帳號），
 * 防止學生登私人帳號後 URLBlocklist 被 by-design 免疫掉。
 *
 * batch 派 2 條：ADMX install（idempotent）+ Policy Set。
 */
export type EdgeBrowserSigninMode = 0 | 1 | 2;

export async function pushEdgeBrowserSigninToDevice(
  device: WindowsDevice,
  mode: EdgeBrowserSigninMode,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "EdgeBrowserSignin",
    [buildEdgeAdmxInstall(), buildEdgeBrowserSignin(mode)],
    "BrowserSignin mode 缺失",
  );
}

export async function clearEdgeBrowserSigninFromDevice(
  device: WindowsDevice,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "EdgeBrowserSigninClear",
    [buildEdgeAdmxInstall(), buildEdgeBrowserSigninClear()],
    "clear 命令構建失敗",
  );
}

// ============================================================
// DeviceInstallation 設備類黑名單（PRD §5.4 進階 USB 管控）
// ============================================================
//
// 比 Storage CSP 更徹底：按 Setup Class GUID / Hardware ID / removable-flag
// 全類別禁用。適用場景：學校要一刀切禁 U 盤（含讀卡機 / 外接硬碟）、禁藍牙、
// 禁 USB 相機等超越 Storage CSP 範圍的需求。
//
// 空輸入拋 400。retroactive 決定是否影響已裝設備（預設 false 只擋新插入）。

export async function pushDeviceInstallPolicyToDevice(
  device: WindowsDevice,
  input: DeviceInstallPolicyInput,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "DeviceInstallPolicy",
    buildDeviceInstallPolicy(input),
    "至少需提供 blockedClasses / blockedHardwareIds / blockRemovableDevices 其中之一",
  );
}

export async function clearDeviceInstallPolicyFromDevice(
  device: WindowsDevice,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "DeviceInstallPolicyClear",
    buildDeviceInstallPolicyClear(),
    "clear 命令構建失敗",
  );
}

// ============================================================
// Soft Wipe（PRD §5.1 附加：學生畢業換人零 IT 介入清理）
// ============================================================
//
// 目標：Agent SYSTEM 權限清乾淨學生痕跡（user profile / 用戶自裝 App /
// 瀏覽器數據 / Recycle Bin / Temp），保留 Windows 系統 + Agent + MDM 派發
// 的 App + MDM enrollment。跟 Windows RemoteWipe/doWipe 對比：
//   - doWipe：Windows 系統層完全重置，需 IT 現場重跑 PPKG
//   - SoftWipe：不動 Windows 系統，Agent 保留，MDM enrollment 保留，秒級完成
//
// 白名單來源：
//   1. tenant 下所有 Windows platform + kind in {msi, msix, winget} 的 App
//      （tenantId=null 的「全平台共用 App」如 Agent 自身也包含）
//   2. 額外 extraPreserveAppIds（admin 明確指定保留的 app id）
//   3. 硬編碼系統 essentials（Windows 內建 UWP）— 詳見 SYSTEM_UWP_WHITELIST

/** Windows 系統內建 UWP，絕不刪 */
const SYSTEM_UWP_WHITELIST_PATTERNS = [
  "Microsoft.WindowsCalculator",
  "Microsoft.WindowsCamera",
  "Microsoft.WindowsAlarms",
  "Microsoft.WindowsNotepad",
  "Microsoft.Windows.Photos",
  "Microsoft.WindowsStore",
  "Microsoft.MicrosoftEdge", // Edge Chromium（設備正常上網 / URLBlocklist 政策必需）
  "Microsoft.MicrosoftEdge.Stable",
  "Microsoft.MicrosoftEdgeDevToolsClient",
  "Microsoft.SecHealthUI", // Windows Security UI
  "MicrosoftWindows.Client", // Windows shell 系列
  "Microsoft.UI.Xaml",
  "Microsoft.VCLibs",
  "Microsoft.NET.Native", // .NET Native runtime
  "Windows.PrintDialog", // 打印對話框
];

export interface SoftWipeInput {
  /** 額外要保留的 App id 列表（在 whitelist 計算後合併進去） */
  extraPreserveAppIds?: string[];
}

/**
 * 從 apps 表計算 SoftWipe 白名單。
 *
 * 邏輯：
 *   - Windows platform apps where tenantId=<tenant> OR tenantId=null（全平台共用如 Agent）
 *   - kind ∈ {msi, msix, winget}
 *   - bundleId / wingetId 非空
 *   - 按 kind 分桶輸出
 *
 * 系統內建 UWP 走 SYSTEM_UWP_WHITELIST_PATTERNS 硬編碼，Agent 端會做前綴匹配
 * （因為 UWP PFN 帶 publisher hash，例如 `Microsoft.WindowsCalculator_8wekyb3d8bbwe`，
 * 匹配用 startsWith）。
 */
export async function computeSoftWipeWhitelist(
  tenantId: string,
  extraPreserveAppIds?: string[],
): Promise<SoftWipeWhitelist> {
  const rows = await db
    .select({
      id: apps.id,
      kind: apps.kind,
      bundleId: apps.bundleId,
      wingetId: apps.wingetId,
    })
    .from(apps)
    .where(
      and(
        eq(apps.platform, "windows"),
        or(eq(apps.tenantId, tenantId), isNull(apps.tenantId)),
      ),
    );

  const msi: string[] = [];
  const uwp: string[] = [...SYSTEM_UWP_WHITELIST_PATTERNS];
  const winget: string[] = [];

  const extraSet = new Set(extraPreserveAppIds ?? []);
  for (const r of rows) {
    // extraPreserveAppIds 覆蓋 kind 過濾（admin 顯式指定 = 必保留）
    // 但仍需 bundleId / wingetId 有值才能寫入白名單
    if (r.kind === "msi" && r.bundleId) {
      msi.push(r.bundleId);
    } else if (r.kind === "msix" && r.bundleId) {
      uwp.push(r.bundleId);
    } else if (r.kind === "winget" && r.wingetId) {
      winget.push(r.wingetId);
    }
    // extra 邏輯：若指定的 app 不在上面被 include，補一次
    if (extraSet.has(r.id)) {
      if (r.bundleId && !msi.includes(r.bundleId) && !uwp.includes(r.bundleId)) {
        // bundle id 語意分不清 msi/msix，兩桶都放（Agent 端會分別匹配對應類別）
        if (r.kind === "msix") uwp.push(r.bundleId);
        else msi.push(r.bundleId);
      }
      if (r.wingetId && !winget.includes(r.wingetId)) winget.push(r.wingetId);
    }
  }

  return {
    msiProductCodes: dedupe(msi),
    uwpPfns: dedupe(uwp),
    wingetIds: dedupe(winget),
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * 觸發設備 Soft Wipe：
 *   1. batch 派 ADMX install + Trigger（含 whitelist JSON + wipeId）
 *   2. Agent 端 SoftWipeWatcher 監聽 Registry 觸發清理
 *   3. 完成後 Agent 上報 → 後端發 webhook `device.soft_wiped`
 */
export async function pushSoftWipeToDevice(
  device: WindowsDevice,
  input: SoftWipeInput = {},
): Promise<{ commandIds: string[]; wipeId: string; whitelistSize: number }> {
  const whitelist = await computeSoftWipeWhitelist(
    device.tenantId,
    input.extraPreserveAppIds,
  );
  const wipeId = crypto.randomUUID();
  const commandIds = await enqueueBatch(
    device,
    "SoftWipe",
    [buildSoftWipeAdmxInstall(), buildSoftWipeTrigger({ whitelist, wipeId })],
    "SoftWipe build 失敗",
  );
  const whitelistSize =
    whitelist.msiProductCodes.length +
    whitelist.uwpPfns.length +
    whitelist.wingetIds.length;
  return { commandIds, wipeId, whitelistSize };
}

/**
 * 撤銷 Soft Wipe 觸發（在 Agent 執行前緊急止血用）。
 * 已刪的數據不會回來，僅避免 Agent 再次執行同一個 wipe。
 */
export async function cancelSoftWipeOnDevice(
  device: WindowsDevice,
): Promise<string[]> {
  return enqueueBatch(
    device,
    "SoftWipeReset",
    [buildSoftWipeAdmxInstall(), buildSoftWipeReset()],
    "SoftWipe reset build 失敗",
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
