using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Queue;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Posts installed MSI / Win32 apps list to
/// POST {api_endpoint}/tenants/{tenant_id}/agent/installed-apps.
///
/// Backend 端做**全量替換**（Agent 送當前完整清單，backend upsert + 刪 stale row），
/// 所以 Agent 只需定期送當前 snapshot 不必 diff。
///
/// 建議調用時機（由上層 Worker 決定）：
///   1. Agent 啟動一次（帶最新清單首次入庫）
///   2. 之後每 24h 一次（跟 DeviceFacts daily report 同節奏）
///   3. App 派發 / 卸載後可主動觸發（讓後台立即看到）
///
/// 失敗序列化 payload 入隊持久重試，與 <see cref="GpsReporter"/> 同模式。
/// </summary>
public sealed class InstalledAppsReporter
{
    private readonly HttpClient _http;
    private readonly AgentConfigProvider _configProvider;
    private readonly IReportQueue _queue;
    private readonly ILogger<InstalledAppsReporter> _logger;

    public InstalledAppsReporter(
        HttpClient http,
        AgentConfigProvider configProvider,
        IReportQueue queue,
        ILogger<InstalledAppsReporter> logger)
    {
        _http = http;
        _configProvider = configProvider;
        _queue = queue;
        _logger = logger;
        _http.Timeout = TimeSpan.FromSeconds(60);
    }

    public async Task ReportAsync(InstalledAppsPayload payload, CancellationToken ct)
    {
        var config = _configProvider.Current;
        var serialised = JsonSerializer.Serialize(payload, JsonOptions);

        _logger.LogInformation(
            "Reporting {Count} installed apps to {Url}",
            payload.Apps.Count, config.InstalledAppsUrl);

        try
        {
            await PostAsync(config, payload, ct);
        }
        catch (Exception ex) when (IsTransient(ex, ct))
        {
            _logger.LogError(
                ex, "InstalledApps send failed — enqueuing for retry (serial={Serial})",
                payload.SerialNumber);
            await _queue.EnqueueAsync(ReportType.InstalledAppsReport, serialised, ct);
            throw;
        }
    }

    internal async Task<bool> RetryAsync(string serialisedPayload, CancellationToken ct)
    {
        var config = _configProvider.Current;
        SetBearer(config);

        using var content = new StringContent(
            serialisedPayload, Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(config.InstalledAppsUrl, content, ct);
        return response.IsSuccessStatusCode;
    }

    private void SetBearer(AgentConfig config)
    {
        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", config.AgentToken);
    }

    private async Task PostAsync(
        AgentConfig config,
        InstalledAppsPayload payload,
        CancellationToken ct)
    {
        SetBearer(config);
        using var response = await _http.PostAsJsonAsync(
            config.InstalledAppsUrl, payload, JsonOptions, ct);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            _logger.LogError(
                "InstalledApps report failed: {Status} body={Body}",
                response.StatusCode, body);
            response.EnsureSuccessStatusCode();
        }
        _logger.LogInformation("InstalledApps report accepted");
    }

    private static bool IsTransient(Exception ex, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return false;
        return ex is HttpRequestException or TaskCanceledException;
    }

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };
}

/// <summary>對應後端 `installedAppsBody`（app/routes/v1/agent.ts）。</summary>
public sealed record InstalledAppsPayload
{
    public required string SerialNumber { get; init; }
    public required IReadOnlyList<InstalledApp> Apps { get; init; }
}
