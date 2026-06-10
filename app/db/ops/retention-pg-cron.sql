-- CoGrow MDM — 資料保留清理（pg_cron）
--
-- 用途：定期清除過期的審計與 webhook 記錄，落實保留週期承諾。
--   audit_logs         保留 365 天（合規）
--   webhook_deliveries 保留 90 天（運維記錄；90 天後皆為終態 delivered/dead）
--   event_log          保留 90 天（與 webhook_deliveries 同週期）
--
-- ⚠️ 為什麼不走 drizzle migration（app/db/migrate.ts）：
--   pg_cron 是 PostgreSQL 擴展，需在 postgresql.conf 設
--     shared_preload_libraries = 'pg_cron'
--   並重啟資料庫後才能 CREATE EXTENSION。把它放進 drizzle 自動遷移鏈會在
--   未預載 pg_cron 的環境（如本地 docker postgres）讓整個 `deno task db:migrate`
--   失敗。故本檔為「生產 ops 一次性手動執行」的獨立腳本，非 schema migration。
--
-- 執行方式（生產 ops，對「應用資料庫」執行一次；可重複執行，jobname 會 upsert）：
--   psql "$DATABASE_URL" -f app/db/ops/retention-pg-cron.sql
--
-- 前置條件：
--   1. postgresql.conf: shared_preload_libraries = 'pg_cron'，已重啟。
--   2. pg_cron 預設只在 cron.database_name（預設 'postgres'）那個庫運行排程。
--      - 自建 PG：建議設 cron.database_name = '<你的應用庫>'，讓排程直接在應用庫跑，
--        本檔下方用 cron.schedule 即可。
--      - 受管 PG（RDS/Cloud SQL）或 pg_cron 固定在 'postgres' 庫：改用本檔末尾的
--        cron.schedule_in_database 版本，把命令指向應用庫。

-- 1) 安裝擴展（需 superuser；擴展建在 cron.database_name 指定的庫）
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2) 排程清理（每日凌晨錯開時段，UTC；cron.schedule 以 jobname 為鍵 upsert，冪等）
--    時間錯開避免同時間大量 DELETE 互相爭鎖。

-- audit_logs 保留 365 天
SELECT cron.schedule(
  'cogrow_audit_logs_retention',
  '17 3 * * *',
  $$DELETE FROM audit_logs WHERE created_at < now() - interval '365 days'$$
);

-- webhook_deliveries 保留 90 天
SELECT cron.schedule(
  'cogrow_webhook_deliveries_retention',
  '32 3 * * *',
  $$DELETE FROM webhook_deliveries WHERE created_at < now() - interval '90 days'$$
);

-- event_log 保留 90 天
SELECT cron.schedule(
  'cogrow_event_log_retention',
  '47 3 * * *',
  $$DELETE FROM event_log WHERE created_at < now() - interval '90 days'$$
);

-- 3) 驗證與運維
--   檢視已排程的 job：     SELECT jobid, jobname, schedule, command, active FROM cron.job;
--   檢視最近執行結果：     SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
--   手動停用某個清理：     SELECT cron.unschedule('cogrow_audit_logs_retention');
--   調整保留天數：         重跑本檔（改 interval），同名 job 會被覆蓋。

-- ──────────────────────────────────────────────────────────────────────────
-- 替代版本：pg_cron 固定在 'postgres' 庫、需指向應用庫時（受管 PG 常見）
-- 把上方三個 cron.schedule 改成 cron.schedule_in_database（pg_cron >= 1.4），
-- 將 '<APP_DB>' 換成你的應用庫名：
--
--   SELECT cron.schedule_in_database(
--     'cogrow_audit_logs_retention', '17 3 * * *',
--     $$DELETE FROM audit_logs WHERE created_at < now() - interval '365 days'$$,
--     '<APP_DB>'
--   );
--   SELECT cron.schedule_in_database(
--     'cogrow_webhook_deliveries_retention', '32 3 * * *',
--     $$DELETE FROM webhook_deliveries WHERE created_at < now() - interval '90 days'$$,
--     '<APP_DB>'
--   );
--   SELECT cron.schedule_in_database(
--     'cogrow_event_log_retention', '47 3 * * *',
--     $$DELETE FROM event_log WHERE created_at < now() - interval '90 days'$$,
--     '<APP_DB>'
--   );
