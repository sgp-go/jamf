using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CoGrowMDMAgent.Config;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Posts a device telemetry report to
/// POST {api_endpoint}/tenants/{tenant_id}/agent/reports.
///
/// Bearer auth is mandatory: the server requires the token once install-agent
/// has provisioned the device (agent_token_hash is non-null on the row).
/// </summary>
public sealed class DeviceReporter
{
    private readonly HttpClient _http;
    private readonly AgentConfig _config;
    private readonly DeviceFactsCollector _facts;
    private readonly ILogger<DeviceReporter> _logger;

    public DeviceReporter(
        HttpClient http,
        AgentConfig config,
        DeviceFactsCollector facts,
        ILogger<DeviceReporter> logger)
    {
        _http = http;
        _config = config;
        _facts = facts;
        _logger = logger;

        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", _config.AgentToken);
        _http.Timeout = TimeSpan.FromSeconds(30);
    }

    public async Task<AgentReportResponseData?> ReportAsync(CancellationToken ct)
    {
        var facts = _facts.Collect();

        var payload = new AgentReportPayload
        {
            SerialNumber = facts.SerialNumber,
            OsVersion = facts.OsVersion,
            AppVersion = facts.AppVersion,
            StorageAvailableMb = facts.StorageAvailableMb,
            StorageTotalMb = facts.StorageTotalMb,
            ExtraData = facts.Windows is null
                ? null
                : new WindowsExtraData { Windows = facts.Windows },
            ReportedAt = DateTime.UtcNow.ToString("o"),
        };

        _logger.LogInformation(
            "Reporting to {Url} (serial={Serial})",
            _config.ReportsUrl, facts.SerialNumber);

        using var response = await _http.PostAsJsonAsync(
            _config.ReportsUrl, payload, JsonOptions, ct);

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

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };
}
