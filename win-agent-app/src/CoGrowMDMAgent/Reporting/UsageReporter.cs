using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Queue;
using CoGrowMDMAgent.Reporting.Usage;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Posts daily usage stats to
/// POST {api_endpoint}/tenants/{tenant_id}/agent/usage.
///
/// Day 1 scope: wire path only. Actual Windows usage collection (active
/// minutes / pickup count / max continuous) is W3 work — for now the worker
/// can pass an empty <c>stats</c> list and the call is skipped.
///
/// Failure handling mirrors <see cref="DeviceReporter"/>: serialised payload
/// is enqueued via <see cref="IReportQueue"/> on send failure, then re-thrown
/// so the worker logs the failed cycle.
/// </summary>
public sealed class UsageReporter
{
    private readonly HttpClient _http;
    private readonly AgentConfigProvider _configProvider;
    private readonly IReportQueue _queue;
    private readonly ILogger<UsageReporter> _logger;

    public UsageReporter(
        HttpClient http,
        AgentConfigProvider configProvider,
        IReportQueue queue,
        ILogger<UsageReporter> logger)
    {
        _http = http;
        _configProvider = configProvider;
        _queue = queue;
        _logger = logger;

        // Bearer header 每次 request 從 provider.Current 取（hot-reload 友好）
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

        var config = _configProvider.Current;
        var payload = new UsageStatsPayload
        {
            SerialNumber = serialNumber,
            SessionId = sessionId,
            Stats = stats,
        };
        var serialised = JsonSerializer.Serialize(payload, JsonOptions);

        _logger.LogInformation(
            "Reporting {Count} usage rows to {Url}",
            stats.Count, config.UsageUrl);

        try
        {
            await PostAsync(config, payload, ct);
        }
        catch (Exception ex) when (IsTransient(ex, ct))
        {
            _logger.LogError(
                ex, "Usage send failed — enqueuing for retry (serial={Serial})",
                serialNumber);
            await _queue.EnqueueAsync(ReportType.UsageReport, serialised, ct);
            throw;
        }
    }

    /// <summary>
    /// Retry a queued usage payload. Returns true on 2xx; non-success status
    /// returns false. Network/timeout exceptions propagate.
    /// </summary>
    internal async Task<bool> RetryAsync(string serialisedPayload, CancellationToken ct)
    {
        var config = _configProvider.Current;
        SetBearer(config);
        // 反序列化重算簽名（簽名綁定 payload 內容，不存在隊列裡）。反序列化失敗
        // 則不帶簽名送出，後端對無簽名請求跳過驗簽（相容降級）。
        var payload = JsonSerializer.Deserialize<UsageStatsPayload>(serialisedPayload, JsonOptions);
        if (payload is not null) SetUsageSignature(config, payload);

        using var content = new StringContent(
            serialisedPayload, Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(config.UsageUrl, content, ct);
        return response.IsSuccessStatusCode;
    }

    /// <summary>HMAC 簽名 header 名稱（後端 usage route 同名讀取）。</summary>
    private const string SignatureHeader = "X-Usage-Signature";

    private void SetBearer(AgentConfig config)
    {
        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", config.AgentToken);
    }

    /// <summary>
    /// 用 agent_token 對 payload 計算 HMAC，寫入簽名 header（防篡改第 3 層）。
    /// 與 SetBearer 同樣走 DefaultRequestHeaders（worker 串行，無併發競態）；
    /// 每次 Remove 後 Add，避免殘留上一次的值。
    /// </summary>
    private void SetUsageSignature(AgentConfig config, UsageStatsPayload payload)
    {
        var signature = UsageSignature.Compute(config.AgentToken, payload);
        _http.DefaultRequestHeaders.Remove(SignatureHeader);
        _http.DefaultRequestHeaders.Add(SignatureHeader, signature);
    }

    private async Task PostAsync(
        AgentConfig config,
        UsageStatsPayload payload,
        CancellationToken ct)
    {
        SetBearer(config);
        SetUsageSignature(config, payload);
        using var response = await _http.PostAsJsonAsync(
            config.UsageUrl, payload, JsonOptions, ct);

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

    private static bool IsTransient(Exception ex, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return false;
        return ex is HttpRequestException or TaskCanceledException;
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };
}
