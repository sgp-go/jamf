using System.Globalization;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Queue;
using CoGrowMDMAgent.Reporting;
using CoGrowMDMAgent.Reporting.Usage;
using CoGrowMDMAgent.Scheduling;

namespace CoGrowMDMAgent;

/// <summary>
/// Main service loop. Sleeps until the jittered slot, then runs one report
/// cycle. Failures are logged AND the payload is enqueued by the reporters
/// themselves; this Worker also drains the queue at startup and after every
/// cycle so a transient outage doesn't lose any reports.
/// </summary>
public class Worker : BackgroundService
{
    /// <summary>Max queued reports drained per cycle (keeps a single cycle
    /// bounded; remaining rows wait for the next cycle).</summary>
    private const int DrainBatchSize = 25;

    /// <summary>保留窗口（天）：created_at 早於 now-此天數的失敗報告不再重試，
    /// 成為 dead-letter（留庫審計）。30 天涵蓋寒暑假長期關機設備上線後仍可補送；
    /// usage 另有 <see cref="UsageReportDays"/> 天回填作雙保險。</summary>
    private const int RetentionDays = 30;

    /// <summary>每次上報週期回填的使用統計天數窗口（含當天）。後端以
    /// (deviceId, date) upsert，重複上報同一天會覆蓋，故安全地多帶幾天。</summary>
    private const int UsageReportDays = 7;

    private readonly ILogger<Worker> _logger;
    private readonly JitterScheduler _scheduler;
    private readonly DeviceReporter _deviceReporter;
    private readonly UsageReporter _usageReporter;
    private readonly IUsageStore _usageStore;
    private readonly DeviceFactsCollector _facts;
    private readonly IReportQueue _queue;
    private readonly AgentConfigProvider _configProvider;

    public Worker(
        ILogger<Worker> logger,
        JitterScheduler scheduler,
        DeviceReporter deviceReporter,
        UsageReporter usageReporter,
        IUsageStore usageStore,
        DeviceFactsCollector facts,
        IReportQueue queue,
        AgentConfigProvider configProvider)
    {
        _logger = logger;
        _scheduler = scheduler;
        _deviceReporter = deviceReporter;
        _usageReporter = usageReporter;
        _usageStore = usageStore;
        _facts = facts;
        _queue = queue;
        _configProvider = configProvider;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "CoGrowMDMAgent started; jitter offset = {Minutes} minutes",
            _scheduler.OffsetMinute);

        // 啟動先 drain 一次：上次 service crash/重啟前累積的失敗報告先嘗試送出
        await DrainQueueAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            // 每 cycle 起點 reload Registry → AgentConfig，使 MDM 推送 Registry CSP
            // 更新 token / endpoint 後本 cycle 立即生效，不必重啟 service
            _configProvider.TryReload();

            var nowUtc = DateTime.UtcNow;
            var dailySlot = _scheduler.GetNextRunTime(nowUtc);

            // 佇列有待重試項時，提前喚醒到最近的 next_retry_at，不必死等次日 slot
            // —— 一次網路抖動的補報延遲從「整天」降到退避間隔（首次 15min）。
            var earliestRetry = await GetEarliestRetryAsync(nowUtc, stoppingToken);
            var nextWake = earliestRetry is { } r && r < dailySlot ? r : dailySlot;
            var wait = nextWake - nowUtc;
            if (wait < TimeSpan.Zero) wait = TimeSpan.Zero;

            _logger.LogInformation(
                "Next wake at {NextWake:o} (in {Hours:F2}h); daily slot {Slot:o}",
                nextWake, wait.TotalHours, dailySlot);

            try
            {
                await Task.Delay(wait, stoppingToken);
            }
            catch (TaskCanceledException)
            {
                return;
            }

