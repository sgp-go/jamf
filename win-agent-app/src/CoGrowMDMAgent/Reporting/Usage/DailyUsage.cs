namespace CoGrowMDMAgent.Reporting.Usage;

/// <summary>
/// 單日使用統計的不可變快照。對齊伺服器 device_usage_stats 與 iOS 端
/// UsageStatItem 的語義（[[windows-lock-design]] 決策：螢幕在用時長口徑）：
/// <list type="bullet">
/// <item><c>TotalMinutes</c>：當日「在用」（已登入且未鎖屏）累計分鐘數。</item>
/// <item><c>Pickup</c>：當日「拿起」次數＝由非在用→在用的上升沿計數。</item>
/// <item><c>MaxContinuous</c>：當日單次最長連續在用分鐘數。</item>
/// <item><c>TimeStats</c>：每小時（"0".."23"）在用分鐘數。</item>
/// </list>
/// </summary>
public sealed record DailyUsage
{
    /// <summary>本地日期，格式 yyyy-MM-dd。</summary>
    public required string Date { get; init; }

    public required int TotalMinutes { get; init; }

    public required int Pickup { get; init; }

    public required int MaxContinuous { get; init; }

    /// <summary>每小時統計：key = 小時（"0".."23"），value = 該小時在用分鐘數。</summary>
    public required IReadOnlyDictionary<string, int> TimeStats { get; init; }
}
