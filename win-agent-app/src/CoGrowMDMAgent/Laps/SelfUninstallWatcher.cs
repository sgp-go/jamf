using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Laps;

/// <summary>
/// 監控自卸載指令 Registry 信箱。
///
/// ADMX Policy CSP 落點：HKLM\Software\CoGrow\Agent\SelfUninstall
///   Pending (DWORD) — 1=待執行
///
/// Agent 讀到 Pending=1 後查 WMI 找到自身 ProductCode，啟動 msiexec /x 卸載。
/// msiexec 的 ServiceControl 會先停服務再卸載，所以 Agent 在 msiexec 開始後自然退出。
///
/// ⚠️ 必須等其它 unenroll-related watcher 完成才能啟動 msiexec：
/// backend unenroll 流程同 OMA-DM session 內同時寫 PpkgRemoval + SelfUninstall 兩個信箱，
/// 兩個 watcher 並行 2s tick 可能同毫秒讀到 Pending=1。若 SelfUninstall 先啟動 msiexec /x
/// 把 service 停掉，PpkgRemovalWatcher 的 PowerShell（執行 Remove-ProvisioningPackage）
/// 會被打斷，PPKG 殘留在「半移除」狀態（IsApplied=空但檔案還在）。
/// 解法：tick 觸發前先 wait PpkgRemoval Pending 變 0（or timeout）再 self-uninstall。
///
/// ⚠️ 持久化 trigger（StatePath）：unenroll 流程 backend 同 OMA-DM session 內把
/// PpkgRemoval + SelfUninstall + DMClient/Unenroll 全部毫秒級派完，DMClient/Unenroll Exec
/// 撤銷 enrollment 觸發 ADMX engine reactive cleanup，把整個 implementing-side registry
/// （含 KeyPath 下 Pending）清空。Agent watcher 2s tick 醒來時 KeyPath 已不存在 → return。
/// 解法：tick 偵測到 Pending=1 後**立即**寫一個非 ADMX-scoped 的持久標誌 State\SelfUninstallTriggered，
/// 不受 enrollment 撤銷影響；下一個 tick 看到此標誌即繼續流程（即使 ADMX KeyPath 已消失）。
///
/// ⚠️ trigger 必須在 spawn `msiexec /x` 之前清掉（不能等卸完才清，service 一旦 stop 後續代碼就跑不到）。
/// 否則一旦設備被重新 enroll + EDA-CSP 重裝 agent，新 agent 啟動 2s tick 讀到 trigger 還在 → 立刻自卸 →
/// 死循環裝了又卸（2026-06-26 真機踩到）。trigger 已完成使命就清掉。
/// </summary>
public sealed class SelfUninstallWatcher : BackgroundService
{
    private const string KeyPath = @"SOFTWARE\CoGrow\Agent\SelfUninstall";
    private const string PpkgRemovalKeyPath = @"SOFTWARE\CoGrow\Agent\RemovePpkg";
    private const string StatePath = @"SOFTWARE\CoGrow\Agent\State";
    private const string TriggeredValueName = "SelfUninstallTriggered";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan PpkgRemovalWaitTimeout = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan PpkgRemovalWaitInterval = TimeSpan.FromMilliseconds(500);

    private readonly ILogger<SelfUninstallWatcher> _logger;

