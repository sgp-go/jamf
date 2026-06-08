/**
 * Agent 灰度發佈的純邏輯（無 DB 依賴，便於單測隔離）：設備選擇 + 升級健康評估。
 * 編排見 [[agent-rollout.ts]]。
 */

export type RolloutSelection =
  | { mode: "deviceIds"; deviceIds: string[] }
  | { mode: "count"; count: number }
  | { mode: "percentage"; percent: number };

export interface DeviceVersion {
  deviceId: string;
  currentVersion: string | null;
}

/**
 * 版本比對歸一化：剝離 SemVer build metadata（"+" 後綴）+ 去頭尾空白。
 *
 * 防真機抓到的契約錯配（2026-06-02）：agent 上報的 AssemblyInformationalVersion 可能帶
 * SourceLink 的 "+gitsha" 後綴（如 "1.3.5.0+abc123"），與 MSI ProductVersion 目標
 * "1.3.5.0" 不字面相等 → upgraded 桶永遠為空 → 自動回滾誤觸發。build 端已修（去後綴），
 * 此處再做一層防禦：比對只看 "+" 前的版本核心（SemVer 規定 build metadata 不參與版本相等）。
 */
export function normalizeVersion(v: string | null): string | null {
  if (v === null) return null;
  return v.split("+")[0].trim();
}

/**
 * 排除已是目標版本的設備。純函數。
 * 灰度逐批放量靠此自然收斂：升級成功的設備下次上報版本即等於目標版本，退出候選。
 */
export function partitionByVersion(
  devices: readonly DeviceVersion[],
  targetVersion: string,
): { eligible: string[]; skipped: string[] } {
  const target = normalizeVersion(targetVersion);
  const eligible: string[] = [];
  const skipped: string[] = [];
  for (const d of devices) {
    if (normalizeVersion(d.currentVersion) === target) skipped.push(d.deviceId);
    else eligible.push(d.deviceId);
  }
  return { eligible, skipped };
}

/**
 * 從候選選本批。確定順序取前 N（可復現）；逐批調用靠候選收斂覆蓋全量。純函數。
 * - deviceIds：只派既在候選又在指定列表中的（已升級的指定設備自動跳過）
 * - count：候選前 N（N 夾在 0..len）
 * - percentage：候選前 ceil(len × pct%)（pct 夾在 0..100）
 */
export function applySelection(
  eligible: readonly string[],
  selection: RolloutSelection,
): string[] {
  switch (selection.mode) {
    case "deviceIds": {
      const set = new Set(selection.deviceIds);
      return eligible.filter((id) => set.has(id));
    }
    case "count":
      return eligible.slice(0, Math.max(0, selection.count));
    case "percentage": {
      const pct = Math.min(100, Math.max(0, selection.percent));
      return eligible.slice(0, Math.ceil((eligible.length * pct) / 100));
    }
  }
}

export interface DeviceHealthInput {
  deviceId: string;
  currentVersion: string | null;
  lastReportedAt: Date | null;
}

/**
 * 灰度升級健康分類。核心信號（[[windows-agent-update-delivery]] §4）：升級後設備
 * 是否還在上報——DI-bug 壞 build 啟動即崩 → 不上報 → 落入 <c>silent</c> → 告警。
 */
export interface RolloutHealth {
  /** 當前版本 == 目標版本（升級成功） */
  upgraded: string[];
  /** 曾上報、現超窗口無上報 → 失聯告警（可能崩潰循環，考慮回滾） */
  silent: string[];
  /** 未升級但窗口內有上報（正常進行中 / 尚未輪到） */
  pending: string[];
  /** 從未上報（可能從未裝 agent，不計入告警） */
  neverReported: string[];
}

/**
 * 純函數：按「最新上報版本 + 上報時間」把設備分到四類。
 * silent = 曾上報但超 <paramref name="windowMinutes"/> 無上報，是「升級後失聯」的
 * 告警目標（與「從未裝 agent」的 neverReported 區分，避免誤報）。
 */
export function assessRolloutHealth(
  devices: readonly DeviceHealthInput[],
  targetVersion: string,
  nowMs: number,
  windowMinutes: number,
): RolloutHealth {
  const windowMs = Math.max(0, windowMinutes) * 60_000;
  const target = normalizeVersion(targetVersion);
  const upgraded: string[] = [];
  const silent: string[] = [];
  const pending: string[] = [];
  const neverReported: string[] = [];

  for (const d of devices) {
    if (normalizeVersion(d.currentVersion) === target) {
      upgraded.push(d.deviceId);
    } else if (d.lastReportedAt === null) {
      neverReported.push(d.deviceId);
    } else if (nowMs - d.lastReportedAt.getTime() > windowMs) {
      silent.push(d.deviceId);
    } else {
      pending.push(d.deviceId);
    }
  }
  return { upgraded, silent, pending, neverReported };
}
