/**
 * 使用統計的單調合併純邏輯（防篡改第 2 層核心）。
 *
 * 抽成無 DB 依賴的純函式，便於單元測試（不必起 postgres）。`upsertUsageStats`
 * 取既有行後呼叫本函式算出要寫入的合併值與回退異常。
 */

export interface UsageStatItemInput {
  date: string;
  totalMinutes: number;
  pickup: number;
  maxContinuous: number;
  timeStats?: Record<string, number>;
}

/** 既有行中參與單調性比較的欄位子集。 */
export interface ExistingUsage {
  totalMinutes: number;
  pickup: number;
  maxContinuous: number;
  timeStats?: Record<string, number> | null;
}

/** 使用統計回退異常：上報值較既有值變小（天內累計理應只增不減）。 */
export interface UsageAnomaly {
  date: string;
  field: "totalMinutes" | "pickup" | "maxContinuous";
  previous: number;
  reported: number;
}

export interface MergedUsage {
  totalMinutes: number;
  pickup: number;
  maxContinuous: number;
  timeStats: Record<string, number> | null;
}

export interface UsageMergeResult {
  merged: MergedUsage;
  anomalies: UsageAnomaly[];
}

/** 逐小時取 max 合併 timeStats，防某小時被改小。 */
export function mergeTimeStats(
  existing: Record<string, number> | null | undefined,
  reported: Record<string, number> | null | undefined,
): Record<string, number> | null {
  const out: Record<string, number> = { ...(existing ?? {}) };
  for (const [hour, minutes] of Object.entries(reported ?? {})) {
    out[hour] = Math.max(out[hour] ?? 0, minutes);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 對既有行採 max 合併 —— 收到較小的值不降低已記錄量（挫敗「改小本地 db 少報」），
 * 同時不丟真實增長。任一欄位出現回退即記為 anomaly。正常跨天流程不受影響：
 * 不同 date 各自獨立，同 date 只增。
 */
export function mergeUsage(
  existing: ExistingUsage | null | undefined,
  item: UsageStatItemInput,
): UsageMergeResult {
  const anomalies: UsageAnomaly[] = [];

  if (existing) {
    const checks: ReadonlyArray<[UsageAnomaly["field"], number, number]> = [
      ["totalMinutes", existing.totalMinutes, item.totalMinutes],
      ["pickup", existing.pickup, item.pickup],
      ["maxContinuous", existing.maxContinuous, item.maxContinuous],
    ];
    for (const [field, previous, reported] of checks) {
      if (reported < previous) {
        anomalies.push({ date: item.date, field, previous, reported });
      }
    }
  }

  const merged: MergedUsage = {
    totalMinutes: Math.max(existing?.totalMinutes ?? 0, item.totalMinutes),
    pickup: Math.max(existing?.pickup ?? 0, item.pickup),
    maxContinuous: Math.max(existing?.maxContinuous ?? 0, item.maxContinuous),
    timeStats: mergeTimeStats(existing?.timeStats, item.timeStats),
  };

  return { merged, anomalies };
}
