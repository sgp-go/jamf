namespace CoGrowMDMAgent.Queue;

/// <summary>
/// A row in the local <c>pending_reports</c> table — a report payload that
/// failed to reach the server and is waiting for the drainer to retry it.
///
/// <para><see cref="Payload"/> is the already-serialised JSON body; the drainer
/// POSTs it raw via <c>Reporter.RetryAsync</c>, so the payload doesn't need to
/// be re-built from device state at retry time (which would diverge from the
/// original moment the report was taken).</para>
/// </summary>
public sealed record PendingReport(
    long Id,
    string ReportType,
    string Payload,
    DateTime CreatedAtUtc,
    int AttemptCount,
    string? LastError);
