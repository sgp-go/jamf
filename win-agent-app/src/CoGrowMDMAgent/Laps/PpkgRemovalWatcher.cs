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
            // Win10 22H2 Remove-ProvisioningPackage (实际是 Uninstall-ProvisioningPackage alias) 不支持
            // -ForceRemoval 参数，只接 -PackageId。pipe object 不会绑定到 -PackageId（必须 ByValue），
            // 所以用 ForEach-Object 显式取 PackageId 调用。
            // 兜底：若 cmdlet 仍报 NullRef（已知半移除状态 bug），直接删 .ppkg 文件 + AssetCache。
            //
            // ⚠️ Windows dedup PPKG by PackageID：即使 cmdlet 卸了 + .ppkg 文件删了，PackageID 仍残留
            // 在 Provisioning\PackageInfo / Results / CommandResults / Multivariant\CachedCRCs /
            // EnterpriseResourceManager\Tracked / PolicyManager\Providers / Enrollments\{ID} 多处
            // 注册表。下次同一 PackageID 的 PPKG 再装会 short-circuit 跳过 enrollment workflow，
            // 导致 enroll 失败但用户看 PPKG installed=1。所以这里**主动清掉所有 dedup cache**。
            var matchFilter = string.IsNullOrEmpty(filter)
                ? "$true"
                : $"$_.PackageName -like '*{filter}*'";
            var script =
                "$ErrorActionPreference='SilentlyContinue';" +
                // 先收集匹配的 PackageID（清完后还要用 ID 去抹 dedup 残留）
                $"$ids = @(Get-ProvisioningPackage -AllInstalledPackages | Where-Object {{ {matchFilter} }} | ForEach-Object {{ $_.PackageId.ToString().Trim('{{','}}').ToLower() }});" +
                $"Get-ProvisioningPackage -AllInstalledPackages | Where-Object {{ {matchFilter} }} | ForEach-Object {{" +
                "  Uninstall-ProvisioningPackage -PackageId $_.PackageId -ErrorAction SilentlyContinue;" +
                "  $stagePath = Join-Path 'C:\\ProgramData\\Microsoft\\Provisioning' ($_.PackageName + '.ppkg');" +
                "  if (Test-Path $stagePath) { Remove-Item $stagePath -Force -ErrorAction SilentlyContinue };" +
                "  if (Test-Path $_.PackagePath) { Remove-Item $_.PackagePath -Force -ErrorAction SilentlyContinue }" +
                "};" +
                "Remove-Item 'C:\\ProgramData\\Microsoft\\Provisioning\\AssetCache' -Recurse -Force -ErrorAction SilentlyContinue;" +
                // 抹 dedup cache: 对每个 PackageID 清掉 Windows 内部缓存的 8 处占位
                "foreach ($id in $ids) {" +
                "  $upper = $id.ToUpper();" +
                "  $bid = '{' + $id + '}';" +
                // ⚠️ 不清 HKLM\Microsoft\Enrollments\{ID}：那是当前 enrollment record，
                // 删它会让 ADMX engine 反应清掉 implementing-side（HKLM\Software\CoGrow\Agent\*\Pending），
                // 后续 SelfUninstall\Pending 信号消失，msiexec /x 不会被 SelfUninstallWatcher 触发。
                // Enrollments\{ID} 由 DMClient/Unenroll 命令在 unenroll 链结尾撤销，PpkgRemoval 不该碰。
                "  $paths = @(" +
                "    \"HKLM:\\SOFTWARE\\Microsoft\\EnterpriseResourceManager\\Tracked\\$id\"," +
                "    \"HKLM:\\SOFTWARE\\Microsoft\\PolicyManager\\Providers\\$id\"," +
                "    \"HKLM:\\SOFTWARE\\Microsoft\\Provisioning\\PackageInfo\\$bid\"," +
                "    \"HKLM:\\SOFTWARE\\Microsoft\\Provisioning\\Results\\$bid\"," +
                "    \"HKLM:\\SOFTWARE\\Microsoft\\Provisioning\\CommandResults\\DeviceContext\\$bid\"," +
                "    \"HKLM:\\SOFTWARE\\Microsoft\\Multivariant\\Status\\CachedCRCs\\RunTime\\$bid\"" +
                "  );" +
                "  foreach ($p in $paths) { if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue } };" +
                // knob value 也清（OOBE/Desktop/HideOobe_WinningProvider 存的 PackageID）
                "  $knob = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\knobs' -ErrorAction SilentlyContinue;" +
                "  if ($knob) {" +
                "    $knob.PSObject.Properties | Where-Object { $_.Value -eq $id } | ForEach-Object {" +
                "      Remove-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\PolicyManager\\current\\device\\knobs' -Name $_.Name -ErrorAction SilentlyContinue" +
                "    }" +
                "  };" +
                // OOBEPackage value 清
                "  $oobe = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Provisioning\\OOBEPackage' -ErrorAction SilentlyContinue;" +
                "  if ($oobe -and $oobe.PackageId -match $id) { Remove-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Provisioning\\OOBEPackage' -Name 'PackageId' -ErrorAction SilentlyContinue };" +
                "  Write-Output (\"cleaned_dedup_id=\" + $id)" +
                "}";

            // 用 -EncodedCommand (base64 UTF-16LE) 傳 script，避開 PowerShell -Command 對嵌套
            // " 字符的脆弱 escape 處理。否則複雜 script 內的 array of strings 會被 PowerShell
            // parser 在 line:1 char:N 處報語法錯（路徑字串 unquoted 被當成裸 token）。
            var encoded = Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(script));
            var psi = new ProcessStartInfo("powershell", $"-NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}")
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
