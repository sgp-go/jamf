using System.Diagnostics;
using System.Runtime.Versioning;
using System.ServiceProcess;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.OsServices;

/// <summary>
/// 週期監控 Windows 內建服務 <c>dmwappushservice</c>，發現 Stopped 就主動 Start。
///
/// <para>為什麼要這條 keepalive：</para>
/// <c>dmwappushservice</c> 是 OMA-DM push 消息 dispatcher，MDM/EDA-CSP 收到 BITS 下載
/// 完成 / msiexec 執行完成的內部回調都靠它 route。Windows 24H2 上這個服務啟動類型
/// 是 Automatic 但**帶 trigger-start**（有 push 才起），閒置一段時間後 SCM 會把它停掉。
/// 一旦在 BITS 下載完成的瞬間它是 stopped，callback 就丟失 → EDA-CSP job 卡在
/// Status=20 (Downloading) 永不推進 → BITS 90min 後把 orphan job 清掉 → 派發永遠不會
/// 進到 install 階段。（2026-07-02 真機 PF5XSMN1 抓到，1.4.0.17 派發卡住 root cause。）
///
/// <para>設計選擇：</para>
/// - 只 Start（不改 StartType）：不動 Windows 服務組態，避免影響其他 MDM stack；
///   閒置後 SCM 若再次停掉，下個 check 週期會重新拉起。
/// - Interval 30 秒：Win11 24H2 上 SCM 停 dmwappushservice 極為激進（真機 PF5XSMN1
///   實測 3-6 min 就會被停一次）。3 min tick 曾在 BITS 下載完成的最後幾百 KB 窗口
///   撞上 dmwapp Stopped → callback 丟失 → job orphan。縮到 30 秒把「dmwapp 剛好
///   Stopped 的關鍵窗口」壓到很小，SC 查詢輕量（Query API + 一個 named pipe RPC），
///   log 噪音靠 LogDebug 隱藏（EventLog 只落 Warning）。
/// - 非 Windows no-op：CI/dev 平台照樣起 host。
/// </summary>
public sealed class DmwappushKeepaliveService : BackgroundService
{
    private const string ServiceName = "dmwappushservice";
    /// <summary>PPKG ProvisioningCommands 建的 fallback scheduled task 名，
    /// Agent 起來後由 keepalive service 接管，刪掉此 task 避免雙寫。
    /// 名字必須跟 <c>app/services/admin/enrollment-ppkg.ts</c>
    /// <c>renderProvisioningCommandsSection</c> 裡 <c>schtasks /Create /TN ...</c> 保持一致。</summary>
    private const string PpkgFallbackTaskName = "CoGrowDmwappKeepalive";
    private static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(30);

    private readonly ILogger<DmwappushKeepaliveService> _logger;

    public DmwappushKeepaliveService(ILogger<DmwappushKeepaliveService> logger)
    {
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("Not on Windows; DmwappushKeepalive is no-op");
            return;
        }

        _logger.LogInformation(
            "DmwappushKeepalive started; check interval = {Interval}",
            CheckInterval);

        // 首次啟動接管 PPKG 建的 fallback scheduled task（首次 enroll 場景 Agent 未裝時
        // PPKG ProvisioningCommands 建立此 task 每 1min 拉起 dmwapp，Agent 裝完後由本
        // BackgroundService 接管更即時的 30s check，刪掉 task 避免雙寫）。
        // 失敗（task 不存在）靜默忽略——正常 EDA-CSP 派發升級路徑本來就沒這個 task。
        TryDeletePpkgFallbackTask();

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                EnsureRunning();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "DmwappushKeepalive check failed (non-fatal, will retry)");
            }

            try
            {
                await Task.Delay(CheckInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    [SupportedOSPlatform("windows")]
    private void EnsureRunning()
    {
        using var sc = new ServiceController(ServiceName);
        var status = sc.Status;

        if (status == ServiceControllerStatus.Running)
        {
            _logger.LogDebug("{Service} already running", ServiceName);
            return;
        }

        if (status == ServiceControllerStatus.StartPending)
        {
            _logger.LogDebug("{Service} start pending; skipping", ServiceName);
            return;
        }

        _logger.LogWarning(
            "{Service} is {Status}; starting to keep EDA-CSP / OMA-DM callbacks alive",
            ServiceName, status);

        sc.Start();
        sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(15));
        _logger.LogInformation("{Service} started successfully", ServiceName);
    }

    private void TryDeletePpkgFallbackTask()
    {
        try
        {
            var psi = new ProcessStartInfo("schtasks.exe", $"/Delete /TN {PpkgFallbackTaskName} /F")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return;
            if (!proc.WaitForExit(5000)) { proc.Kill(); return; }
            if (proc.ExitCode == 0)
            {
                _logger.LogInformation(
                    "Deleted PPKG fallback scheduled task '{Task}'; keepalive service now owns dmwapp check",
                    PpkgFallbackTaskName);
            }
            // ExitCode != 0（task 不存在）預期常見——EDA-CSP 派發升級路徑沒此 task，
            // 靜默忽略避免 log 噪音。
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "TryDeletePpkgFallbackTask ignored (probe failure)");
        }
    }
}
