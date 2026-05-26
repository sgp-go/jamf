using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CoGrowMDMAgent.Config;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Posts daily usage stats to
/// POST {api_endpoint}/tenants/{tenant_id}/agent/usage.
///
/// Day 1 scope: wire path only. Actual Windows usage collection (active
/// minutes / pickup count / max continuous) is W3 work — for now the worker
/// can pass an empty <c>stats</c> list and the call is skipped.
/// </summary>
public sealed class UsageReporter
{
    private readonly HttpClient _http;
    private readonly AgentConfig _config;
    private readonly ILogger<UsageReporter> _logger;

    public UsageReporter(
        HttpClient http,
        AgentConfig config,
        ILogger<UsageReporter> logger)
    {
        _http = http;
        _config = config;
        _logger = logger;

        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", _config.AgentToken);
        _http.Timeout = TimeSpan.FromSeconds(30);
    }

    public async Task ReportAsync(
        IReadOnlyList<UsageStatItem> stats,
        string? sessionId,
        string serialNumber,
        CancellationToken ct)
    {
        if (stats.Count == 0)
        {
            _logger.LogInformation("No usage stats to report — skipping");
            return;
        }

        var payload = new UsageStatsPayload
        {
            SerialNumber = serialNumber,
            SessionId = sessionId,
            Stats = stats,
        };

        _logger.LogInformation(
            "Reporting {Count} usage rows to {Url}",
            stats.Count, _config.UsageUrl);

        using var response = await _http.PostAsJsonAsync(
            _config.UsageUrl, payload, JsonOptions, ct);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            _logger.LogError(
                "Usage report failed: {Status} body={Body}",
                response.StatusCode, body);
            response.EnsureSuccessStatusCode();
        }

        _logger.LogInformation("Usage report accepted");
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };
}
