using CoGrowMDMAgent.Reporting;
using CoGrowMDMAgent.Scheduling;

namespace CoGrowMDMAgent;

/// <summary>
/// Main service loop. Sleeps until the jittered slot, then runs one report
/// cycle. Failures are logged; an explicit local retry queue is W3 scope —
/// for Day 1 we rely on next-day retry (idempotent on server: same serial /
/// same date upserts).
/// </summary>
public class Worker : BackgroundService
{
    private readonly ILogger<Worker> _logger;
    private readonly JitterScheduler _scheduler;
    private readonly DeviceReporter _deviceReporter;

    public Worker(
        ILogger<Worker> logger,
        JitterScheduler scheduler,
        DeviceReporter deviceReporter)
    {
        _logger = logger;
        _scheduler = scheduler;
        _deviceReporter = deviceReporter;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "CoGrowMDMAgent started; jitter offset = {Minutes} minutes",
            _scheduler.OffsetMinute);

        while (!stoppingToken.IsCancellationRequested)
        {
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
            _logger.LogError(ex, "Report cycle failed — will retry tomorrow");
        }
    }
}
