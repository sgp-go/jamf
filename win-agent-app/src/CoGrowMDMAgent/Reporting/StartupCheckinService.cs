using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CoGrowMDMAgent.Config;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Agent 啟動時發一次 checkin 請求（POST /agent/checkin），讓後端即時觸發待辦
/// （如 LAPS 輪換），不必等每日 report 週期。
///
/// 與 Worker / LapsWatcher 並行的獨立 hosted service；失敗不阻塞 Agent 啟動。
/// </summary>
public sealed class StartupCheckinService : BackgroundService
{
    private readonly HttpClient _http;
    private readonly AgentConfigProvider _configProvider;
    private readonly DeviceFactsCollector _facts;
    private readonly ILogger<StartupCheckinService> _logger;

    public StartupCheckinService(
        HttpClient http,
        AgentConfigProvider configProvider,
        DeviceFactsCollector facts,
        ILogger<StartupCheckinService> logger)
    {
        _http = http;
        _configProvider = configProvider;
        _facts = facts;
        _logger = logger;
        _http.Timeout = TimeSpan.FromSeconds(15);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var config = _configProvider.Current;
            if (string.IsNullOrEmpty(config.AgentToken))
            {
                _logger.LogWarning("Agent token not configured; skipping startup checkin");
                return;
            }

            var facts = _facts.Collect();
            var lapsRotationId = ReadPendingLapsRotationId();

            var payload = new AgentCheckinPayload
            {
                SerialNumber = facts.SerialNumber,
                OsVersion = facts.OsVersion,
                AppVersion = facts.AppVersion,
                LapsRotationId = lapsRotationId,
            };

            _logger.LogInformation(
                "Startup checkin to {Url} (serial={Serial}, lapsRotationId={LapsId})",
                config.CheckinUrl, facts.SerialNumber, lapsRotationId ?? "(none)");

            _http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", config.AgentToken);

            using var response = await _http.PostAsJsonAsync(
                config.CheckinUrl, payload, JsonOptions, stoppingToken);

            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(stoppingToken);
                _logger.LogError(
                    "Startup checkin failed: {Status} body={Body}",
                    response.StatusCode, body);
                return;
            }

            var parsed = await response.Content
                .ReadFromJsonAsync<AgentCheckinResponse>(JsonOptions, stoppingToken);

            var actions = parsed?.Data?.Actions;
            _logger.LogInformation(
                "Startup checkin accepted: deviceId={DeviceId} actions={Count}",
                parsed?.Data?.DeviceId, actions?.Count ?? 0);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            _logger.LogInformation("Startup checkin cancelled");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Startup checkin failed (non-fatal, Agent continues)");
        }
    }

    /// <summary>
    /// 若 LapsWatcher 上次啟動已完成改密但 Agent 被殺/重啟前未 report，
    /// 從 Registry 確認檔讀取已完成的 rotationId，帶入 checkin 作確認。
    /// </summary>
    private static string? ReadPendingLapsRotationId()
    {
        if (!OperatingSystem.IsWindows()) return null;

        try
        {
            using var key = Microsoft.Win32.Registry.LocalMachine
                .OpenSubKey(@"SOFTWARE\CoGrow\Agent\Laps");
            if (key is null) return null;

            var confirmed = key.GetValue("ConfirmedRotationId") as string;
            return string.IsNullOrEmpty(confirmed) ? null : confirmed;
        }
        catch
        {
            return null;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };
}
