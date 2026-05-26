import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 簽名計算。
 *
 * 簽名範圍：`{timestamp}.{body}`（用 `.` 分隔避免長度模糊性攻擊）
 * 輸出格式：`sha256={hex}`，跟 GitHub / Stripe 等業界常見 webhook 簽名格式對齊。
 *
 * @param secret    Webhook endpoint 註冊時生成的密鑰
 * @param timestamp Unix 時間（秒）
 * @param body      要簽名的 HTTP body（JSON 字串）
 */
export function signWebhookPayload(opts: {
  secret: string;
  timestamp: number;
  body: string;
}): string {
  const signingString = `${opts.timestamp}.${opts.body}`;
  const digest = createHmac("sha256", opts.secret)
    .update(signingString, "utf8")
    .digest("hex");
  return `sha256=${digest}`;
}

/**
 * 驗證來自外部（如：台灣後端轉發回來的補推）的 webhook 簽名。
 *
 * 用 timingSafeEqual 避免時序側信道攻擊（避免攻擊者透過比對響應時間
 * 猜測簽名前綴匹配長度）。
 *
 * @returns true = 簽名有效；false = 簽名不匹配或長度不一致
 */
export function verifyWebhookSignature(opts: {
  secret: string;
  timestamp: number;
  body: string;
  signature: string;
}): boolean {
  const expected = signWebhookPayload({
    secret: opts.secret,
    timestamp: opts.timestamp,
    body: opts.body,
  });
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(opts.signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
