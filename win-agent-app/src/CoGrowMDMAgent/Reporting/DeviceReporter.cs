using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Queue;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Posts a device telemetry report to
/// POST {api_endpoint}/tenants/{tenant_id}/agent/reports.
///
/// Bearer auth is mandatory: the server requires the token once install-agent
/// has provisioned the device (agent_token_hash is non-null on the row).
///
/// On send failure the serialised payload is enqueued via
/// <see cref="IReportQueue"/> so the original-moment snapshot is preserved
/// (do **not** re-collect facts on retry — that would diverge from when the
/// report was actually taken). After enqueueing the exception is re-thrown so
/// <c>Worker</c> still logs the failed cycle.
/// </summary>
public sealed class DeviceReporter
{
    private readonly HttpClient _http;
    private readonly AgentConfigProvider _configProvider;
    private readonly DeviceFactsCollector _facts;
    private readonly IReportQueue _queue;
    private readonly ILogger<DeviceReporter> _logger;

    public DeviceReporter(
        HttpClient http,
        AgentConfigProvider configProvider,
        DeviceFactsCollector facts,
        IReportQueue queue,
        ILogger<DeviceReporter> logger)
    {
        _http = http;
        _configProvider = configProvider;
        _facts = facts;
        _queue = queue;
        _logger = logger;

        // Bearer header 不在構造時設 — 每次 request 從 provider.Current 取，
        // 確保 MDM 旋轉 token 後本 cycle 立即生效（不必重啟 service）
        _http.Timeout = TimeSpan.FromSeconds(30);
    }

    public async Task<AgentReportResponseData?> ReportAsync(CancellationToken ct)
    {
        var config = _configProvider.Current;
        var facts = _facts.Collect();
        var payload = new AgentReportPayload
        {
            SerialNumber = facts.SerialNumber,
            OsVersion = facts.OsVersion,
            AppVersion = facts.AppVersion,
            StorageAvailableMb = facts.StorageAvailableMb,
            StorageTotalMb = facts.StorageTotalMb,
            BatteryLevel = facts.BatteryLevel,
            NetworkType = facts.NetworkType,
            NetworkSsid = facts.NetworkSsid,
            ExtraData = facts.Windows is null
                ? null
                : new WindowsExtraData { Windows = facts.Windows },
            ReportedAt = DateTime.UtcNow.ToString("o"),
        };
        var serialised = JsonSerializer.Serialize(payload, JsonOptions);

        _logger.LogInformation(
            "Reporting to {Url} (serial={Serial})",
            config.ReportsUrl, facts.SerialNumber);

        try
        {
            return await PostAsync(config, payload, ct);
        }
        catch (Exception ex) when (IsTransient(ex, ct))
        {
            _logger.LogError(
                ex, "Report send failed — enqueuing for retry (serial={Serial})",
                facts.SerialNumber);
            await _queue.EnqueueAsync(ReportType.DeviceReport, serialised, ct);
            throw;
        }
    }

    /// <summary>
    /// Retry a queued payload — POST the exact bytes drawn from the queue.
    /// Returns true on 2xx, false on non-success status (caller increments
    /// attempt). Network/timeout exceptions propagate so the drainer can also
    /// increment with a meaningful error message.
    /// </summary>
    internal async Task<bool> RetryAsync(string serialisedPayload, CancellationToken ct)
    {
        var config = _configProvider.Current;
        SetBearer(config);
        using var content = new StringContent(
            serialisedPayload, Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(config.ReportsUrl, content, ct);
        return response.IsSuccessStatusCode;
    }

    private void SetBearer(AgentConfig config)
    {
        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", config.AgentToken);
    }

    private async Task<AgentReportResponseData?> PostAsync(
        AgentConfig config,
        AgentReportPayload payload,
        CancellationToken ct)
    {
        SetBearer(config);
        using var response = await _http.PostAsJsonAsync(
            config.ReportsUrl, payload, JsonOptions, ct);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            _logger.LogError(
                "Report failed: {Status} body={Body}",
                response.StatusCode, body);
            response.EnsureSuccessStatusCode();
        }

        var parsed = await response.Content
            .ReadFromJsonAsync<AgentReportResponse>(JsonOptions, ct);
        _logger.LogInformation(
            "Report accepted: reportId={ReportId} deviceId={DeviceId}",
            parsed?.Data?.ReportId, parsed?.Data?.DeviceId);

        return parsed?.Data;
    }

    private static bool IsTransient(Exception ex, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return false;
        // HttpRequestException covers network/DNS/non-success; TaskCanceledException
        // is raised on HttpClient.Timeout (distinct from ct cancellation).
        return ex is HttpRequestException or TaskCanceledException;
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };
}
