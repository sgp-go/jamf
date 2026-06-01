using System.Diagnostics;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Locking;

/// <summary>
/// 監控 Registry 鎖定旗標，在 active 使用者 session 拉起/維持全螢幕鎖定窗 helper。
/// 見 [[windows-lock-design]]。
///
/// 設計取捨：2s 輪詢負責「狀態變更偵測」+「DisableTaskMgr 同步」+「helper 存活兜底」；
/// 額外掛 <see cref="Process.Exited"/> 事件做**即時重啟**（防杀加固 (A)）——helper 被
/// taskkill / Stop-Process 殺掉後，毫秒級重拉，而非等下個 2s tick。學生無法殺 LocalSystem
/// 服務（session 0），故循環 kill 從「鎖定形同虛設」變成「高頻閃爍但桌面始終不可用」。
/// 見 [[windows-lock-design]] §8。
///
/// 行為矩陣（每 tick + 每次 helper 退出）：
///   先同步 DisableTaskMgr 跟隨鎖定狀態（鎖定=1 禁用任務管理器 / 解鎖=0 恢復），再：
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
    // DisableTaskMgr 加固：系統保留策略區，MDM 自定義 ADMX 寫此區被拒（425），
    // 故由 Agent（LocalSystem）承擔，隨鎖定狀態切換。
    private const string TaskMgrPolicyKeyPath =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
    private const string DisableTaskMgrValue = "DisableTaskMgr";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
    // 即時重啟節流：循環 kill 場景下，兩次拉起至少間隔此值，避免進程創建打滿 CPU（自損）。
    // 最壞鎖定窗空檔 = 此值（遠優於原 2s）；250ms 內學生無法完成有意義的點擊/輸入。
    private static readonly TimeSpan MinRelaunchInterval = TimeSpan.FromMilliseconds(250);

    private readonly ILogger<LockWatcher> _logger;

    // 即時重啟協調：_relaunchGate 串行化「tick 重拉」與「Exited 事件重拉」兩條路徑；
    // _stopping 在服務停止（含 MSI 升級優雅停啟）時設真，阻止 Exited 事件把 helper 拉回。
    private readonly object _relaunchGate = new();
    private Process? _helper;
    private DateTime _lastLaunchUtc = DateTime.MinValue;
    private volatile bool _stopping;

    public LockWatcher(ILogger<LockWatcher> logger) => _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("LockWatcher: 非 Windows 平台，停用（dev no-op）");
            return;
        }

        _logger.LogInformation("LockWatcher 啟動，輪詢間隔 {Seconds}s + helper 退出即時重啟",
            PollInterval.TotalSeconds);

        try
        {
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
        finally
        {
            // 服務停止（含 MSI 升級優雅停啟）：標記停止並解除 helper 監聽，避免 Exited 回調
            // 在停服務期間把鎖定窗拉回，干擾優雅停啟（[[windows-agent-update-delivery]]）。
            _stopping = true;
            DetachHelper();
        }
    }

    [SupportedOSPlatform("windows")]
    private void TickWindows()
    {
        var locked = IsLockEnabled();

        // 加固：DisableTaskMgr 跟隨鎖定狀態（堵死用任務管理器殺 LockUI 逃逸；解鎖恢復）。
        // MDM 自定義 ADMX 寫此系統保留策略區被拒（425），故由本服務（LocalSystem）承擔。
        SyncTaskMgrPolicy(locked);

        if (!locked)
        {
            return; // 未鎖：helper 自輪詢自關，watcher 不需動作
        }

        EnsureHelperRunning(); // 鎖定態 → 確保 helper 存活（缺則拉起並掛即時重啟監聽）
    }

    /// <summary>
    /// 確保鎖定窗 helper 存活。已運行則無動作；否則經 <see cref="Relaunch"/> 拉起。
    /// tick（2s）與 Exited 事件（即時）共用此入口，由 _relaunchGate 串行化。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private void EnsureHelperRunning()
    {
        if (IsHelperRunning())
        {
            return;
        }
        Relaunch("watcher tick");
    }

    /// <summary>
    /// 串行化、帶節流地重拉鎖定窗 helper。會二次確認「仍鎖定 + 仍無 helper + 未停止」，
    /// 避免與另一條路徑重複拉起或在解鎖/停服務後誤拉。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private void Relaunch(string reason)
    {
        lock (_relaunchGate)
        {
            if (_stopping || !IsLockEnabled() || IsHelperRunning())
            {
                return;
            }

            // 節流：循環 kill 下限制最高拉起頻率，防進程創建打滿 CPU。睡眠 < 250ms 可接受。
            var since = DateTime.UtcNow - _lastLaunchUtc;
            if (since < MinRelaunchInterval)
            {
                Thread.Sleep(MinRelaunchInterval - since);
                if (_stopping || !IsLockEnabled() || IsHelperRunning())
                {
                    return;
                }
            }

            var exePath = Path.Combine(AppContext.BaseDirectory, LockUiExeName);
            if (!File.Exists(exePath))
            {
                _logger.LogError("LockWatcher: 找不到鎖定窗 helper {Path}（安裝包需含 LockUI.exe）", exePath);
                return;
            }

            var pid = SessionLauncher.LaunchInActiveSession(exePath, AppContext.BaseDirectory);
            _lastLaunchUtc = DateTime.UtcNow;
            if (pid is null)
            {
                _logger.LogWarning("LockWatcher: 無 active console session（沒人登入？），稍後重試");
                return;
            }

            TrackHelper(pid.Value, reason);
        }
    }

    /// <summary>
    /// 掛 Exited 事件做即時重啟。拿不到 Process（拉起後瞬間退出 / 跨 session 句柄失敗）時
    /// 不致命：下個 2s tick 會經 IsHelperRunning 兜底重拉。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private void TrackHelper(int pid, string reason)
    {
        DetachHelper(); // 先解除舊監聽，避免事件重複註冊 / 句柄洩漏
        try
        {
            var p = Process.GetProcessById(pid);
            p.EnableRaisingEvents = true;
            p.Exited += OnHelperExited;
            _helper = p;
            _logger.LogInformation("LockWatcher: 已拉起鎖定窗 pid={Pid}（{Reason}），已掛即時重啟監聽", pid, reason);
        }
        catch (Exception ex)
        {
            // ArgumentException：進程已退出；其餘權限/句柄問題同樣降級到 tick 兜底。
            _logger.LogWarning(ex, "LockWatcher: 掛 helper 退出監聽失敗 pid={Pid}（降級到 2s tick 兜底）", pid);
        }
    }

    /// <summary>helper 退出回調：仍鎖定且未停止 → 毫秒級重拉。防杀加固 (A) 的核心。</summary>
    private void OnHelperExited(object? sender, EventArgs e)
    {
        if (_stopping || !OperatingSystem.IsWindows())
        {
            return;
        }
        try
        {
            if (IsLockEnabled())
            {
                _logger.LogWarning("LockWatcher: 偵測鎖定窗退出（疑遭強制終止），即時重拉");
                Relaunch("helper exited");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LockWatcher: helper 退出即時重啟失敗");
        }
    }

    /// <summary>解除並釋放當前 helper 監聽（解鎖 / 重拉前 / 服務停止）。</summary>
    private void DetachHelper()
    {
        var p = _helper;
        _helper = null;
        if (p is null)
        {
            return;
        }
        try
        {
            p.Exited -= OnHelperExited;
            p.Dispose();
        }
        catch
        {
            // 釋放失敗無害，吞掉
        }
    }

    /// <summary>
    /// 同步 DisableTaskMgr 到鎖定狀態（鎖定=1 禁用 / 解鎖=0 恢復）。冪等：值未變不寫，
    /// 避免每 2s 無謂 IO。失敗只記警告不中斷（加固項，非鎖定核心）。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private void SyncTaskMgrPolicy(bool locked)
    {
        var target = locked ? 1 : 0;
        try
        {
            using var key = Registry.LocalMachine.CreateSubKey(TaskMgrPolicyKeyPath);
            var current = key.GetValue(DisableTaskMgrValue) as int?;
            if (current != target)
            {
                key.SetValue(DisableTaskMgrValue, target, RegistryValueKind.DWord);
                _logger.LogInformation("DisableTaskMgr {From} → {To}", current, target);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "同步 DisableTaskMgr 失敗（非致命，繼續）");
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
