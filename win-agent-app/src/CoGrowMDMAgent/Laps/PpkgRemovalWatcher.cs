using System.Diagnostics;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Laps;

/// <summary>
/// 監控預配套件移除指令 Registry 信箱。
///
/// ADMX Policy CSP 落點：HKLM\Software\CoGrow\Agent\RemovePpkg
///   Pending (DWORD)            — 1=待執行, 0=已完成
///   PackageNameFilter (REG_SZ) — 套件名稱過濾（空=移除所有非系統 PPKG）
///
/// 模式同 LapsWatcher：2s 輪詢。非 Windows 平台 no-op。
/// </summary>
public sealed class PpkgRemovalWatcher : BackgroundService
{
    private const string KeyPath = @"SOFTWARE\CoGrow\Agent\RemovePpkg";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

    private readonly ILogger<PpkgRemovalWatcher> _logger;

    public PpkgRemovalWatcher(ILogger<PpkgRemovalWatcher> logger) => _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("PpkgRemovalWatcher: 非 Windows 平台，停用");
            return;
        }

        _logger.LogInformation("PpkgRemovalWatcher 啟動");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                TickWindows();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "PpkgRemovalWatcher tick 失敗");
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
        using var key = Registry.LocalMachine.OpenSubKey(KeyPath, writable: true);
        if (key == null) return;

        var pendingObj = key.GetValue("Pending");
        if (pendingObj is not int pending || pending != 1) return;

        var filter = key.GetValue("PackageNameFilter") as string ?? "";

        _logger.LogInformation("偵測到預配套件移除請求: filter={Filter}", filter);

        var success = RemoveProvisioningPackages(filter);

        key.SetValue("Pending", 0, RegistryValueKind.DWord);

        if (success)
            _logger.LogInformation("預配套件移除完成");
        else
            _logger.LogWarning("預配套件移除部分或全部失敗");
    }

    [SupportedOSPlatform("windows")]
    private bool RemoveProvisioningPackages(string filter)
    {
        try
        {
            var script = string.IsNullOrEmpty(filter)
                ? "Get-ProvisioningPackage -AllInstalledPackages | Remove-ProvisioningPackage -ForceRemoval -ErrorAction SilentlyContinue"
                : $"Get-ProvisioningPackage -AllInstalledPackages | Where-Object {{ $_.PackageName -like '*{filter}*' }} | Remove-ProvisioningPackage -ForceRemoval -ErrorAction SilentlyContinue";

            var psi = new ProcessStartInfo("powershell", $"-NoProfile -ExecutionPolicy Bypass -Command \"{script}\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            using var proc = Process.Start(psi);
            if (proc is null)
            {
                _logger.LogError("無法啟動 powershell 進程");
                return false;
            }

            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            if (!proc.WaitForExit(30_000))
            {
                proc.Kill();
                _logger.LogError("powershell 超時");
                return false;
            }

            if (!string.IsNullOrEmpty(stderr))
                _logger.LogWarning("PPKG removal stderr: {Stderr}", stderr);
            if (!string.IsNullOrEmpty(stdout))
                _logger.LogInformation("PPKG removal stdout: {Stdout}", stdout);

            return proc.ExitCode == 0;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PPKG removal 異常");
            return false;
        }
    }
}
