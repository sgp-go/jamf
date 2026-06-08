namespace CoGrowMDMAgent.Reporting.Usage;

/// <summary>
/// 每日使用統計的本地持久化。讓 <see cref="SessionUsageMonitor"/> 的累計
/// 跨 service 重啟存活，並供 <c>Worker</c> 上報週期讀取近幾天統計。
/// </summary>
public interface IUsageStore
{
    /// <summary>建表（idempotent）。</summary>
    Task InitializeAsync(CancellationToken ct);

    /// <summary>以日期為主鍵 upsert 一批每日統計（覆蓋既有值）。</summary>
    Task UpsertAsync(IReadOnlyList<DailyUsage> days, CancellationToken ct);

    /// <summary>
    /// 讀取 <paramref name="sinceDateInclusive"/>（yyyy-MM-dd）起的所有每日統計。
    /// </summary>
    Task<IReadOnlyList<DailyUsage>> LoadSinceAsync(string sinceDateInclusive, CancellationToken ct);
}
