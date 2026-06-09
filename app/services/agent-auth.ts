import { createHash } from "node:crypto";
import { AppError } from "~/lib/errors.ts";

/**
 * Agent 上報鑑權原語 —— 平台無關，被 Agent 上報端點與 Control 側共用。
 *
 * 這組函式從 `install-agent.ts` 抽出（原本與 Windows MSI 派發邏輯混在一起），
 * 目的是讓 Agent telemetry 服務不必依賴 Control 側的 install-agent 模組。
 * Token 的「簽發」（issueAgentTokenForDevice）仍屬 Control 側，留在 install-agent.ts；
 * 此處只負責「驗證 / 解析」這條對 Agent 服務必要的最小路徑。
 */

/**
 * Agent endpoint 鑑權門檻：
 *
 * - 若 device 已簽發 token（agent_token_hash 非 null）→ 要求必須帶
 *   Authorization: Bearer <token> 且匹配；不過拋 401
 * - 若 device 尚未簽發 token（agent_token_hash=null）→ 視為尚未啟用 token 機制，
 *   允許不帶 token 上報（兼容過渡期既有 Agent App 行為）
 *
 * @param device device row（必須含 agent_token_hash 欄位）
 * @param token  從 Authorization: Bearer 取出的 raw token（無則為 null）
 */
export function authorizeAgentReport(opts: {
  device: { id: string; agentTokenHash: string | null };
  token: string | null;
}): void {
  const { device, token } = opts;
  // 未簽發 token → 兼容模式
  if (!device.agentTokenHash) return;

  if (!token) {
    throw new AppError(
      401,
      "agent_token_required",
      "Device has agent token issued; request must include Authorization: Bearer <token>",
    );
  }
  const presented = createHash("sha256").update(token).digest("hex");
  if (presented !== device.agentTokenHash) {
    throw new AppError(401, "agent_token_invalid", "Invalid agent token");
  }
}

/** 從 Authorization header 解出 Bearer token 值；無則 null。 */
export function extractBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1] ?? null;
}
