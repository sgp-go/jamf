/**
 * Windows Update CSP（W4）
 *
 * 兩個 namespace：
 * 1. Policy CSP / Update — Schedule / AutoUpdate / Defer / Pause / ActiveHours
 *    `./Device/Vendor/MSFT/Policy/Config/Update/<PolicyName>`（int format）
 *
 * 2. Update CSP — ApprovedUpdates / InstallableUpdates 等實際派發
 *    `./Device/Vendor/MSFT/Update/<Node>`
 *
 * Windows Update 本身不支援「立即觸發掃描」MDM 命令；admin 透過 Policy 強制自動更新 +
 * Schedule，裝置在下個 update poll cycle（預設 ~ 1 天）依政策自動執行。需要更快檢測，
 * 透過 EnterpriseModernAppManagement/AppManagement/UpdateScan（csp.ts buildUpdateScan）
 * 對 Store app 立即觸發，但 OS / quality update 走 WU 自身排程。
 */
import type { SyncMLCommand } from "./syncml.ts";

const POLICY_PREFIX = "./Device/Vendor/MSFT/Policy/Config/Update";
const UPDATE_PREFIX = "./Device/Vendor/MSFT/Update";

/**
 * AllowAutoUpdate 取值（policy-csp-update）：
 *   0=Notify before download
 *   1=Auto install at maintenance time
 *   2=Auto install and notify to restart（user can defer）
 *   3=Auto install and restart at scheduled time（搭配 ScheduledInstallDay/Time）
 *   4=Auto install and restart without user control（強制）
 *   5=Turn off automatic updates（不建議生產用）
 */
export type AutoUpdateMode = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * ScheduledInstallDay：0=每日 / 1=星期日 / 2=星期一 / ... / 7=星期六
 */
export type ScheduledDay = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface UpdatePolicyInput {
  /** 自動更新模式（AllowAutoUpdate） */
  autoUpdate?: AutoUpdateMode;
  /** ScheduledInstallDay；AllowAutoUpdate=3/4 才生效 */
  scheduledDay?: ScheduledDay;
  /** ScheduledInstallTime（0-23） */
  scheduledHour?: number;

  /** ActiveHoursStart（0-23） */
  activeHoursStart?: number;
  /** ActiveHoursEnd（0-23） */
  activeHoursEnd?: number;
  /** ActiveHoursMaxRange（8-18） */
  activeHoursMaxRange?: number;

  /** DeferQualityUpdatesPeriodInDays（0-30） */
  deferQualityDays?: number;
  /** DeferFeatureUpdatesPeriodInDays（0-365） */
  deferFeatureDays?: number;

  /** PauseQualityUpdates（暫停 35 天） */
  pauseQuality?: boolean;
  /** PauseFeatureUpdates（暫停 35 天） */
  pauseFeature?: boolean;

  /**
   * RequireDeferUpgrade / ExcludeWUDriversInQualityUpdate / 其它欄位先不暴露；
   * 教育場景 MVP 不需要。
   */
}

export function buildUpdatePolicy(input: UpdatePolicyInput): SyncMLCommand[] {
  const cmds: SyncMLCommand[] = [];

  if (input.autoUpdate !== undefined) {
    cmds.push(intPolicy("AllowAutoUpdate", input.autoUpdate));
  }
  if (input.scheduledDay !== undefined) {
    cmds.push(intPolicy("ScheduledInstallDay", input.scheduledDay));
  }
  if (input.scheduledHour !== undefined) {
    assertHour(input.scheduledHour, "scheduledHour");
    cmds.push(intPolicy("ScheduledInstallTime", input.scheduledHour));
  }

  if (input.activeHoursStart !== undefined) {
    assertHour(input.activeHoursStart, "activeHoursStart");
    cmds.push(intPolicy("ActiveHoursStart", input.activeHoursStart));
  }
  if (input.activeHoursEnd !== undefined) {
    assertHour(input.activeHoursEnd, "activeHoursEnd");
    cmds.push(intPolicy("ActiveHoursEnd", input.activeHoursEnd));
  }
  if (input.activeHoursMaxRange !== undefined) {
    if (input.activeHoursMaxRange < 8 || input.activeHoursMaxRange > 18) {
      throw new Error("activeHoursMaxRange 必須 8-18");
    }
    cmds.push(intPolicy("ActiveHoursMaxRange", input.activeHoursMaxRange));
  }

  if (input.deferQualityDays !== undefined) {
    if (input.deferQualityDays < 0 || input.deferQualityDays > 30) {
      throw new Error("deferQualityDays 必須 0-30");
    }
    cmds.push(intPolicy("DeferQualityUpdatesPeriodInDays", input.deferQualityDays));
  }
  if (input.deferFeatureDays !== undefined) {
    if (input.deferFeatureDays < 0 || input.deferFeatureDays > 365) {
      throw new Error("deferFeatureDays 必須 0-365");
    }
    cmds.push(intPolicy("DeferFeatureUpdatesPeriodInDays", input.deferFeatureDays));
  }

  if (input.pauseQuality !== undefined) {
    cmds.push(intPolicy("PauseQualityUpdates", input.pauseQuality ? 1 : 0));
  }
  if (input.pauseFeature !== undefined) {
    cmds.push(intPolicy("PauseFeatureUpdates", input.pauseFeature ? 1 : 0));
  }

  return cmds;
}

/**
 * 批准單一更新 GUID。透過 Update CSP 將指定更新加入 ApprovedUpdates，使裝置
 * 在下個 WU 巡檢週期套用。
 *
 * GUID 取得方式：先由 buildUpdateInstallableQuery() 查得 InstallableUpdates，
 * 從回應抓 update id（標準 GUID 格式），再餵給此函式。
 */
export function buildUpdateApprove(updateGuid: string): SyncMLCommand {
  assertGuid(updateGuid);
  return {
    cmdId: "0",
    verb: "Add",
    target: `${UPDATE_PREFIX}/ApprovedUpdates/${updateGuid}`,
    format: "chr",
    data: new Date().toISOString().slice(0, 10),
  };
}

/**
 * 查詢可安裝（已偵測但未批准）的更新清單。
 *
 * 回應 XML 中含 InstallableUpdates 子節點清單，admin 抽 update GUID 後決定
 * 是否 buildUpdateApprove。
 */
export function buildUpdateInstallableQuery(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Get",
    target: `${UPDATE_PREFIX}/InstallableUpdates`,
  };
}

/**
 * 查詢已安裝更新清單（供合規檢查 / KB 比對）。
 */
export function buildUpdateInstalledQuery(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Get",
    target: `${UPDATE_PREFIX}/InstalledUpdates`,
  };
}

/**
 * 查詢需要 reboot 的更新清單（裝置若已裝但未重啟，會列在此）。
 */
export function buildUpdatePendingRebootQuery(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Get",
    target: `${UPDATE_PREFIX}/PendingRebootUpdates`,
  };
}

function intPolicy(name: string, value: number): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: `${POLICY_PREFIX}/${name}`,
    format: "int",
    data: String(value),
  };
}

function assertHour(h: number, name: string): void {
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw new Error(`${name} 必須是 0-23 的整數，收到 ${h}`);
  }
}

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function assertGuid(g: string): void {
  if (!GUID_RE.test(g)) {
    throw new Error(`updateGuid 非標準 GUID 格式：${g}`);
  }
}