    public SelfUninstallWatcher(ILogger<SelfUninstallWatcher> logger) => _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("SelfUninstallWatcher: 非 Windows 平台，停用");
            return;
        }

        _logger.LogInformation("SelfUninstallWatcher 啟動");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                TickWindows();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "SelfUninstallWatcher tick 失敗");
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
        // 1. 檢查持久 trigger（撐過 ADMX cleanup 的源頭）
        bool triggered = ReadTriggered();

        // 2. 若持久 trigger 未設，看 ADMX key Pending=1
        if (!triggered)
        {
            bool pending;
            using (var key = Registry.LocalMachine.OpenSubKey(KeyPath, writable: false))
            {
                if (key == null) return;
                var pendingObj = key.GetValue("Pending");
                pending = pendingObj is int p && p == 1;
            }
            if (!pending) return;

            // **立即** 寫持久 trigger，下一個 tick 即使 ADMX key 被 reactive 清掉也能繼續
            WriteTriggered();
            _logger.LogInformation("偵測到自卸載請求 → 持久化 trigger");
        }
        else
        {
            _logger.LogInformation("從持久 trigger 恢復自卸載流程（ADMX key 可能已被 unenroll cleanup 清除）");
        }

        // 等 PpkgRemoval 完成（避免 race：msiexec /x 停服務時 PpkgRemovalWatcher 的
        // PowerShell 還在跑 Remove-ProvisioningPackage 被打斷，PPKG 殘留）
        WaitForPpkgRemovalComplete();

        // 重開 handle 寫 ADMX Pending=0（best-effort，key 可能已消失）
        using (var writeKey = Registry.LocalMachine.OpenSubKey(KeyPath, writable: true))
        {
            try { writeKey?.SetValue("Pending", 0, RegistryValueKind.DWord); }
            catch (IOException) { /* key 已被 mark for delete，忽略 */ }
        }

        var productCode = FindProductCode();
        if (string.IsNullOrEmpty(productCode))
        {
            _logger.LogError("找不到 CoGrow MDM Agent 的 ProductCode，無法自卸載");
            return;
        }

        // trigger 已完成使命（撐過 ADMX cleanup 撐到這裡）→ 清掉，避免下次設備重新 enroll
        // 後新 agent 起來讀到殘留 trigger 立刻自卸。必須在 spawn msiexec 之前清，service
        // stop 後後續代碼跑不到。
        ClearTriggered();

        _logger.LogInformation("啟動自卸載: ProductCode={ProductCode}", productCode);

        var psi = new ProcessStartInfo("msiexec", $"/x {productCode} /qn /norestart")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        };
        Process.Start(psi);
    }

    /// <summary>清持久 trigger（自卸載流程跑到 spawn msiexec 即清，避免重 enroll 後殘留誤觸發）</summary>
    [SupportedOSPlatform("windows")]
    private void ClearTriggered()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(StatePath, writable: true);
            key?.DeleteValue(TriggeredValueName, throwOnMissingValue: false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "清除 SelfUninstallTriggered 失敗（非致命）");
        }
    }

    /// <summary>持久 trigger：State\SelfUninstallTriggered=1，非 ADMX-scoped 不會被 enrollment 撤銷影響</summary>
    [SupportedOSPlatform("windows")]
    private bool ReadTriggered()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(StatePath);
            if (key == null) return false;
            var v = key.GetValue(TriggeredValueName);
            return v is int i && i == 1;
        }
        catch { return false; }
    }

    [SupportedOSPlatform("windows")]
    private void WriteTriggered()
    {
        try
        {
            using var key = Registry.LocalMachine.CreateSubKey(StatePath, writable: true);
            key?.SetValue(TriggeredValueName, 1, RegistryValueKind.DWord);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "無法寫入 SelfUninstallTriggered 持久標誌");
        }
    }

    /// <summary>
    /// 等 PpkgRemoval 信箱 Pending=0（PpkgRemovalWatcher 把 Pending 寫回 0 表示 PowerShell
    /// Remove-ProvisioningPackage 已完成）。timeout 45 秒（PowerShell 內 WaitForExit 30s + 緩衝）。
    /// 若 RemovePpkg key 不存在 = 從未被觸發過 或 已被 ADMX cleanup 清除，直接返回。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private void WaitForPpkgRemovalComplete()
    {
        var deadline = DateTime.UtcNow + PpkgRemovalWaitTimeout;
        var loggedWait = false;
        while (DateTime.UtcNow < deadline)
        {
            using var ppkg = Registry.LocalMachine.OpenSubKey(PpkgRemovalKeyPath);
            if (ppkg == null) return; // 信箱不存在
            var p = ppkg.GetValue("Pending");
            if (p is not int pi || pi != 1) return; // Pending != 1 = 已完成 / 未觸發
            if (!loggedWait)
            {
                _logger.LogInformation("等待 PpkgRemoval 完成後再 self-uninstall");
                loggedWait = true;
            }
            Thread.Sleep(PpkgRemovalWaitInterval);
        }
        _logger.LogWarning(
            "等待 PpkgRemoval 完成超時 ({Seconds}s)，仍繼續 self-uninstall（PPKG 可能殘留）",
            (int)PpkgRemovalWaitTimeout.TotalSeconds);
    }

    [SupportedOSPlatform("windows")]
    private string? FindProductCode()
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT IdentifyingNumber FROM Win32_Product WHERE Name LIKE '%CoGrow MDM Agent%'");
            foreach (var obj in searcher.Get())
            {
                var code = obj["IdentifyingNumber"]?.ToString();
                if (!string.IsNullOrEmpty(code)) return code;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "WMI 查詢 ProductCode 失敗");
        }
        return null;
    }
}
