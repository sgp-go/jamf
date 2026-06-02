using CoGrowMDMAgent.Reporting.Usage;
using Microsoft.Extensions.Logging.Abstractions;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// 用 per-test 臨時 DB 檔（非 <c>:memory:</c>），與 production 同樣的 open/close
/// 模式，避免 in-memory 各連線拿到不同空庫而掩蓋 schema bug（同
/// <c>SqliteReportQueueTests</c> 理由）。
/// </summary>
public sealed class SqliteUsageStoreTests : IDisposable
{
    private readonly string _dbPath;
    private readonly SqliteUsageStore _store;

    public SqliteUsageStoreTests()
    {
        _dbPath = Path.Combine(
            Path.GetTempPath(),
            $"usage-test-{Guid.NewGuid():N}.db");
        _store = new SqliteUsageStore(_dbPath, NullLogger<SqliteUsageStore>.Instance);
        _store.InitializeAsync(CancellationToken.None).GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }

    [Fact]
    public async Task InitializeAsync_IsIdempotent()
    {
        await _store.InitializeAsync(CancellationToken.None);
        await _store.InitializeAsync(CancellationToken.None);
        var rows = await _store.LoadSinceAsync("2000-01-01", CancellationToken.None);
        Assert.Empty(rows);
    }

    [Fact]
    public async Task Upsert_then_load_roundtrips_including_time_stats()
    {
        var day = new DailyUsage
        {
            Date = "2026-06-01",
            TotalMinutes = 123,
            Pickup = 9,
            MaxContinuous = 45,
            TimeStats = new Dictionary<string, int> { ["8"] = 50, ["9"] = 73 },
        };

        await _store.UpsertAsync(new[] { day }, CancellationToken.None);
        var loaded = await _store.LoadSinceAsync("2026-06-01", CancellationToken.None);

        var got = Assert.Single(loaded);
        Assert.Equal("2026-06-01", got.Date);
        Assert.Equal(123, got.TotalMinutes);
        Assert.Equal(9, got.Pickup);
        Assert.Equal(45, got.MaxContinuous);
        Assert.Equal(50, got.TimeStats["8"]);
        Assert.Equal(73, got.TimeStats["9"]);
    }

    [Fact]
    public async Task Upsert_same_date_overwrites_existing_row()
    {
        await _store.UpsertAsync(new[]
        {
            new DailyUsage { Date = "2026-06-01", TotalMinutes = 10, Pickup = 1, MaxContinuous = 10, TimeStats = new Dictionary<string, int>() },
        }, CancellationToken.None);

        // 同日再 upsert（模擬累計增長後的下一次 flush）
        await _store.UpsertAsync(new[]
        {
            new DailyUsage { Date = "2026-06-01", TotalMinutes = 200, Pickup = 12, MaxContinuous = 60, TimeStats = new Dictionary<string, int> { ["14"] = 30 } },
        }, CancellationToken.None);

        var got = Assert.Single(await _store.LoadSinceAsync("2026-06-01", CancellationToken.None));
        Assert.Equal(200, got.TotalMinutes); // 覆蓋而非累加（記憶體累加器才是真相源）
        Assert.Equal(12, got.Pickup);
        Assert.Equal(30, got.TimeStats["14"]);
    }

    [Fact]
    public async Task LoadSince_filters_out_older_days()
    {
        await _store.UpsertAsync(new[]
        {
            new DailyUsage { Date = "2026-05-20", TotalMinutes = 1, Pickup = 0, MaxContinuous = 1, TimeStats = new Dictionary<string, int>() },
            new DailyUsage { Date = "2026-06-01", TotalMinutes = 2, Pickup = 0, MaxContinuous = 2, TimeStats = new Dictionary<string, int>() },
            new DailyUsage { Date = "2026-06-02", TotalMinutes = 3, Pickup = 0, MaxContinuous = 3, TimeStats = new Dictionary<string, int>() },
        }, CancellationToken.None);

        var recent = await _store.LoadSinceAsync("2026-06-01", CancellationToken.None);

        Assert.Equal(2, recent.Count);
        Assert.DoesNotContain(recent, d => d.Date == "2026-05-20");
        // 升序返回
        Assert.Equal("2026-06-01", recent[0].Date);
        Assert.Equal("2026-06-02", recent[1].Date);
    }

    [Fact]
    public async Task Upsert_empty_list_is_noop()
    {
        await _store.UpsertAsync(Array.Empty<DailyUsage>(), CancellationToken.None);
        Assert.Empty(await _store.LoadSinceAsync("2000-01-01", CancellationToken.None));
    }
}
