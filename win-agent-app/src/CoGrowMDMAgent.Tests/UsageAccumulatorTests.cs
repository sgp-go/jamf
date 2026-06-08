using CoGrowMDMAgent.Reporting.Usage;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// <see cref="UsageAccumulator"/> 純狀態機單元測試。時間全部由測試傳入（狀態機
/// 不讀時鐘），逐分鐘 Observe 模擬 <see cref="SessionUsageMonitor"/> 的輪詢。
/// </summary>
public class UsageAccumulatorTests
{
    // 基準：2026-06-01 09:00（本地語義即可，狀態機只看傳入值）。
    private static readonly DateTime Base = new(2026, 6, 1, 9, 0, 0);

    [Fact]
    public void Inactive_observations_accumulate_nothing()
    {
        var acc = new UsageAccumulator();

        for (var i = 0; i < 5; i++)
            acc.Observe(active: false, Base.AddMinutes(i));

        Assert.Empty(acc.Snapshot());
        Assert.False(acc.IsActive);
    }

    [Fact]
    public void Active_minutes_accumulate_total_and_hour_buckets()
    {
        var acc = new UsageAccumulator();

        // 09:00..09:04 共 5 分鐘在用，全落在 hour "9"
        for (var i = 0; i < 5; i++)
            acc.Observe(active: true, Base.AddMinutes(i));

        var day = Assert.Single(acc.Snapshot());
        Assert.Equal("2026-06-01", day.Date);
        Assert.Equal(5, day.TotalMinutes);
        Assert.Equal(5, day.TimeStats["9"]);
        Assert.True(acc.IsActive);
    }

    [Fact]
    public void Pickup_counts_rising_edges_not_every_active_minute()
    {
        var acc = new UsageAccumulator();

        // 在用 2 分鐘 → 中斷 → 再在用 2 分鐘：兩段 = 2 次拿起
        acc.Observe(true, Base.AddMinutes(0));
        acc.Observe(true, Base.AddMinutes(1));
        acc.Observe(false, Base.AddMinutes(2));
        acc.Observe(true, Base.AddMinutes(3));
        acc.Observe(true, Base.AddMinutes(4));

        var day = Assert.Single(acc.Snapshot());
        Assert.Equal(2, day.Pickup);
        Assert.Equal(4, day.TotalMinutes); // 中斷的那分鐘不計
    }

    [Fact]
    public void SetInitialState_active_does_not_count_a_pickup_on_resume()
    {
        var acc = new UsageAccumulator();
        acc.SetInitialState(active: true); // service 重啟時使用者已在用

        acc.Observe(true, Base.AddMinutes(0));
        acc.Observe(true, Base.AddMinutes(1));

        var day = Assert.Single(acc.Snapshot());
        Assert.Equal(0, day.Pickup); // 續上既有狀態，不誤判重啟為拿起
        Assert.Equal(2, day.TotalMinutes);
    }

    [Fact]
    public void MaxContinuous_tracks_longest_run_and_resets_across_gaps()
    {
        var acc = new UsageAccumulator();

        // 第一段 3 分鐘
        for (var i = 0; i < 3; i++) acc.Observe(true, Base.AddMinutes(i));
        // 中斷
        acc.Observe(false, Base.AddMinutes(3));
        // 第二段 5 分鐘（更長）
        for (var i = 4; i < 9; i++) acc.Observe(true, Base.AddMinutes(i));
        // 中斷
        acc.Observe(false, Base.AddMinutes(9));
        // 第三段 2 分鐘（較短，不應降低 max）
        for (var i = 10; i < 12; i++) acc.Observe(true, Base.AddMinutes(i));

        var day = Assert.Single(acc.Snapshot());
        Assert.Equal(5, day.MaxContinuous);
        Assert.Equal(10, day.TotalMinutes); // 3 + 5 + 2
        Assert.Equal(3, day.Pickup);
    }

    [Fact]
    public void Seed_restores_prior_totals_and_continues()
    {
        var acc = new UsageAccumulator();
        acc.Seed(new[]
        {
            new DailyUsage
            {
                Date = "2026-06-01",
                TotalMinutes = 100,
                Pickup = 7,
                MaxContinuous = 40,
                TimeStats = new Dictionary<string, int> { ["8"] = 60, ["9"] = 40 },
            },
        });
        acc.SetInitialState(active: false);

        // 再在用 3 分鐘（09:00..09:02）
        for (var i = 0; i < 3; i++) acc.Observe(true, Base.AddMinutes(i));

        var day = Assert.Single(acc.Snapshot());
        Assert.Equal(103, day.TotalMinutes);   // 100 + 3
        Assert.Equal(8, day.Pickup);           // 7 + 1（一次新上升沿）
        Assert.Equal(43, day.TimeStats["9"]);  // 40 + 3
        Assert.Equal(60, day.TimeStats["8"]);  // 不受影響
    }

    [Fact]
    public void Observations_on_different_days_land_in_separate_buckets()
    {
        var acc = new UsageAccumulator();

        acc.Observe(true, new DateTime(2026, 6, 1, 23, 59, 0));
        acc.Observe(true, new DateTime(2026, 6, 2, 0, 0, 0));

        var snapshot = acc.Snapshot();
        Assert.Equal(2, snapshot.Count);
        Assert.Contains(snapshot, d => d.Date == "2026-06-01" && d.TotalMinutes == 1);
        Assert.Contains(snapshot, d => d.Date == "2026-06-02" && d.TotalMinutes == 1);
    }
}
