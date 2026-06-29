using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Queue;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Posts GPS samples to POST {api_endpoint}/tenants/{tenant_id}/agent/gps.
///
/// 後端只保最新一筆位置（非歷史追蹤），失敗時序列化 payload 入隊持久重試，
/// 與 <see cref="DeviceReporter"/> / <see cref="UsageReporter"/> 同模式。
///
/// payload schema 詳見 app/routes/v1/agent.ts gpsBody：
///   { serialNumber, latitude:number, longitude:number,
///     accuracyMeters?:int|null, capturedAt?:ISO8601|null }
/// </summary>
public sealed class GpsReporter
{
    private readonly HttpClient _http;
    private readonly AgentConfigProvider _configProvider;
    private readonly IReportQueue _queue;
    private readonly ILogger<GpsReporter> _logger;

    public GpsReporter(
        HttpClient http,
        AgentConfigProvider configProvider,
        IReportQueue queue,
        ILogger<GpsReporter> logger)
    {
        _http = http;
        _configProvider = configProvider;
        _queue = queue;
        _logger = logger;
        _http.Timeout = TimeSpan.FromSeconds(30);
    }

    public async Task ReportAsync(GpsPayload payload, CancellationToken ct)
    {
        var config = _configProvider.Current;
        var serialised = JsonSerializer.Serialize(payload, JsonOptions);

        _logger.LogInformation(
            "Reporting GPS lat={Lat} lng={Lng} acc={Acc}m to {Url}",
            payload.Latitude.ToString("F6", CultureInfo.InvariantCulture),
            payload.Longitude.ToString("F6", CultureInfo.InvariantCulture),
            payload.AccuracyMeters?.ToString() ?? "n/a",
            config.GpsUrl);

        try
        {
            await PostAsync(config, payload, ct);
        }
        catch (Exception ex) when (IsTransient(ex, ct))
        {
            _logger.LogError(
                ex, "GPS send failed — enqueuing for retry (serial={Serial})",
                payload.SerialNumber);
            await _queue.EnqueueAsync(ReportType.GpsReport, serialised, ct);
            throw;
        }
    }

    internal async Task<bool> RetryAsync(string serialisedPayload, CancellationToken ct)
    {
        var config = _configProvider.Current;
        SetBearer(config);

        using var content = new StringContent(
            serialisedPayload, Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(config.GpsUrl, content, ct);
        return response.IsSuccessStatusCode;
    }

    private void SetBearer(AgentConfig config)
    {
        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", config.AgentToken);
    }

    private async Task PostAsync(
        AgentConfig config,
        GpsPayload payload,
        CancellationToken ct)
    {
        SetBearer(config);
        using var response = await _http.PostAsJsonAsync(
            config.GpsUrl, payload, JsonOptions, ct);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            _logger.LogError(
                "GPS report failed: {Status} body={Body}",
                response.StatusCode, body);
            response.EnsureSuccessStatusCode();
        }
        _logger.LogInformation("GPS report accepted");
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

/// <summary>
/// 對應後端 gpsBody（app/routes/v1/agent.ts）：lat/lng 用 double 序列化為 JSON number，
/// 後端 zod schema 接收 number 後內部存 text（避浮點精度差），對 Agent 透明。
/// </summary>
public sealed record GpsPayload
{
    public required string SerialNumber { get; init; }
    public required double Latitude { get; init; }
    public required double Longitude { get; init; }
    public int? AccuracyMeters { get; init; }
    /// <summary>ISO 8601 UTC（含 Z 後綴）；省略則由後端用 now() 落庫。</summary>
    public string? CapturedAt { get; init; }
}
