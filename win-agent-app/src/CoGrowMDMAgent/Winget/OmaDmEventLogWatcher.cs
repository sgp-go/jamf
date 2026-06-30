using System.Diagnostics.Eventing.Reader;
using System.Runtime.Versioning;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Winget;

/// <summary>
/// 監聽 Windows OMA-DM session 啟動的 EventLog，觸發 <see cref="WingetWatcher.RequestPoll"/>。
///
/// Event source：<c>Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Operational</c>
/// Event ID：<c>265</c>（「MDM 會話：已觸發 OMA-DM 會話」）
///
/// 觸發鏈：backend triggerWnsPush → Microsoft WNS → dmwappushsvc → OMA-DM session 啟動
/// → EventLog 寫 265 → 本 watcher 抓到 → WingetWatcher.RequestPoll → POST /agent/checkin
/// → 取得 wingetCommands → winget.exe 執行。
///
/// 真機驗證 2026-06-29 PF5XSMN1 確認該事件 ID 在 Win11 24H2 上穩定 fire。
///
/// 設計：本 watcher 只做「轉接」——監聽到事件 → 喚醒 WingetWatcher，不解析事件內容、
/// 不區分「我們的 push」vs「Windows 自動 OMA-DM session」。多觸發 checkin 無害。
/// 若 EventLog 訂閱失敗（罕見、權限問題），WingetWatcher 有 fallback poll 兜底。
/// </summary>
public sealed class OmaDmEventLogWatcher : BackgroundService
{
    private const string LogName =
        "Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Operational";
    private const int OmaDmSessionStartedEventId = 265;
    private static readonly string XPath =
        $"*[System[(EventID={OmaDmSessionStartedEventId})]]";

    private readonly WingetWatcher _wingetWatcher;
    private readonly ILogger<OmaDmEventLogWatcher> _logger;

    private EventLogWatcher? _watcher;

    public OmaDmEventLogWatcher(
        WingetWatcher wingetWatcher,
        ILogger<OmaDmEventLogWatcher> logger)
    {
        _wingetWatcher = wingetWatcher;
        _logger = logger;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("OmaDmEventLogWatcher: 非 Windows 平台，停用");
            return Task.CompletedTask;
        }

        StartWatching();

        stoppingToken.Register(() =>
        {
            try { _watcher?.Dispose(); } catch { /* best effort */ }
        });

        return Task.CompletedTask;
    }

    [SupportedOSPlatform("windows")]
    private void StartWatching()
    {
        try
        {
            var query = new EventLogQuery(LogName, PathType.LogName, XPath);
            _watcher = new EventLogWatcher(query);
            _watcher.EventRecordWritten += OnEventRecordWritten;
            _watcher.Enabled = true;
            _logger.LogInformation(
                "OmaDmEventLogWatcher 啟動 — 監聽 {Log} EventID={Id}",
                LogName, OmaDmSessionStartedEventId);
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogError(ex,
                "EventLogWatcher 權限不足（需要 EventLogReaders 或 LocalSystem）。fallback：WingetWatcher 仍有 180s 定時 poll 兜底");
        }
        catch (EventLogNotFoundException ex)
        {
            _logger.LogError(ex,
                "EventLog channel 不存在（系統異常或非 Windows）。fallback：WingetWatcher fallback poll");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex,
                "EventLogWatcher 啟動失敗（不影響其他 watcher）。fallback：WingetWatcher fallback poll");
        }
    }

    private void OnEventRecordWritten(object? sender, EventRecordWrittenEventArgs e)
    {
        try
        {
            if (e.EventException is not null)
            {
                _logger.LogWarning(e.EventException,
                    "EventRecordWritten 收到 exception（可能訂閱 backlog 跟不上）");
                return;
            }

            if (e.EventRecord is null) return;

            _logger.LogInformation(
                "OMA-DM session 啟動偵測（EventID={Id}）— 觸發 winget checkin",
                e.EventRecord.Id);

            // 喚醒 WingetWatcher。Channel 容量 1，重複觸發會被合併。
            _wingetWatcher.RequestPoll();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "處理 EventLog 事件失敗");
        }
        finally
        {
            try { e.EventRecord?.Dispose(); } catch { /* best effort */ }
        }
    }
}
