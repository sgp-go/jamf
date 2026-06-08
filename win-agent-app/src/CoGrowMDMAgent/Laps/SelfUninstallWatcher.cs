using System.Diagnostics;
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
/// </summary>
public sealed class SelfUninstallWatcher : BackgroundService
{
    private const string KeyPath = @"SOFTWARE\CoGrow\Agent\SelfUninstall";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

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
        using var key = Registry.LocalMachine.OpenSubKey(KeyPath, writable: true);
        if (key == null) return;

        var pendingObj = key.GetValue("Pending");
        if (pendingObj is not int pending || pending != 1) return;

        _logger.LogInformation("偵測到自卸載請求");

        key.SetValue("Pending", 0, RegistryValueKind.DWord);

        var productCode = FindProductCode();
        if (string.IsNullOrEmpty(productCode))
        {
            _logger.LogError("找不到 CoGrow MDM Agent 的 ProductCode，無法自卸載");
            return;
        }

        _logger.LogInformation("啟動自卸載: ProductCode={ProductCode}", productCode);

        var psi = new ProcessStartInfo("msiexec", $"/x {productCode} /qn /norestart")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        };
        Process.Start(psi);
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
