/**
 * 自動回滾決策的純邏輯（無 DB 依賴，便於單測隔離）。
 * 編排（查健康 → 構建 roll-forward → 灰度派發）見 [[agent-rollback.ts]]。
 *
 * 起因（brain/wiki/agent-rollback-strategy.md §5「自動回滾觸發」）：灰度推新版後，
 * 壞 build（如 DI-bug）會讓設備啟動即崩 → 不再上報 → 落入 health 的 silent。silent
 * 比例超閾值即判定壞 build，自動回滾（發 roll-forward 包走 MajorUpgrade 換回好版本）。
 *
 * ⭐ 比例分母只算「已進入新版本階段」的設備（upgraded + silent），刻意排除：
 *   - pending：尚未輪到升級（仍在舊好版本），把它算進分母會在灰度進行中稀釋比例 →
 *     即使整批升級設備全崩也觸發不了，誤判為健康。
 *   - neverReported：從未裝 agent，跟本次升級無關。
 * 於是 silentRatio = silent /（upgraded + silent）= 「取得更新的設備中崩潰失聯的比例」，
 * 正是要的壞 build 信號。
 */

/** 自動回滾觸發策略（運維可調）。 */
export interface RollbackPolicy {
  /**
   * silent 占已升級同期（upgraded + silent）的觸發閾值，0..1。
   * 例 0.2 = 超過 20% 取得更新的設備失聯即判壞 build。嚴格大於才觸發。
   */
  silentRatioThreshold: number;
  /**
   * 最小同期樣本數（upgraded + silent）。不足則不判定（reason=insufficient_sample），
   * 避免小批誤判：2 台中 1 台 silent = 50% 但無統計意義。灰度首批建議 ≥ 10。
   */
  minCohortSize: number;
}

export type RollbackReason =
  /** silent 比例超閾值 → 觸發回滾 */
  | "silent_ratio_exceeded"
  /** silent 比例未超閾值 → 健康，不回滾 */
  | "healthy"
  /** 已升級同期樣本不足 minCohortSize → 暫不判定 */
  | "insufficient_sample";

export interface RollbackDecision {
  /** 是否觸發回滾 */
  shouldRollback: boolean;
  reason: RollbackReason;
  /** 已進入新版本階段的同期設備數 = upgraded + silent（即比例分母） */
  cohortSize: number;
  /** 失聯設備數 */
  silentCount: number;
  /** silent / cohortSize，0..1；cohort 為 0 時為 0 */
  silentRatio: number;
  /** 採用的閾值（回顯，便於審計與告警上下文） */
  threshold: number;
  /**
   * 回滾派發目標 = silent ∪ upgraded：所有取得了壞 build 的設備。
   * silent = 崩潰失聯，upgraded = 跑起來了但同樣是壞代碼，皆須換回好版本。
   * pending（仍在舊好版本）與 neverReported 不在回滾目標內。
   * 僅 shouldRollback 時有意義；其餘情況為 silent ∪ upgraded 的快照（無害）。
   */
  targetDeviceIds: string[];
}

interface HealthClassification {
  upgraded: readonly string[];
  silent: readonly string[];
  pending: readonly string[];
  neverReported: readonly string[];
}

/**
 * 純函數：由灰度健康分類 + 策略推導回滾決策。
 *
 * - cohort（分母）= upgraded + silent，刻意排除 pending / neverReported（見檔頭）。
 * - cohort < minCohortSize → insufficient_sample（不回滾）。
 * - silentRatio > threshold → silent_ratio_exceeded（回滾，目標 = silent ∪ upgraded）。
 * - 否則 healthy（不回滾）。
 */
export function decideRollback(
  health: HealthClassification,
  policy: RollbackPolicy,
): RollbackDecision {
  const silentCount = health.silent.length;
  const cohortSize = health.upgraded.length + silentCount;
  const silentRatio = cohortSize === 0 ? 0 : silentCount / cohortSize;
  const threshold = policy.silentRatioThreshold;
  // 目標永遠是「取得壞 build 的設備」= silent ∪ upgraded（兩集合天然互斥）。
  const targetDeviceIds = [...health.silent, ...health.upgraded];

  const base = { cohortSize, silentCount, silentRatio, threshold, targetDeviceIds };

  if (cohortSize < policy.minCohortSize) {
    return { shouldRollback: false, reason: "insufficient_sample", ...base };
  }
  if (silentRatio > threshold) {
    return { shouldRollback: true, reason: "silent_ratio_exceeded", ...base };
  }
  return { shouldRollback: false, reason: "healthy", ...base };
}
