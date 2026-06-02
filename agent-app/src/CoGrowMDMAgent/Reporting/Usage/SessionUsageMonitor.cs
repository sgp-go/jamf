using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting.Usage;

/// <summary>
/// 與上報 <c>Worker</c> 並行的獨立 hosted service：每分鐘探測 active console
/// session 是否在用，餵給 <see cref="UsageAccumulator"/> 累加，並把快照持久化到
/// <see cref="IUsageStore"/>。<c>Worker</c> 的上報週期再從 store 讀出近幾天統計
/// POST 給後端（升級可跨重啟存活，與鎖定信箱同理 [[windows-lock-design]]）。
///
/// <para>非 Windows 平台 no-op（與 <see cref="DeviceFactsCollector"/> 一致，
/// 讓開發機可載入但不採集）。</para>
/// </summary>
public sealed class SessionUsageMonitor : BackgroundService
{
    /// <summary>輪詢間隔。分鐘級足夠「使用時長」語義，且對 CPU 近乎零負擔。</summary>
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(60);

    /// <summary>seed / 保留天數。跨重啟續算窗口；超出的舊資料上報後不再需要。</summary>
    private const int RetainDays = 7;

    private readonly UsageAccumulator _accumulator = new();
    private readonly IUsageStore _store;
    private readonly ILogger<SessionUsageMonitor> _logger;
    private readonly Func<bool> _probe;
    private readonly Func<DateTime> _now;

    public SessionUsageMonitor(IUsageStore store, ILogger<SessionUsageMonitor> logger)
        : this(store, logger, SessionProbe.IsUserActive, () => DateTime.Now)
    {
    }

    /// <summary>測試用：注入假的在用探測與時鐘。</summary>
    internal SessionUsageMonitor(
        IUsageStore store,
        ILogger<SessionUsageMonitor> logger,
        Func<bool> probe,
        Func<DateTime> now)
    {
        _store = store;
        _logger = logger;
        _probe = probe;
        _now = now;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation(
                "Usage monitoring is Windows-only — skipping on this platform");
            return;
        }

        // 恢復近 RetainDays 天累計（service 重啟續算當天，不歸零）。
        var since = _now().Date.AddDays(-(RetainDays - 1)).ToString("yyyy-MM-dd");
        try
        {
            _accumulator.Seed(await _store.LoadSinceAsync(since, stoppingToken));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Failed to seed usage accumulator from store");
        }
        _accumulator.SetInitialState(_probe());
        _logger.LogInformation(
            "SessionUsageMonitor started; initial active = {Active}",
            _accumulator.IsActive);

        using var timer = new PeriodicTimer(TickInterval);
        try
        {
            do
            {
                await TickAsync(stoppingToken);
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException)
        {
            // service 停止：正常退出（snapshot 已在上一 tick 持久化）。
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        try
        {
            _accumulator.Observe(_probe(), _now());
            await _store.UpsertAsync(_accumulator.Snapshot(), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // 單次 tick 失敗不應殺掉監控；下一分鐘重試（記憶體累計不丟）。
            _logger.LogWarning(ex, "Usage tick failed — will retry next interval");
        }
    }
}
