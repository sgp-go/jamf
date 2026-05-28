namespace CoGrowMDMAgent.Queue;

/// <summary>
/// Local persistent queue for reports that failed to reach the server.
///
/// <para>Lifecycle:</para>
/// <list type="number">
/// <item><see cref="InitializeAsync"/> at startup creates the SQLite file +
/// table (idempotent — safe to call every boot).</item>
/// <item>Reporter calls <see cref="EnqueueAsync"/> on send failure (keeps the
/// raw JSON so a subsequent retry POSTs the exact bytes from the original
/// moment, not a fresh snapshot).</item>
/// <item>Worker periodically calls <see cref="DequeueBatchAsync"/> →
/// retries via reporter → on success <see cref="MarkSuccessAsync"/>; on
/// failure <see cref="IncrementAttemptAsync"/>.</item>
/// <item>Rows whose <see cref="PendingReport.AttemptCount"/> reaches
/// <c>maxAttempts</c> are filtered out by <see cref="DequeueBatchAsync"/> and
/// effectively become dead-letters (kept in DB for audit; never retried).</item>
/// </list>
/// </summary>
public interface IReportQueue
{
    Task InitializeAsync(CancellationToken ct);

    Task EnqueueAsync(string reportType, string payload, CancellationToken ct);

    /// <summary>
    /// Take up to <paramref name="batchSize"/> rows whose
    /// <see cref="PendingReport.AttemptCount"/> is still below
    /// <paramref name="maxAttempts"/>, oldest first.
    /// </summary>
    Task<IReadOnlyList<PendingReport>> DequeueBatchAsync(
        int batchSize,
        int maxAttempts,
        CancellationToken ct);

    Task MarkSuccessAsync(long id, CancellationToken ct);

    Task IncrementAttemptAsync(long id, string lastError, CancellationToken ct);

    /// <summary>
    /// Count of rows still eligible for retry (attempt &lt; maxAttempts);
    /// useful for diagnostics.
    /// </summary>
    Task<int> CountPendingAsync(int maxAttempts, CancellationToken ct);
}
