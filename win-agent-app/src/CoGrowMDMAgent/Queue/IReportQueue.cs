namespace CoGrowMDMAgent.Queue;

/// <summary>
/// Local persistent queue for reports that failed to reach the server.
///
/// <para>Lifecycle:</para>
/// <list type="number">
/// <item><see cref="InitializeAsync"/> at startup creates the SQLite file +
/// table (idempotent — safe to call every boot; also migrates older DBs that
/// predate the <c>next_retry_at</c> column).</item>
/// <item>Reporter calls <see cref="EnqueueAsync"/> on send failure (keeps the
/// raw JSON so a subsequent retry POSTs the exact bytes from the original
/// moment, not a fresh snapshot). The first retry is scheduled
/// <see cref="RetryBackoff.Base"/> into the future.</item>
/// <item>Worker periodically calls <see cref="DequeueDueAsync"/> (only rows
/// whose backoff has elapsed) → retries via reporter → on success
/// <see cref="MarkSuccessAsync"/>; on failure <see cref="IncrementAttemptAsync"/>
/// (which pushes <c>next_retry_at</c> further out per <see cref="RetryBackoff"/>).</item>
/// <item>Rows older than the retention window (<c>created_at &lt; cutoff</c>)
/// are filtered out by <see cref="DequeueDueAsync"/> and become dead-letters
/// (kept in DB for audit; never retried).</item>
/// </list>
/// </summary>
public interface IReportQueue
{
    Task InitializeAsync(CancellationToken ct);

    Task EnqueueAsync(string reportType, string payload, CancellationToken ct);

    /// <summary>
    /// Take up to <paramref name="batchSize"/> rows that are <b>due</b>
    /// (<c>next_retry_at &lt;= nowUtc</c>) and still within the retention window
    /// (<c>created_at &gt; retentionCutoffUtc</c>), oldest first.
    /// </summary>
    Task<IReadOnlyList<PendingReport>> DequeueDueAsync(
        int batchSize,
        DateTime nowUtc,
        DateTime retentionCutoffUtc,
        CancellationToken ct);

    Task MarkSuccessAsync(long id, CancellationToken ct);

    /// <summary>
    /// Bump the attempt counter, store <paramref name="lastError"/>, and push
    /// <c>next_retry_at</c> out by <see cref="RetryBackoff.Compute"/> of the new
    /// attempt count (measured from now).
    /// </summary>
    Task IncrementAttemptAsync(long id, string lastError, CancellationToken ct);

    /// <summary>
    /// Earliest <c>next_retry_at</c> among rows still within the retention
    /// window, or <c>null</c> when the queue is empty. Lets the Worker wake just
    /// in time for the next retry instead of waiting for the daily slot.
    /// </summary>
    Task<DateTime?> GetEarliestNextRetryAsync(
        DateTime retentionCutoffUtc,
        CancellationToken ct);

    /// <summary>
    /// Count of rows still within the retention window (i.e. not dead-lettered);
    /// useful for diagnostics.
    /// </summary>
    Task<int> CountPendingAsync(DateTime retentionCutoffUtc, CancellationToken ct);
}
