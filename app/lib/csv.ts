/**
 * CSV 序列化工具（RFC 4180）。
 *
 * - 含逗號 / 引號 / 換行的欄位自動加引號並轉義
 * - 防 CSV 公式注入：以 = + - @ 開頭的欄位前綴單引號，
 *   避免匯出檔在 Excel / Sheets 開啟時被當公式執行
 * - UTF-8 BOM 由 caller 決定是否加（Excel 開繁中需要）
 */

/** Excel/Sheets 會把這些開頭字元解釋為公式 */
const FORMULA_LEADING_CHARS = new Set(["=", "+", "-", "@"]);

export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str = typeof value === "string" ? value : String(value);

  if (str.length > 0 && FORMULA_LEADING_CHARS.has(str[0])) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    str = `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export function toCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",");
}

/** UTF-8 BOM，繁中內容給 Excel 直接開時必加，否則亂碼 */
export const CSV_UTF8_BOM = "\u{FEFF}";
