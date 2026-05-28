using CoGrowMDMAgent.Queue;
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
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }

    [Fact]
    public async Task InitializeAsync_IsIdempotent()
    {
        // 重新跑 Initialize 不應失敗（CREATE TABLE IF NOT EXISTS）
        await _queue.InitializeAsync(CancellationToken.None);
        await _queue.InitializeAsync(CancellationToken.None);
        Assert.Equal(0, await _queue.CountPendingAsync(10, CancellationToken.None));
    }

    [Fact]
    public async Task EnqueueAsync_PersistsAndCountIncrements()
    {
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{\"a\":1}", CancellationToken.None);
        await _queue.EnqueueAsync(ReportType.UsageReport, "{\"b\":2}", CancellationToken.None);
        Assert.Equal(2, await _queue.CountPendingAsync(10, CancellationToken.None));
    }

    [Fact]
    public async Task DequeueBatchAsync_ReturnsOldestFirst_AndRespectsBatchSize()
    {
        for (int i = 0; i < 5; i++)
        {
            await _queue.EnqueueAsync(
                ReportType.DeviceReport,
                $"{{\"i\":{i}}}",
                CancellationToken.None);
            await Task.Delay(2); // 確保 created_at 不同 ms（SQLite TEXT 比較）
        }
        var batch = await _queue.DequeueBatchAsync(3, 10, CancellationToken.None);
        Assert.Equal(3, batch.Count);
        Assert.Equal("{\"i\":0}", batch[0].Payload);
        Assert.Equal("{\"i\":2}", batch[2].Payload);
    }

    [Fact]
    public async Task MarkSuccessAsync_DeletesRow()
    {
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{}", CancellationToken.None);
        var batch = await _queue.DequeueBatchAsync(10, 10, CancellationToken.None);
        Assert.Single(batch);

        await _queue.MarkSuccessAsync(batch[0].Id, CancellationToken.None);
        Assert.Equal(0, await _queue.CountPendingAsync(10, CancellationToken.None));
    }

    [Fact]
    public async Task IncrementAttemptAsync_BumpsCountAndStoresError()
    {
        await _queue.EnqueueAsync(ReportType.DeviceReport, "{}", CancellationToken.None);
        var first = (await _queue.DequeueBatchAsync(10, 10, CancellationToken.None))[0];
        Assert.Equal(0, first.AttemptCount);
        Assert.Null(first.LastError);

        await _queue.IncrementAttemptAsync(first.Id, "503 server error", CancellationToken.None);
        var second = (await _queue.DequeueBatchAsync(10, 10, CancellationToken.None))[0];
        Assert.Equal(1, second.AttemptCount);
        Assert.Equal("503 server error", second.LastError);
    }

    [Fact]
    public async Task DequeueBatchAsync_FiltersDeadLetters()
    {
        // attempt < maxAttempts 才取；達到 maxAttempts 變死信
        await _queue.EnqueueAsync(ReportType.DeviceReport, "live", CancellationToken.None);
        await _queue.EnqueueAsync(ReportType.DeviceReport, "dead", CancellationToken.None);
        var rows = await _queue.DequeueBatchAsync(10, 10, CancellationToken.None);
        var deadRow = rows.First(r => r.Payload == "dead");

        // 把 "dead" row 推到 attempt_count = 3
        for (int i = 0; i < 3; i++)
        {
            await _queue.IncrementAttemptAsync(deadRow.Id, "err", CancellationToken.None);
        }

        // maxAttempts=3 → dead 被過濾，只剩 live
        var alive = await _queue.DequeueBatchAsync(10, 3, CancellationToken.None);
        Assert.Single(alive);
        Assert.Equal("live", alive[0].Payload);

        // CountPending(maxAttempts=3) 不算死信
        Assert.Equal(1, await _queue.CountPendingAsync(3, CancellationToken.None));
        // CountPending(maxAttempts=100) 算（仍在 DB 裡）
        Assert.Equal(2, await _queue.CountPendingAsync(100, CancellationToken.None));
    }

    [Fact]
    public async Task PayloadRoundTrip_PreservesUnicodeAndLargeContent()
    {
        var bigJson = "{\"text\":\"" + new string('字', 500) + "\",\"emoji\":\"🚀\"}";
        await _queue.EnqueueAsync(ReportType.UsageReport, bigJson, CancellationToken.None);
        var rows = await _queue.DequeueBatchAsync(1, 10, CancellationToken.None);
        Assert.Equal(bigJson, rows[0].Payload);
        Assert.Equal(ReportType.UsageReport, rows[0].ReportType);
    }
}
