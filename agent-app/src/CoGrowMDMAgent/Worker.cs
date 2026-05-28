using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Queue;
using CoGrowMDMAgent.Reporting;
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

    /// <summary>Reports that fail this many retries become dead-letters
    /// (kept in DB for audit, never re-tried). 10 ≈ ~10 days at 1 cycle/day.</summary>
    private const int MaxAttempts = 10;

    private readonly ILogger<Worker> _logger;
    private readonly JitterScheduler _scheduler;
    private readonly DeviceReporter _deviceReporter;
    private readonly UsageReporter _usageReporter;
    private readonly IReportQueue _queue;
    private readonly AgentConfigProvider _configProvider;

    public Worker(
        ILogger<Worker> logger,
        JitterScheduler scheduler,
        DeviceReporter deviceReporter,
        UsageReporter usageReporter,
        IReportQueue queue,
        AgentConfigProvider configProvider)
    {
        _logger = logger;
        _scheduler = scheduler;
        _deviceReporter = deviceReporter;
        _usageReporter = usageReporter;
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
            var nextRun = _scheduler.GetNextRunTime(nowUtc);
            var wait = nextRun - nowUtc;
            _logger.LogInformation(
                "Next report at {NextRun:o} (in {Hours:F2}h)",
                nextRun, wait.TotalHours);

            try
            {
                await Task.Delay(wait, stoppingToken);
            }
            catch (TaskCanceledException)
            {
                return;
            }

            await RunReportCycleAsync(stoppingToken);
            await DrainQueueAsync(stoppingToken);
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
    }

    private async Task DrainQueueAsync(CancellationToken ct)
    {
        IReadOnlyList<PendingReport> batch;
        try
        {
            batch = await _queue.DequeueBatchAsync(DrainBatchSize, MaxAttempts, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Queue dequeue failed — skipping drain this cycle");
            return;
        }
        if (batch.Count == 0) return;

        _logger.LogInformation("Draining {Count} pending reports", batch.Count);
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
