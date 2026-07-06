using System.Diagnostics;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Laps;

/// <summary>
/// 監控 Rename Registry 信箱，偵測到 Pending=1 後執行 Rename-Computer（下次 reboot 生效）。
///
/// 為何走 agent 而非 Accounts CSP：`./Device/Vendor/MSFT/Accounts/Domain/ComputerName`
/// 的遠端 Replace 對 workgroup / PPKG 納管設備回 406（optional feature not supported，
/// 非 Entra-joined 場景不支援；真機 PF5XSMN1 2026-07-06 驗）。改走與 LAPS 同款信箱。
///
/// ADMX Policy CSP 落點：HKLM\Software\CoGrow\Agent\Rename
///   Pending (DWORD)   — 1=待執行, 0=已完成
///   NewName (REG_SZ)  — 目標計算機名（backend 已驗證 ≤15 字、無非法字元）
///   RenameId (REG_SZ) — 唯一重命名 ID（防重放）
///
/// 模式同 LapsWatcher：輪詢 + 即時動作。非 Windows 平台 no-op。
/// Rename-Computer 語意：改 SAM / registry，實際 hostname 於下次 reboot 生效。
/// </summary>
public sealed class RenameWatcher : BackgroundService
{
    private const string RenameKeyPath = @"SOFTWARE\CoGrow\Agent\Rename";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

    private readonly ILogger<RenameWatcher> _logger;

    public RenameWatcher(ILogger<RenameWatcher> logger)
    {
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("RenameWatcher: 非 Windows 平台，停用（dev no-op）");
            return;
        }

        _logger.LogInformation("RenameWatcher 啟動，輪詢間隔 {Seconds}s", PollInterval.TotalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                TickWindows();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "RenameWatcher tick 失敗（不中斷循環）");
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

        _logger.LogInformation("RenameWatcher 已停止");
    }

    [SupportedOSPlatform("windows")]
    private void TickWindows()
    {
        using var key = Registry.LocalMachine.OpenSubKey(RenameKeyPath, writable: true);
        if (key == null) return;

        var pendingObj = key.GetValue("Pending");
        if (pendingObj is not int pending || pending != 1) return;

        var newName = (key.GetValue("NewName") as string)?.Trim();
        var renameId = key.GetValue("RenameId") as string;

        if (string.IsNullOrEmpty(newName))
        {
            _logger.LogWarning("Rename Pending=1 但缺少 NewName，跳過");
            key.SetValue("Pending", 0, RegistryValueKind.DWord);
            return;
        }

        // 已是目標名 → 無需重命名（避免多餘的待重啟狀態）
        if (string.Equals(Environment.MachineName, newName, StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation("Rename: 當前名稱已是 {Name}，跳過", newName);
            key.SetValue("Pending", 0, RegistryValueKind.DWord);
            return;
        }

        _logger.LogInformation(
            "Rename 偵測到重命名請求: newName={NewName} renameId={RenameId} current={Current}",
            newName, renameId, Environment.MachineName);

        var success = RenameComputer(newName);

        // 無論成功與否清 Pending（失敗由 backend reconcile 下次上報重派；避免同名死循環）
        key.SetValue("Pending", 0, RegistryValueKind.DWord);

        if (success)
        {
            _logger.LogInformation(
                "Rename 已套用（下次 reboot 生效）: newName={NewName}", newName);
        }
        else
        {
            _logger.LogError("Rename 失敗: newName={NewName}", newName);
        }
    }

    /// <summary>
    /// 跑 Rename-Computer 重命名本機（workgroup 設備以 LocalSystem 執行無需憑證）。
    /// 改動落 SAM / registry，實際 hostname 於下次 reboot 生效（不自動重啟）。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private bool RenameComputer(string newName)
    {
        try
        {
            // 名稱由 backend assertValidComputerName 驗過（僅字母數字 + 連字號），無注入風險。
            var psi = new ProcessStartInfo(
                "powershell.exe",
                $"-NoProfile -ExecutionPolicy Bypass -Command \"Rename-Computer -NewName '{newName}' -Force -ErrorAction Stop\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null)
            {
                _logger.LogError("Rename: 無法啟動 powershell 進程");
                return false;
            }
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            if (!proc.WaitForExit(30_000))
            {
                proc.Kill();
                _logger.LogError("Rename: Rename-Computer 超時");
                return false;
            }
            if (proc.ExitCode != 0)
            {
                _logger.LogError(
                    "Rename: Rename-Computer 失敗 exit={ExitCode} stderr={Stderr}",
                    proc.ExitCode, stderr);
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Rename: Rename-Computer 異常");
            return false;
        }
    }
}
