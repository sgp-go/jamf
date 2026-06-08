using System.Globalization;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Queue;

/// <summary>
/// SQLite-backed <see cref="IReportQueue"/>. One row per failed report; rows
/// are deleted on successful retry (<see cref="MarkSuccessAsync"/>) and kept
/// indefinitely once they age past the retention window (dead-letter — never
/// retried, but auditable via the file).
///
/// <para>The DB file lives at <c>{CommonApplicationData}/CoGrow/MDM Agent/queue.db</c>
/// (i.e. <c>C:\ProgramData\CoGrow\MDM Agent\queue.db</c> when running as the
/// installed service). Each call opens + disposes a connection — Microsoft.Data.Sqlite
/// uses connection pooling internally, so this stays cheap.</para>
/// </summary>
public sealed class SqliteReportQueue : IReportQueue
{
    private readonly string _connectionString;
    private readonly ILogger<SqliteReportQueue> _logger;

    public SqliteReportQueue(string dbPath, ILogger<SqliteReportQueue> logger)
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

        // 新庫直接帶 next_retry_at；老庫走下方 migration 補列。
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                CREATE TABLE IF NOT EXISTS pending_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    report_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    next_retry_at TEXT
                );
            ";
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await MigrateNextRetryColumnAsync(conn, ct);

        // 查詢路徑：DequeueDue 過濾 next_retry_at <= now 且 created_at > cutoff，
        // GetEarliestNextRetry 取 MIN(next_retry_at)。複合索引覆蓋兩者。
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                CREATE INDEX IF NOT EXISTS idx_pending_reports_due
                    ON pending_reports(next_retry_at, created_at);
            ";
            await cmd.ExecuteNonQueryAsync(ct);
        }

        _logger.LogInformation(
            "SqliteReportQueue initialised at {DataSource}",
            new SqliteConnectionStringBuilder(_connectionString).DataSource);
    }

    /// <summary>
    /// 為早於 next_retry_at 欄位的舊 DB 補列，並把既有行的 next_retry_at 回填為
    /// created_at（視為立即到期），消除後續查詢的 NULL 分支。SQLite 無
    /// <c>ADD COLUMN IF NOT EXISTS</c>，故先用 PRAGMA 探測。
    /// </summary>
    private static async Task MigrateNextRetryColumnAsync(SqliteConnection conn, CancellationToken ct)
    {
        bool hasColumn = false;
        await using (var pragma = conn.CreateCommand())
        {
            pragma.CommandText = "PRAGMA table_info(pending_reports);";
            await using var reader = await pragma.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                // 欄位 1 是 name
                if (reader.GetString(1) == "next_retry_at")
                {
                    hasColumn = true;
                    break;
                }
            }
        }
        if (hasColumn) return;

        await using var alter = conn.CreateCommand();
        alter.CommandText = @"
            ALTER TABLE pending_reports ADD COLUMN next_retry_at TEXT;
            UPDATE pending_reports SET next_retry_at = created_at WHERE next_retry_at IS NULL;
        ";
        await alter.ExecuteNonQueryAsync(ct);
    }

    public async Task EnqueueAsync(string reportType, string payload, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        // 首次重試在 RetryBackoff.Base 之後：避免剛失敗就立即重試形成風暴，
        // 同時仍遠早於次日 daily slot。
        var nextRetry = now + RetryBackoff.Compute(0);

        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            INSERT INTO pending_reports
                (report_type, payload, created_at, attempt_count, next_retry_at)
            VALUES (@reportType, @payload, @createdAt, 0, @nextRetry);
        ";
        cmd.Parameters.AddWithValue("@reportType", reportType);
        cmd.Parameters.AddWithValue("@payload", payload);
        cmd.Parameters.AddWithValue("@createdAt", Iso(now));
        cmd.Parameters.AddWithValue("@nextRetry", Iso(nextRetry));
        await cmd.ExecuteNonQueryAsync(ct);
        _logger.LogInformation(
            "Enqueued failed report type={ReportType} (payload={PayloadSize} bytes, next retry in {Delay})",
            reportType, payload.Length, RetryBackoff.Compute(0));
    }

    public async Task<IReadOnlyList<PendingReport>> DequeueDueAsync(
        int batchSize,
        DateTime nowUtc,
        DateTime retentionCutoffUtc,
        CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT id, report_type, payload, created_at, attempt_count, last_error
            FROM pending_reports
            WHERE next_retry_at <= @now
              AND created_at > @cutoff
            ORDER BY created_at ASC
            LIMIT @batchSize;
        ";
        cmd.Parameters.AddWithValue("@now", Iso(nowUtc));
        cmd.Parameters.AddWithValue("@cutoff", Iso(retentionCutoffUtc));
        cmd.Parameters.AddWithValue("@batchSize", batchSize);

        var rows = new List<PendingReport>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            rows.Add(new PendingReport(
                Id: reader.GetInt64(0),
                ReportType: reader.GetString(1),
                Payload: reader.GetString(2),
                CreatedAtUtc: ParseIso(reader.GetString(3)),
                AttemptCount: reader.GetInt32(4),
                LastError: reader.IsDBNull(5) ? null : reader.GetString(5)));
        }
        return rows;
    }

    public async Task MarkSuccessAsync(long id, CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM pending_reports WHERE id = @id;";
        cmd.Parameters.AddWithValue("@id", id);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task IncrementAttemptAsync(long id, string lastError, CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);

        // 退避用「當前 attempt_count + 1」算；先讀當前值，再於 C# 端算好
        // next_retry_at 直接寫入（避免依賴 SQLite 時間函數的解析/格式邊界）。
        var attempt = await ReadAttemptCountAsync(conn, id, ct);
        var nextRetry = DateTime.UtcNow + RetryBackoff.Compute(attempt + 1);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            UPDATE pending_reports
            SET attempt_count = attempt_count + 1,
                last_error = @lastError,
                next_retry_at = @nextRetry
            WHERE id = @id;
        ";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@lastError", lastError);
        cmd.Parameters.AddWithValue("@nextRetry", Iso(nextRetry));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<int> ReadAttemptCountAsync(
        SqliteConnection conn, long id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT attempt_count FROM pending_reports WHERE id = @id;";
        cmd.Parameters.AddWithValue("@id", id);
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is null or DBNull ? 0 : Convert.ToInt32(result);
    }

    public async Task<DateTime?> GetEarliestNextRetryAsync(
        DateTime retentionCutoffUtc,
        CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT MIN(next_retry_at)
            FROM pending_reports
            WHERE created_at > @cutoff;
        ";
        cmd.Parameters.AddWithValue("@cutoff", Iso(retentionCutoffUtc));
        var result = await cmd.ExecuteScalarAsync(ct);
        if (result is null or DBNull) return null;
        return ParseIso((string)result);
    }

    public async Task<int> CountPendingAsync(DateTime retentionCutoffUtc, CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "SELECT COUNT(*) FROM pending_reports WHERE created_at > @cutoff;";
        cmd.Parameters.AddWithValue("@cutoff", Iso(retentionCutoffUtc));
        var result = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt32(result);
    }

    /// <summary>固定毫秒精度 ISO8601 UTC，保證 TEXT 字典序 == 時間序。</summary>
    private static string Iso(DateTime utc) =>
        utc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);

    private static DateTime ParseIso(string s) =>
        DateTime.Parse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
}