            // 越過本次算出的 daily slot 才跑完整採集 cycle；否則只是 retry 喚醒，僅 drain。
            if (DateTime.UtcNow >= dailySlot)
            {
                await RunReportCycleAsync(stoppingToken);
            }
            await DrainQueueAsync(stoppingToken);
        }
    }

    /// <summary>佇列中最近的 next_retry_at（保留窗口內）；查詢失敗不崩主循環，回 null。</summary>
    private async Task<DateTime?> GetEarliestRetryAsync(DateTime nowUtc, CancellationToken ct)
    {
        try
        {
            return await _queue.GetEarliestNextRetryAsync(
                nowUtc.AddDays(-RetentionDays), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "GetEarliestNextRetry failed — falling back to daily slot");
            return null;
        }
    }

    private async Task RunReportCycleAsync(CancellationToken ct)
    {
        try
        {
            await _deviceReporter.ReportAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Reporter 已自動入隊；這裡只記 log 不再額外處理
            _logger.LogError(ex, "Report cycle failed — payload enqueued for retry");
        }

        await ReportUsageAsync(ct);
    }

    /// <summary>
    /// 上報 <see cref="SessionUsageMonitor"/> 持續累計、持久化於 store 的近幾天
    /// 使用統計。失敗時 <see cref="UsageReporter"/> 已自行入隊重試；store 為真相
    /// 源，下個週期會再次全量回填，故此處只記 log 不額外處理。
    /// </summary>
    private async Task ReportUsageAsync(CancellationToken ct)
    {
        try
        {
            var since = DateTime.Now.Date
                .AddDays(-(UsageReportDays - 1))
                .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var days = await _usageStore.LoadSinceAsync(since, ct);
            if (days.Count == 0) return;

            var stats = days
                .Select(d => new UsageStatItem
                {
                    Date = d.Date,
                    TotalMinutes = d.TotalMinutes,
                    Pickup = d.Pickup,
                    MaxContinuous = d.MaxContinuous,
                    TimeStats = d.TimeStats.Count == 0
                        ? null
                        : new Dictionary<string, int>(d.TimeStats),
                })
                .ToList();

            await _usageReporter.ReportAsync(
                stats, sessionId: null, _facts.CollectSerialNumber(), ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Usage report cycle failed — payload enqueued for retry");
        }
    }

    private async Task DrainQueueAsync(CancellationToken ct)
    {
        var nowUtc = DateTime.UtcNow;
        var cutoff = nowUtc.AddDays(-RetentionDays);
        IReadOnlyList<PendingReport> batch;
        try
        {
            batch = await _queue.DequeueDueAsync(DrainBatchSize, nowUtc, cutoff, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Queue dequeue failed — skipping drain this cycle");
            return;
        }
        if (batch.Count == 0) return;

        _logger.LogInformation("Draining {Count} due reports", batch.Count);
        foreach (var item in batch)
        {
            if (ct.IsCancellationRequested) return;
            await DrainOneAsync(item, ct);
        }
    }

    private async Task DrainOneAsync(PendingReport item, CancellationToken ct)
    {
        try
        {
            bool ok = item.ReportType switch
            {
                ReportType.DeviceReport => await _deviceReporter.RetryAsync(item.Payload, ct),
                ReportType.UsageReport => await _usageReporter.RetryAsync(item.Payload, ct),
                _ => false,
            };

            if (ok)
            {
                await _queue.MarkSuccessAsync(item.Id, ct);
                _logger.LogInformation(
                    "Retry succeeded for queued id={Id} type={Type}",
                    item.Id, item.ReportType);
            }
            else
            {
                await _queue.IncrementAttemptAsync(
                    item.Id,
                    item.ReportType switch
                    {
                        ReportType.DeviceReport or ReportType.UsageReport
                            => "non-success http status on retry",
                        _ => $"unknown report_type: {item.ReportType}",
                    },
                    ct);
                _logger.LogWarning(
                    "Retry failed (non-2xx) for queued id={Id} attempt={Attempt}",
                    item.Id, item.AttemptCount + 1);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            await _queue.IncrementAttemptAsync(item.Id, ex.Message, CancellationToken.None);
            _logger.LogWarning(
                ex, "Retry threw for queued id={Id} attempt={Attempt}",
                item.Id, item.AttemptCount + 1);
        }
    }
}
