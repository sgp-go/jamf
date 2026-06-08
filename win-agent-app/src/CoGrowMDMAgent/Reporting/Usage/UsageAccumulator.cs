using System.Globalization;

namespace CoGrowMDMAgent.Reporting.Usage;

/// <summary>
/// 把「螢幕在用」的觀測流累加成每日使用統計。純狀態機：無平台依賴、無 IO、
/// <b>不讀時鐘</b>（所有時間由呼叫方傳入），因此可完整單元測試。
///
/// <para>呼叫方（<see cref="SessionUsageMonitor"/>）每分鐘探測一次 active console
/// session 是否在用，呼叫 <see cref="Observe"/>。在用＝該分鐘累加；由非在用→在用
/// 的上升沿記一次 pickup。</para>
///
/// <para>內部以可變的逐日累加器持有狀態（封裝在類內，外部只透過 <see cref="Snapshot"/>
/// 取不可變快照）；累加器本質就是可變狀態機，這是刻意的取捨。</para>
/// </summary>
public sealed class UsageAccumulator
{
    private readonly Dictionary<string, MutableDaily> _days = new();
    private bool _active;
    private int _currentContinuous; // 當前連續在用分鐘數（跨在用段重置）

    /// <summary>當前是否處於在用狀態（測試/監控可查）。</summary>
    public bool IsActive => _active;

    /// <summary>
    /// 從持久化恢復既有累計（service 重啟後續算當天，不歸零）。
    /// </summary>
    public void Seed(IEnumerable<DailyUsage> persisted)
    {
        foreach (var d in persisted)
        {
            var day = new MutableDaily(d.Date)
            {
                TotalMinutes = d.TotalMinutes,
                Pickup = d.Pickup,
                MaxContinuous = d.MaxContinuous,
            };
            foreach (var kv in d.TimeStats) day.TimeStats[kv.Key] = kv.Value;
            _days[d.Date] = day;
        }
    }

    /// <summary>
    /// 設定初始在用狀態（不累加、不計 pickup）。用於 service 啟動時：若重啟前
    /// 使用者已在用，續上既有狀態而非把重啟誤判成一次「拿起」。
    /// </summary>
    public void SetInitialState(bool active) => _active = active;

    /// <summary>
    /// 一次分鐘級觀測。<paramref name="active"/>＝該分鐘是否在用，
    /// <paramref name="now"/>＝觀測當下的本地時間（決定歸屬日期與小時）。
    /// </summary>
    public void Observe(bool active, DateTime now)
    {
        if (!active)
        {
            _active = false;
            _currentContinuous = 0;
            return;
        }

        var day = Day(now);
        if (!_active)
        {
            // 非在用 → 在用的上升沿＝一次「拿起」
            day.Pickup++;
            _currentContinuous = 0;
        }
        _active = true;

        day.TotalMinutes++;
        var hour = now.Hour.ToString(CultureInfo.InvariantCulture);
        day.TimeStats[hour] = day.TimeStats.GetValueOrDefault(hour) + 1;

        _currentContinuous++;
        if (_currentContinuous > day.MaxContinuous)
            day.MaxContinuous = _currentContinuous;
    }

    /// <summary>導出所有已累計日期的不可變快照（供上報 / 持久化）。</summary>
    public IReadOnlyList<DailyUsage> Snapshot() =>
        _days.Values
            .Select(d => new DailyUsage
            {
                Date = d.Date,
                TotalMinutes = d.TotalMinutes,
                Pickup = d.Pickup,
                MaxContinuous = d.MaxContinuous,
                TimeStats = new Dictionary<string, int>(d.TimeStats),
            })
            .ToList();

    private MutableDaily Day(DateTime now)
    {
        var key = now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (!_days.TryGetValue(key, out var day))
        {
            day = new MutableDaily(key);
            _days[key] = day;
        }
        return day;
    }

    /// <summary>內部可變逐日累加器。外部不可見。</summary>
    private sealed class MutableDaily(string date)
    {
        public string Date { get; } = date;
        public int TotalMinutes { get; set; }
        public int Pickup { get; set; }
        public int MaxContinuous { get; set; }
        public Dictionary<string, int> TimeStats { get; } = new();
    }
}
