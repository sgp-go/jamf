using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting.Usage;

/// <summary>
/// SQLite-backed <see cref="IUsageStore"/>. One row per local day. Mirrors the
/// connection pattern of <c>SqliteReportQueue</c> (open + dispose per call;
/// Microsoft.Data.Sqlite pools internally).
///
/// <para>DB file: <c>{CommonApplicationData}/CoGrow/MDM Agent/usage.db</c>
/// (i.e. <c>C:\ProgramData\CoGrow\MDM Agent\usage.db</c> as the installed
/// service). Kept separate from <c>queue.db</c> so retry-queue and usage
/// concerns don't share a schema.</para>
/// </summary>
public sealed class SqliteUsageStore : IUsageStore
{
    private readonly string _connectionString;
    private readonly ILogger<SqliteUsageStore> _logger;

    public SqliteUsageStore(string dbPath, ILogger<SqliteUsageStore> logger)
    {
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
        }.ToString();
        _logger = logger;
    }

    public async Task InitializeAsync(CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            CREATE TABLE IF NOT EXISTS usage_daily (
                date TEXT PRIMARY KEY,
                total_minutes INTEGER NOT NULL DEFAULT 0,
                pickup INTEGER NOT NULL DEFAULT 0,
                max_continuous INTEGER NOT NULL DEFAULT 0,
                time_stats TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            );
        ";
        await cmd.ExecuteNonQueryAsync(ct);
        _logger.LogInformation(
            "SqliteUsageStore initialised at {DataSource}",
            new SqliteConnectionStringBuilder(_connectionString).DataSource);
    }

    public async Task UpsertAsync(IReadOnlyList<DailyUsage> days, CancellationToken ct)
    {
        if (days.Count == 0) return;

        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        foreach (var d in days)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = @"
                INSERT INTO usage_daily
                    (date, total_minutes, pickup, max_continuous, time_stats, updated_at)
                VALUES (@date, @total, @pickup, @max, @stats, @updated)
                ON CONFLICT(date) DO UPDATE SET
                    total_minutes = excluded.total_minutes,
                    pickup        = excluded.pickup,
                    max_continuous= excluded.max_continuous,
                    time_stats    = excluded.time_stats,
                    updated_at    = excluded.updated_at;
            ";
            cmd.Parameters.AddWithValue("@date", d.Date);
            cmd.Parameters.AddWithValue("@total", d.TotalMinutes);
            cmd.Parameters.AddWithValue("@pickup", d.Pickup);
            cmd.Parameters.AddWithValue("@max", d.MaxContinuous);
            cmd.Parameters.AddWithValue("@stats", JsonSerializer.Serialize(d.TimeStats));
            cmd.Parameters.AddWithValue("@updated", DateTime.UtcNow.ToString("o"));
            await cmd.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
    }

    public async Task<IReadOnlyList<DailyUsage>> LoadSinceAsync(
        string sinceDateInclusive, CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT date, total_minutes, pickup, max_continuous, time_stats
            FROM usage_daily
            WHERE date >= @since
            ORDER BY date ASC;
        ";
        cmd.Parameters.AddWithValue("@since", sinceDateInclusive);

        var rows = new List<DailyUsage>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var statsJson = reader.GetString(4);
            var stats = JsonSerializer.Deserialize<Dictionary<string, int>>(statsJson)
                        ?? new Dictionary<string, int>();
            rows.Add(new DailyUsage
            {
                Date = reader.GetString(0),
                TotalMinutes = reader.GetInt32(1),
                Pickup = reader.GetInt32(2),
                MaxContinuous = reader.GetInt32(3),
                TimeStats = stats,
            });
        }
        return rows;
    }
}
