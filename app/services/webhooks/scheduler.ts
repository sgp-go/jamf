import { processDueDeliveries } from "./dispatcher.ts";

/**
 * Webhook 推送排程器。
 *
 * MVP 用 setInterval 輪詢 webhook_deliveries 表找到期的 delivery：
 *   - status = 'pending'（首次推送）
 *   - status = 'failed' AND nextRetryAt <= now（重試）
 *
 * 預設 10 秒一輪、單輪上限 50 筆。對 8000 台規模綽綽有餘。
 *
 * 後續可換成 PG NOTIFY/LISTEN 即時觸發 + 分佈式 worker；MVP 不必。
 */

interface SchedulerOptions {
  intervalMs?: number;
  batchSize?: number;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export function startWebhookScheduler(opts: SchedulerOptions = {}): void {
  if (timer) return;
  const intervalMs = opts.intervalMs ?? 10_000;
  const batchSize = opts.batchSize ?? 50;

  const tick = async () => {
    if (running) return; // 上一輪還沒跑完跳過，避免堆積
    running = true;
    try {
      await processDueDeliveries({ limit: batchSize });
    } catch (err) {
      console.error("[webhook scheduler] tick error", err);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  // 啟動時也立刻跑一次（不等第一個 interval）
  void tick();
}

export function stopWebhookScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
