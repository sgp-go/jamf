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

            // checkin 回傳的 actions 為「告知式（observational）」，非命令式：
            // 後端 handleLapsOnCheckin 已說明「密碼走 CSP，此處僅告知」。LAPS / BitLocker
            // 等實際執行一律走 Registry 信箱 → 各自 Watcher（LapsWatcher / BitLockerWatcher，
            // 已真機驗證）。此處刻意不依 actions 執行任何動作，避免與 Watcher 雙重執行 /
            // 邏輯分叉；僅記錄數量供診斷。後端若未來新增需 agent 主動執行的 action 類型，
            // 屆時才在此實作對應 handler。
            var actions = parsed?.Data?.Actions;
            _logger.LogInformation(
                "Startup checkin accepted: deviceId={DeviceId} actions={Count} (observational; execution via Registry watchers)",
                parsed?.Data?.DeviceId, actions?.Count ?? 0);

            // 若本次 checkin 帶了 lapsRotationId（tail 補確認），成功後清 registry
            // 防止下次 startup 重複上報同一 rotation
            if (!string.IsNullOrEmpty(lapsRotationId))
            {
                ClearConfirmedRotationIdRegistry();
            }
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
    ///
    /// 寫入端在 `LapsWatcher.WriteConfirmedRotationIdRegistry`（改密成功後）；
    /// 這裡是「Agent restart 兜底」路徑（主路徑是 LapsWatcher.NotifyBackendCheckinAsync 立即 checkin）。
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

    /// <summary>
    /// Startup checkin 帶 lapsRotationId 上報成功後清 registry；防止下次啟動再次上報同一 rotation。
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private void ClearConfirmedRotationIdRegistry()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.LocalMachine
                .OpenSubKey(@"SOFTWARE\CoGrow\Agent\Laps", writable: true);
            key?.DeleteValue("ConfirmedRotationId", throwOnMissingValue: false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Startup checkin: 清 ConfirmedRotationId 失敗（無害）");
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };
}
