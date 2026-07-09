/**
 * Jamf 庫存資料的解析輔助（供 sync 映射用）。
 *
 * 獨立成檔、不依賴 db client，以便單測（sync.ts 頂層 import db，直接測其內部
 * 函式會拖入整個 db 依賴，見 laps.test.ts 的相同考量）。
 */

/**
 * Jamf 日期字串 → Date。
 * null / 空字串 / 非法字串 / 1970 epoch（Jamf 以 "1970-01-01T00:00:00Z" 表示「無值」）皆回 null。
 */
export function parseJamfDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return null;
  return d;
}

/** integer 欄位防禦：null / undefined → null，否則四捨五入為整數。 */
export function roundOrNull(n: number | null | undefined): number | null {
  return n == null ? null : Math.round(n);
}
