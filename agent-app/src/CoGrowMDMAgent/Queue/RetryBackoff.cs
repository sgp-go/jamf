namespace CoGrowMDMAgent.Queue;

/// <summary>
/// 失敗上報的指數退避策略（純函數，便於單測）。
///
/// <para>每日上報場景下，一次網路抖動不應讓資料延遲整天：失敗後先以 15 分鐘
/// 起步快速重試，反覆失敗則指數拉長間隔，封頂 6 小時，避免離線設備持續猛敲
/// 服務端。退避序列：</para>
/// <list type="table">
/// <item><term>attempt 0</term><description>15 min（剛入隊，首次重試）</description></item>
/// <item><term>attempt 1</term><description>30 min</description></item>
/// <item><term>attempt 2</term><description>1 h</description></item>
/// <item><term>attempt 3</term><description>2 h</description></item>
/// <item><term>attempt 4</term><description>4 h</description></item>
/// <item><term>attempt ≥ 5</term><description>6 h（封頂）</description></item>
/// </list>
///
/// <para>不加隨機 jitter：各設備的 <c>created_at</c> 本就分散在不同時刻，每日
/// 上報又有 per-device 錯峰 offset（<see cref="Scheduling.JitterScheduler"/>），
/// 失敗時刻天然分散，無需額外抖動即可避免 thundering herd。</para>
/// </summary>
public static class RetryBackoff
{
    /// <summary>首次重試間隔（attempt 0）。</summary>
    public static readonly TimeSpan Base = TimeSpan.FromMinutes(15);

    /// <summary>退避封頂，避免間隔無限增長。</summary>
    public static readonly TimeSpan Max = TimeSpan.FromHours(6);

    /// <summary>attempt ≥ 此值即封頂為 <see cref="Max"/>（15min × 2^5 = 8h &gt; 6h）。</summary>
    private const int CapAttempt = 5;

    /// <summary>
    /// 給定已重試次數，回傳下次重試應等待的間隔。負值按 0 處理。
    /// </summary>
    public static TimeSpan Compute(int attemptCount)
    {
        if (attemptCount >= CapAttempt) return Max;
        if (attemptCount < 0) attemptCount = 0;

        var minutes = Base.TotalMinutes * Math.Pow(2, attemptCount);
        var delay = TimeSpan.FromMinutes(minutes);
        return delay < Max ? delay : Max;
    }
}
