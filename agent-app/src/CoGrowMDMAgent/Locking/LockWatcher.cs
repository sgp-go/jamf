using System.Diagnostics;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Locking;

/// <summary>
/// 監控 Registry 鎖定旗標，在 active 使用者 session 拉起/維持全螢幕鎖定窗 helper。
/// 見 [[windows-lock-design]]。
///
/// 設計取捨：用輪詢（預設 2s）而非 RegNotifyChangeKeyValue —— 因為「看門狗」（偵測 helper
/// 被殺後重啟）本來就需要週期檢查，輪詢一次同時涵蓋「狀態變更」+「helper 存活」兩件事，
/// 比起額外開 RegNotify 線程更簡單穩健。本地 registry 讀取成本可忽略。
///
/// 行為矩陣（每 tick）：
///   Enabled=1 且 helper 未運行 → 拉起（涵蓋：剛鎖定 / 開機恢復 / helper 被殺後重啟）
///   Enabled=0                  → 不動（helper 自輪詢 Enabled=0 後 Application.Exit 自關）
///
/// 非 Windows（Mac/Linux dev）：no-op，讓服務可跨平台跑起來。
/// </summary>
public sealed class LockWatcher : BackgroundService
{
    private const string LockKeyPath = @"SOFTWARE\CoGrow\Agent\Lock";
    private const string LockUiProcessName = "CoGrowMDMAgent.LockUI";
    private const string LockUiExeName = "CoGrowMDMAgent.LockUI.exe";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

    private readonly ILogger<LockWatcher> _logger;

    public LockWatcher(ILogger<LockWatcher> logger) => _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("LockWatcher: 非 Windows 平台，停用（dev no-op）");
            return;
        }

        _logger.LogInformation("LockWatcher 啟動，輪詢間隔 {Seconds}s", PollInterval.TotalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                TickWindows();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "LockWatcher tick 失敗（不中斷循環）");
            }

            try
            {
                await Task.Delay(PollInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    [SupportedOSPlatform("windows")]
    private void TickWindows()
    {
        if (!IsLockEnabled())
        {
            return; // 未鎖：helper 自輪詢自關，watcher 不需動作
        }

        if (IsHelperRunning())
        {
            return; // 已鎖且 helper 運行中
        }

        // 鎖定態但無 helper → 拉起（剛鎖 / 開機恢復 / helper 被殺）
        var exePath = Path.Combine(AppContext.BaseDirectory, LockUiExeName);
        if (!File.Exists(exePath))
        {
            _logger.LogError("LockWatcher: 找不到鎖定窗 helper {Path}（安裝包需含 LockUI.exe）", exePath);
            return;
        }

        var pid = SessionLauncher.LaunchInActiveSession(exePath, AppContext.BaseDirectory);
        if (pid is null)
        {
            _logger.LogWarning("LockWatcher: 無 active console session（沒人登入？），稍後重試");
        }
        else
        {
            _logger.LogInformation("LockWatcher: 已在使用者 session 拉起鎖定窗 pid={Pid}", pid);
        }
    }

    [SupportedOSPlatform("windows")]
    private static bool IsLockEnabled()
    {
        using var key = Registry.LocalMachine.OpenSubKey(LockKeyPath);
        return key?.GetValue("Enabled") is int v && v == 1;
    }

    private static bool IsHelperRunning()
    {
        // LocalSystem 服務可枚舉所有 session 的進程
        var procs = Process.GetProcessesByName(LockUiProcessName);
        try
        {
            return procs.Length > 0;
        }
        finally
        {
            foreach (var p in procs) p.Dispose();
        }
    }
}
