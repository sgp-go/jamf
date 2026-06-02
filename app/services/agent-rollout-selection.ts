/**
 * Agent 灰度發佈的純選擇邏輯（無 DB 依賴，便於單測隔離）。
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
 * 排除已是目標版本的設備。純函數。
 * 灰度逐批放量靠此自然收斂：升級成功的設備下次上報版本即等於目標版本，退出候選。
 */
export function partitionByVersion(
  devices: readonly DeviceVersion[],
  targetVersion: string,
): { eligible: string[]; skipped: string[] } {
  const eligible: string[] = [];
  const skipped: string[] = [];
  for (const d of devices) {
    if (d.currentVersion === targetVersion) skipped.push(d.deviceId);
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
