using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Queue;

/// <summary>
/// SQLite-backed <see cref="IReportQueue"/>. One row per failed report; rows
/// are deleted on successful retry (<see cref="MarkSuccessAsync"/>) and kept
/// indefinitely once they exceed <c>maxAttempts</c> (dead-letter — never
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
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            CREATE TABLE IF NOT EXISTS pending_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_pending_reports_attempt
                ON pending_reports(attempt_count, created_at);
        ";
        await cmd.ExecuteNonQueryAsync(ct);
        _logger.LogInformation(
            "SqliteReportQueue initialised at {DataSource}",
            new SqliteConnectionStringBuilder(_connectionString).DataSource);
    }

    public async Task EnqueueAsync(string reportType, string payload, CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            INSERT INTO pending_reports (report_type, payload, created_at, attempt_count)
            VALUES (@reportType, @payload, @createdAt, 0);
        ";
        cmd.Parameters.AddWithValue("@reportType", reportType);
        cmd.Parameters.AddWithValue("@payload", payload);
        cmd.Parameters.AddWithValue("@createdAt", DateTime.UtcNow.ToString("o"));
        await cmd.ExecuteNonQueryAsync(ct);
        _logger.LogInformation(
            "Enqueued failed report type={ReportType} (payload={PayloadSize} bytes)",
            reportType, payload.Length);
    }

    public async Task<IReadOnlyList<PendingReport>> DequeueBatchAsync(
        int batchSize,
        int maxAttempts,
        CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT id, report_type, payload, created_at, attempt_count, last_error
            FROM pending_reports
            WHERE attempt_count < @maxAttempts
            ORDER BY created_at ASC
            LIMIT @batchSize;
        ";
        cmd.Parameters.AddWithValue("@maxAttempts", maxAttempts);
        cmd.Parameters.AddWithValue("@batchSize", batchSize);

        var rows = new List<PendingReport>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            rows.Add(new PendingReport(
                Id: reader.GetInt64(0),
                ReportType: reader.GetString(1),
                Payload: reader.GetString(2),
                CreatedAtUtc: DateTime.Parse(
                    reader.GetString(3),
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.RoundtripKind),
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
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            UPDATE pending_reports
            SET attempt_count = attempt_count + 1,
                last_error = @lastError
            WHERE id = @id;
        ";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@lastError", lastError);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<int> CountPendingAsync(int maxAttempts, CancellationToken ct)
    {
        await using var conn = new SqliteConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "SELECT COUNT(*) FROM pending_reports WHERE attempt_count < @maxAttempts;";
        cmd.Parameters.AddWithValue("@maxAttempts", maxAttempts);
        var result = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt32(result);
    }
}
