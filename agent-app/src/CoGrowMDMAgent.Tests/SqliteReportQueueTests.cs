using CoGrowMDMAgent.Queue;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// Uses a per-test temp DB file (not <c>:memory:</c>) so we exercise the same
/// open/close pattern the production code uses (each call opens its own
/// connection); <c>:memory:</c> with separate connections would give each
/// call a *different* empty DB and silently mask schema bugs.
/// </summary>
public sealed class SqliteReportQueueTests : IDisposable
{
    private readonly string _dbPath;
    private readonly SqliteReportQueue _queue;

    // 取盡所有保留窗口內的行：now 取遠未來（讓退避一律到期），cutoff 取遠過去。
    private static readonly DateTime FarFuture = new(2999, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime FarPast = new(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    public SqliteReportQueueTests()
    {
        _dbPath = Path.Combine(
            Path.GetTempPath(),
            $"queue-test-{Guid.NewGuid():N}.db");
        _queue = new SqliteReportQueue(_dbPath, NullLogger<SqliteReportQueue>.Instance);
        _queue.InitializeAsync(CancellationToken.None).GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        // SqliteConnection 用 connection pool；先 ClearAllPools 釋放底層 file handle
        SqliteConnection.ClearAllPools();
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }

    private Task<IReadOnlyList<PendingReport>> DequeueAllAsync(int batchSize = 100) =>
        _queue.DequeueDueAsync(batchSize, FarFuture, FarPast, CancellationToken.None);

    [Fact]
    public async Task InitializeAsync_IsIdempotent()
    {
        // 重新跑 Initialize 不應失敗（CREATE TABLE IF NOT EXISTS + 冪等 migration）
        await _queue.InitializeAsync(CancellationToken.None);
        await _queue.InitializeAsync(CancellationToken.None);
        Assert.Equal(0, await _queue.CountPendingAsync(FarPast, CancellationToken.None));
    }

    [Fact]
    public async Task EnqueueAsync_PersistsAndCountIncrements()
    {
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{\"a\":1}", CancellationToken.None);
        await _queue.EnqueueAsync(ReportType.UsageReport, "{\"b\":2}", CancellationToken.None);
        Assert.Equal(2, await _queue.CountPendingAsync(FarPast, CancellationToken.None));
    }

    [Fact]
    public async Task DequeueDueAsync_ReturnsOldestFirst_AndRespectsBatchSize()
    {
        for (int i = 0; i < 5; i++)
        {
            await _queue.EnqueueAsync(
                ReportType.DeviceReport,
                $"{{\"i\":{i}}}",
                CancellationToken.None);
            await Task.Delay(2); // 確保 created_at 不同 ms（SQLite TEXT 比較）
        }
        var batch = await _queue.DequeueDueAsync(3, FarFuture, FarPast, CancellationToken.None);
        Assert.Equal(3, batch.Count);
        Assert.Equal("{\"i\":0}", batch[0].Payload);
        Assert.Equal("{\"i\":2}", batch[2].Payload);
    }

    [Fact]
    public async Task DequeueDueAsync_SkipsRowsBeforeBackoffElapses()
    {
        // 剛入隊的行 next_retry_at = now + 15min；用「現在」當 now 取不到（未到期）。
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{}", CancellationToken.None);

        var notYetDue = await _queue.DequeueDueAsync(
            10, DateTime.UtcNow, FarPast, CancellationToken.None);
        Assert.Empty(notYetDue);

        // 退避過後（now 跨過 15min）即可取得。
        var due = await _queue.DequeueDueAsync(
            10, DateTime.UtcNow.AddMinutes(20), FarPast, CancellationToken.None);
        Assert.Single(due);
    }

    [Fact]
    public async Task DequeueDueAsync_FiltersDeadLettersOutsideRetention()
    {
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{}", CancellationToken.None);

        // cutoff 設在未來 → 所有現存行的 created_at 都早於 cutoff → 視為 dead-letter。
        var afterRetention = await _queue.DequeueDueAsync(
            10, FarFuture, FarFuture, CancellationToken.None);
        Assert.Empty(afterRetention);

        // CountPending 同樣以保留窗口計：cutoff 在未來 → 0；cutoff 在過去 → 1。
        Assert.Equal(0, await _queue.CountPendingAsync(FarFuture, CancellationToken.None));
        Assert.Equal(1, await _queue.CountPendingAsync(FarPast, CancellationToken.None));
    }

    [Fact]
    public async Task MarkSuccessAsync_DeletesRow()
    {
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{}", CancellationToken.None);
        var batch = await DequeueAllAsync();
        Assert.Single(batch);

        await _queue.MarkSuccessAsync(batch[0].Id, CancellationToken.None);
        Assert.Equal(0, await _queue.CountPendingAsync(FarPast, CancellationToken.None));
    }

    [Fact]
    public async Task IncrementAttemptAsync_BumpsCountStoresError_AndPushesRetryOut()
    {
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{}", CancellationToken.None);
        var first = (await DequeueAllAsync())[0];
        Assert.Equal(0, first.AttemptCount);
        Assert.Null(first.LastError);

        await _queue.IncrementAttemptAsync(first.Id, "503 server error", CancellationToken.None);
        var second = (await DequeueAllAsync())[0];
        Assert.Equal(1, second.AttemptCount);
        Assert.Equal("503 server error", second.LastError);

        // attempt=1 的退避（30min）應晚於剛入隊的 attempt=0（15min）：用兩個 now 邊界驗證。
        // 入隊後 ~16min 仍可取（attempt0），但 increment 到 attempt1 後同一 now 不可取。
        var notDueAfterBump = await _queue.DequeueDueAsync(
            10, DateTime.UtcNow.AddMinutes(20), FarPast, CancellationToken.None);
        Assert.Empty(notDueAfterBump); // next_retry 已推到 ~30min 後
    }

    [Fact]
    public async Task GetEarliestNextRetryAsync_ReturnsMin_OrNullWhenEmpty()
    {
        Assert.Null(await _queue.GetEarliestNextRetryAsync(FarPast, CancellationToken.None));

        var before = DateTime.UtcNow;
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{}", CancellationToken.None);
        var earliest = await _queue.GetEarliestNextRetryAsync(FarPast, CancellationToken.None);

        Assert.NotNull(earliest);
        // 首行 next_retry ≈ now + 15min；落在合理區間內。
        Assert.InRange(
            earliest!.Value,
            before.AddMinutes(14),
            DateTime.UtcNow.AddMinutes(16));

        // cutoff 在未來時，行被排除 → 回 null。
        Assert.Null(await _queue.GetEarliestNextRetryAsync(FarFuture, CancellationToken.None));
    }

    [Fact]
    public async Task Migration_OldDbWithoutNextRetryColumn_BackfillsAndStaysDrainable()
    {
        // 模擬早於 next_retry_at 欄位的舊 DB：用裸連線建舊 schema + 插一行，
        // 再跑 InitializeAsync（補列 + 回填 created_at），驗證仍可被 drain。
        var oldDbPath = Path.Combine(
            Path.GetTempPath(), $"queue-old-{Guid.NewGuid():N}.db");
        try
        {
            var cs = new SqliteConnectionStringBuilder { DataSource = oldDbPath }.ToString();
            await using (var conn = new SqliteConnection(cs))
            {
                await conn.OpenAsync();
                await using var cmd = conn.CreateCommand();
                cmd.CommandText = @"
                    CREATE TABLE pending_reports (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        report_type TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        attempt_count INTEGER NOT NULL DEFAULT 0,
                        last_error TEXT
                    );
                    INSERT INTO pending_reports (report_type, payload, created_at, attempt_count)
                    VALUES ('device_report', '{""legacy"":true}', '2026-05-01T00:00:00.000Z', 2);
                ";
                await cmd.ExecuteNonQueryAsync();
            }

            var migrated = new SqliteReportQueue(oldDbPath, NullLogger<SqliteReportQueue>.Instance);
            await migrated.InitializeAsync(CancellationToken.None);

            // 回填後 next_retry_at = created_at（2026-05-01）→ 用任意較晚的 now 即可取得。
            var rows = await migrated.DequeueDueAsync(
                10, FarFuture, FarPast, CancellationToken.None);
            Assert.Single(rows);
            Assert.Equal("{\"legacy\":true}", rows[0].Payload);
            Assert.Equal(2, rows[0].AttemptCount);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            if (File.Exists(oldDbPath)) File.Delete(oldDbPath);
        }
    }

    [Fact]
    public async Task PayloadRoundTrip_PreservesUnicodeAndLargeContent()
    {
        var bigJson = "{\"text\":\"" + new string('字', 500) + "\",\"emoji\":\"🚀\"}";
        await _queue.EnqueueAsync(ReportType.UsageReport, bigJson, CancellationToken.None);
        var rows = await DequeueAllAsync(1);
        Assert.Equal(bigJson, rows[0].Payload);
        Assert.Equal(ReportType.UsageReport, rows[0].ReportType);
    }
}
