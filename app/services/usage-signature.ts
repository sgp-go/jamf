/**
 * 使用統計上報的 HMAC 簽名（防篡改第 3 層，輕量版）。
 *
 * 密鑰＝per-device `agent_token`（後端鑑權時本就從 Authorization header 拿到
 * 原文，無需額外密鑰下發）。簽名對象是一個**規範化字串**（非 JSON），兩端用
 * 同一拼接規則構造，避開跨語言 JSON 序列化差異。
 *
 * ⚠️ 規範化格式必須與 agent 端 `Reporting/Usage/UsageSignature.cs` 逐字節一致；
 * 兩端各有單元測試對同一向量斷言同一 hex。
 *
 * canonical 格式：
 *   line 0: serialNumber
 *   line 1: sessionId（null → 空字串）
 *   line 2..: 每條 stat 一行：`date|totalMinutes|pickup|maxContinuous|timeStats`
 *     timeStats: hour 數字升序排列，`hour=minutes` 以 "," join（無則空字串）
 *   行間以 "\n" 連接。
 */

export interface SignableStat {
  date: string;
  totalMinutes: number;
  pickup: number;
  maxContinuous: number;
  timeStats?: Record<string, number> | null;
}

export interface SignableUsage {
  serialNumber: string;
  sessionId?: string | null;
  stats: SignableStat[];
}

function canonicalTimeStats(timeStats: Record<string, number> | null | undefined): string {
  if (!timeStats) return "";
  return Object.entries(timeStats)
    .map(([hour, minutes]) => [Number(hour), minutes] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([hour, minutes]) => `${hour}=${minutes}`)
    .join(",");
}

export function canonicalUsageMessage(input: SignableUsage): string {
  const lines = [
    input.serialNumber,
    input.sessionId ?? "",
    ...input.stats.map((s) =>
      `${s.date}|${s.totalMinutes}|${s.pickup}|${s.maxContinuous}|${canonicalTimeStats(s.timeStats)}`
    ),
  ];
  return lines.join("\n");
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256(key=token, message) → lowercase hex。 */
export async function computeUsageSignature(
  token: string,
  input: SignableUsage,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalUsageMessage(input)),
  );
  return toHex(sig);
}

/** 定長 hex 字串的 constant-time 比較，避免計時側信道。 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 驗證 provided 簽名是否匹配。 */
export async function verifyUsageSignature(
  token: string,
  input: SignableUsage,
  provided: string,
): Promise<boolean> {
  const expected = await computeUsageSignature(token, input);
  return timingSafeEqualHex(expected, provided.toLowerCase());
}
