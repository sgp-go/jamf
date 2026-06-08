/**
 * Webhook 事件類型清單。
 *
 * 命名規則：`{resource}.{action}`，動詞用過去式（表示「已發生」）。
 * 新增事件時在此處宣告，type 系統會強制 publisher 端對齊。
 */
export const WEBHOOK_EVENT_TYPES = [
  // ─ device 生命週期 ─
  "device.enrolled",
  "device.online",
  "device.offline",
  "device.transferred",
  "device.unenrolled",

  // ─ MDM 命令狀態變化 ─
  "command.queued",
  "command.sent",
  "command.acknowledged",
  "command.completed",
  "command.failed",

  // ─ 配置描述檔套用結果 ─
  "profile.applied",
  "profile.failed",
  "profile.removed",

  // ─ Inventory ─
  "inventory.updated",

  // ─ App 派發結果 ─
  "app.installed",
  "app.install_failed",
  "app.uninstalled",

  // ─ Agent App ─
  "agent.installed",
  // Agent 啟動時的 checkin（區別於定時 report）：上線即觸發待辦（如 LAPS 輪換）。
  "agent.checkin",
  "agent.reported",
  "agent.usage_reported",
  // 使用統計回退異常：同設備同日累計值較既有值變小（疑似本地 db 被篡改）。
  "agent.usage_anomaly",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Webhook 推送的 JSON envelope。所有事件共用此結構，`data` 為事件特有 payload。
 *
 * event_id   業務事件穩定 ID（同一事件重試時不變，台灣後端可作冪等鍵）
 * delivery_id 每次推送嘗試唯一 ID（同 event 重試時每次不同）
 */
export interface WebhookEnvelope<T = Record<string, unknown>> {
  event_id: string;
  delivery_id: string;
  event_type: WebhookEventType;
  occurred_at: string;
  tenant_id: string;
  data: T;
}
