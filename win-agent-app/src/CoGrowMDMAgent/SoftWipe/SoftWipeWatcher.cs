using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Reporting;
using Microsoft.Win32;

namespace CoGrowMDMAgent.SoftWipe;

/// <summary>
/// 監控 SoftWipe Registry 信箱，偵測到 Trigger=1 後執行深度清理。
///
/// ADMX Policy CSP 落點：HKLM\Software\CoGrow\Agent\SoftWipe
///   Trigger (DWORD)          — 1=待執行, 0=已完成 / 未觸發
///   WhitelistJson (REG_SZ)   — 白名單 JSON: {msiProductCodes:[], uwpPfns:[], wingetIds:[]}
///   WipeId (REG_SZ)          — 唯一 wipe ID（回報對帳）
///
/// 清理範圍（依 white-list 過濾）：
///   1. 卸載非白名單 MSI（msiexec /x {GUID} /qn /norestart）
///   2. 卸載非白名單 UWP（Get-AppxPackage | Remove-AppxPackage -AllUsers）
///   3. 刪除所有非 admin user profile（net user /delete + Remove-Item C:\Users\<>）
///   4. 清當前 admin user 的 Desktop / Documents / Downloads / Pictures / Videos / Music 內容
///   5. 清瀏覽器數據（Edge / Chrome 每個 user profile 下的 cache / cookies / history）
///   6. 清 Recycle Bin + Temp 目錄
///
/// **保留**：Windows 系統 / CoGrow Agent / MDM 派發的 App / MDM enrollment。
///
/// 完成後上報 POST /agent/soft-wipe-result 並清 Trigger（防重放）。
/// </summary>
public sealed class SoftWipeWatcher : BackgroundService
{
    private const string SoftWipeKeyPath = @"SOFTWARE\CoGrow\Agent\SoftWipe";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

    private readonly ILogger<SoftWipeWatcher> _logger;
    private readonly AgentConfigProvider _configProvider;
    private readonly DeviceFactsCollector _facts;
    private readonly HttpClient _http;

    public SoftWipeWatcher(
        ILogger<SoftWipeWatcher> logger,
        AgentConfigProvider configProvider,
        DeviceFactsCollector facts,
        HttpClient http)
    {
        _logger = logger;
        _configProvider = configProvider;
        _facts = facts;
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(60);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("SoftWipeWatcher: 非 Windows 平台，停用（dev no-op）");
            return;
        }

        _logger.LogInformation("SoftWipeWatcher 啟動，輪詢間隔 {Seconds}s", PollInterval.TotalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "SoftWipeWatcher tick 失敗（不中斷循環）");
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

        _logger.LogInformation("SoftWipeWatcher 已停止");
    }

    [SupportedOSPlatform("windows")]
    private async Task TickAsync(CancellationToken ct)
    {
        var payload = ReadTrigger();
        if (payload == null) return;

        _logger.LogWarning(
            "SoftWipe 觸發：wipeId={WipeId}, whitelist msi={Msi} uwp={Uwp} winget={Winget}",
            payload.WipeId,
            payload.Whitelist.MsiProductCodes.Count,
            payload.Whitelist.UwpPfns.Count,
            payload.Whitelist.WingetIds.Count);

        // 立即清 Trigger 防重放（並發 Agent restart 場景避免二次執行）
        ClearTrigger();

        var summary = new SoftWipeSummary();
        var errors = new List<string>();
        var sw = Stopwatch.StartNew();

        try { UninstallNonWhitelistMsi(payload.Whitelist, summary, errors); }
        catch (Exception ex) { errors.Add($"MSI phase: {ex.Message}"); _logger.LogError(ex, "MSI 卸載階段異常"); }

        try { UninstallNonWhitelistUwp(payload.Whitelist, summary, errors); }
        catch (Exception ex) { errors.Add($"UWP phase: {ex.Message}"); _logger.LogError(ex, "UWP 卸載階段異常"); }

        try { DeleteNonAdminUserProfiles(summary, errors); }
        catch (Exception ex) { errors.Add($"UserProfile phase: {ex.Message}"); _logger.LogError(ex, "User profile 刪除階段異常"); }

        try { ClearCurrentAdminUserDirs(summary); }
        catch (Exception ex) { errors.Add($"AdminDirs phase: {ex.Message}"); _logger.LogError(ex, "Admin 用戶目錄清理階段異常"); }

        try { ClearBrowserData(summary); }
        catch (Exception ex) { errors.Add($"Browser phase: {ex.Message}"); _logger.LogError(ex, "瀏覽器數據清理階段異常"); }

        try { ClearRecycleBinAndTemp(summary); }
        catch (Exception ex) { errors.Add($"RecycleBin phase: {ex.Message}"); _logger.LogError(ex, "Recycle Bin / Temp 清理階段異常"); }

        sw.Stop();

        var status = errors.Count == 0
            ? SoftWipeStatus.Success
            : (summary.MsiUninstalled + summary.UwpUninstalled + summary.UserProfilesDeleted > 0
                ? SoftWipeStatus.Partial
                : SoftWipeStatus.Failed);

        _logger.LogWarning(
            "SoftWipe 完成: status={Status} durationMs={Duration} msi={MsiOk}/{MsiFail} uwp={UwpOk}/{UwpFail} profiles={ProfOk}/{ProfFail}",
            status, sw.ElapsedMilliseconds,
            summary.MsiUninstalled, summary.MsiFailed,
            summary.UwpUninstalled, summary.UwpFailed,
            summary.UserProfilesDeleted, summary.UserProfilesFailed);

        await ReportAsync(payload.WipeId, status, summary, sw.ElapsedMilliseconds, errors, ct);
    }

    // ============================================================
    // Registry read / write
    // ============================================================

    [SupportedOSPlatform("windows")]
    private SoftWipePayload? ReadTrigger()
    {
        using var key = Registry.LocalMachine.OpenSubKey(SoftWipeKeyPath, writable: false);
        if (key == null) return null;

        if (key.GetValue("Trigger") is not int trigger || trigger != 1) return null;

        var whitelistJson = key.GetValue("WhitelistJson") as string;
        var wipeId = key.GetValue("WipeId") as string;
        if (string.IsNullOrEmpty(whitelistJson) || string.IsNullOrEmpty(wipeId))
        {
            _logger.LogWarning("SoftWipe Trigger=1 但缺少 WhitelistJson/WipeId，跳過");
            return null;
        }

        try
        {
            var whitelist = JsonSerializer.Deserialize<SoftWipeWhitelist>(
                whitelistJson, JsonOptions);
            if (whitelist == null)
            {
                _logger.LogWarning("SoftWipe: whitelist JSON 反序列化為 null");
                return null;
            }
            return new SoftWipePayload
            {
                WipeId = wipeId,
                Whitelist = whitelist,
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SoftWipe: whitelist JSON 解析失敗");
            return null;
        }
    }

    [SupportedOSPlatform("windows")]
    private void ClearTrigger()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(SoftWipeKeyPath, writable: true);
            key?.SetValue("Trigger", 0, RegistryValueKind.DWord);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SoftWipe: 清 Trigger 失敗");
        }
    }

    // ============================================================
    // Phase 1: 卸載非白名單 MSI
    // ============================================================

    [SupportedOSPlatform("windows")]
    private void UninstallNonWhitelistMsi(
        SoftWipeWhitelist whitelist,
        SoftWipeSummary summary,
        List<string> errors)
    {
        var whitelistSet = new HashSet<string>(
            whitelist.MsiProductCodes.Select(NormalizeGuid),
            StringComparer.OrdinalIgnoreCase);

        // 從 registry 掃 Uninstall 列出所有 MSI ProductCode + UninstallString
        var installed = EnumerateInstalledMsi();
        _logger.LogInformation("SoftWipe MSI 掃描: 找到 {Count} 個安裝項", installed.Count);

        foreach (var app in installed)
        {
            if (whitelistSet.Contains(NormalizeGuid(app.ProductCode)))
            {
                _logger.LogDebug("SoftWipe MSI 白名單保留: {Name} {Guid}", app.DisplayName, app.ProductCode);
                continue;
            }

            _logger.LogInformation(
                "SoftWipe MSI 卸載: {Name} {Guid}", app.DisplayName, app.ProductCode);
            if (UninstallMsi(app.ProductCode))
            {
                summary.MsiUninstalled++;
            }
            else
            {
                summary.MsiFailed++;
                errors.Add($"MSI 卸載失敗: {app.DisplayName} ({app.ProductCode})");
            }
        }
    }

    [SupportedOSPlatform("windows")]
    private List<InstalledApp> EnumerateInstalledMsi()
    {
        var result = new List<InstalledApp>();
        string[] uninstallPaths =
        {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        };

        foreach (var path in uninstallPaths)
        {
            using var key = Registry.LocalMachine.OpenSubKey(path);
            if (key == null) continue;

            foreach (var subName in key.GetSubKeyNames())
            {
                using var sub = key.OpenSubKey(subName);
                if (sub == null) continue;
                var display = sub.GetValue("DisplayName") as string;
                if (string.IsNullOrEmpty(display)) continue;

                // 只處理 MSI 安裝（子鍵名是 GUID 格式 or 有 WindowsInstaller=1 flag）
                var isMsi = subName.StartsWith('{') && subName.EndsWith('}');
                if (!isMsi) continue;

                result.Add(new InstalledApp
                {
                    ProductCode = subName,
                    DisplayName = display,
                });
            }
        }
        return result;
    }

    [SupportedOSPlatform("windows")]
    private bool UninstallMsi(string productCode)
    {
        try
        {
            var psi = new ProcessStartInfo("msiexec.exe", $"/x {productCode} /qn /norestart")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return false;
            if (!proc.WaitForExit(180_000)) // 3 min per MSI
            {
                proc.Kill();
                _logger.LogWarning("SoftWipe MSI 卸載超時: {Guid}", productCode);
                return false;
            }
            // 0 = success, 3010 = success needs reboot
            return proc.ExitCode == 0 || proc.ExitCode == 3010;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SoftWipe MSI 卸載異常: {Guid}", productCode);
            return false;
        }
    }

    // ============================================================
    // Phase 2: 卸載非白名單 UWP
    // ============================================================

    [SupportedOSPlatform("windows")]
    private void UninstallNonWhitelistUwp(
        SoftWipeWhitelist whitelist,
        SoftWipeSummary summary,
        List<string> errors)
    {
        // whitelist.UwpPfns 可能是完整 PFN 或系統前綴（如 Microsoft.WindowsCalculator）；
        // 用前綴匹配容錯（PFN 含 publisher hash 後綴）
        var prefixes = whitelist.UwpPfns.ToList();

        // 透過 PowerShell Get-AppxPackage 列所有 UWP，過濾非白名單
        // Remove-AppxPackage -AllUsers 需 SYSTEM 權限
        var psScript = @"
$prefixes = @(" + string.Join(",", prefixes.Select(p => $"'{p.Replace("'", "''")}'")) + @")
$whitelistCheck = { param($name) foreach ($p in $prefixes) { if ($name -like ""$p*"") { return $true } } return $false }
$results = @()
Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue | ForEach-Object {
  # 保留：系統 Framework / ResourcePackage / 白名單前綴
  if ($_.IsFramework -or $_.IsResourcePackage) { return }
  if ($_.SignatureKind -eq 'System') { return }  # Windows 內建系統包
  if (& $whitelistCheck $_.Name) { return }
  try {
    Remove-AppxPackage -AllUsers -Package $_.PackageFullName -ErrorAction Stop
    $results += ""OK|$($_.Name)""
  } catch {
    $results += ""FAIL|$($_.Name)|$($_.Exception.Message)""
  }
}
$results -join ""``n""
";
        var (ok, output) = RunPowerShell(psScript, 300_000);
        if (!ok)
        {
            errors.Add($"UWP script 執行失敗: {output}");
            return;
        }

        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.StartsWith("OK|", StringComparison.Ordinal))
            {
                summary.UwpUninstalled++;
                _logger.LogInformation("SoftWipe UWP 已卸: {Name}", line.Substring(3));
            }
            else if (line.StartsWith("FAIL|", StringComparison.Ordinal))
            {
                summary.UwpFailed++;
                _logger.LogWarning("SoftWipe UWP 卸載失敗: {Line}", line);
            }
        }
    }

    // ============================================================
    // Phase 3: 刪除所有非 admin user profile
    // ============================================================

    [SupportedOSPlatform("windows")]
    private void DeleteNonAdminUserProfiles(SoftWipeSummary summary, List<string> errors)
    {
        // 保留的 built-in / admin：ITAdmin / Administrator / Public / Default / All Users / defaultuser0
        // 保留當前 Agent service 進程對應的 user（實際上 SYSTEM，Users 下不存在）
        var currentAdminName = Environment.UserName;
        var preserveSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Administrator",
            "ITAdmin",
            "Public",
            "Default",
            "Default User",
            "All Users",
            "defaultuser0",
            currentAdminName,
        };

        // 掃 C:\Users\* 目錄
        var usersDir = Path.Combine(Environment.GetEnvironmentVariable("SystemDrive") ?? "C:", @"\Users").Replace(":\\Users", ":\\Users");
        var actualUsersDir = @"C:\Users";
        if (!Directory.Exists(actualUsersDir))
        {
            _logger.LogWarning("SoftWipe: C:\\Users 目錄不存在");
            return;
        }

        foreach (var dir in Directory.GetDirectories(actualUsersDir))
        {
            var name = Path.GetFileName(dir);
            if (preserveSet.Contains(name)) continue;

            _logger.LogInformation("SoftWipe 刪除 user profile: {Name} at {Path}", name, dir);

            // 1. net user /delete（刪 local account，若存在的話）
            RunProcess("net", $"user \"{name}\" /delete", 30_000, ignoreExit: true);

            // 2. WMI 刪 UserProfile registry entry + 目錄
            //    走 Win32_UserProfile 是最乾淨方式，但 SYSTEM 上 WMI 對某些鎖住的 profile 會 fail
            //    退化到 Remove-Item -Recurse -Force
            var wmiOk = TryRemoveWmiProfile(name);

            var removed = false;
            if (Directory.Exists(dir))
            {
                try
                {
                    ForceDeleteDirectory(dir);
                    removed = true;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "SoftWipe: profile 目錄刪除失敗 {Path}", dir);
                }
            }
            else
            {
                removed = wmiOk; // WMI 已把目錄一起清了
            }

            if (removed)
            {
                summary.UserProfilesDeleted++;
            }
            else
            {
                summary.UserProfilesFailed++;
                errors.Add($"UserProfile 刪除失敗: {name}");
            }
        }
    }

    [SupportedOSPlatform("windows")]
    private bool TryRemoveWmiProfile(string userName)
    {
        try
        {
            // Get-WmiObject Win32_UserProfile | ? { $_.LocalPath -like "*\<userName>" } | Remove-WmiObject
            var script = $@"
$p = Get-CimInstance Win32_UserProfile -Filter ""Special=$false"" | Where-Object {{ $_.LocalPath -like ""*\{userName.Replace("\"", "\\\"")}"" }}
if ($p) {{
  $p | Remove-CimInstance -ErrorAction Stop
  Write-Output 'REMOVED'
}} else {{
  Write-Output 'NOT_FOUND'
}}
";
            var (ok, output) = RunPowerShell(script, 30_000);
            return ok && output.Contains("REMOVED", StringComparison.Ordinal);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "SoftWipe: WMI 刪 profile 失敗 {User}", userName);
            return false;
        }
    }

    private static void ForceDeleteDirectory(string path)
    {
        // 清 ReadOnly attributes 然後 Remove（Windows profile 目錄常有 read-only 文件）
        foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
        {
            try { File.SetAttributes(file, FileAttributes.Normal); } catch { }
        }
        Directory.Delete(path, recursive: true);
    }

    // ============================================================
    // Phase 4: 清當前 admin user 目錄內容（保留 profile 本身）
    // ============================================================

    [SupportedOSPlatform("windows")]
    private void ClearCurrentAdminUserDirs(SoftWipeSummary summary)
    {
        // Agent service 跑在 LocalSystem context (`C:\Windows\System32\config\systemprofile`)，
        // Environment.UserName 是 SYSTEM。實際使用中的 admin (ITAdmin) 我們不確定哪個是「當前」，
        // 所以掃 preserveSet 裡剩下的 admin profile 一一清內容。
        var preserveButClear = new[] { "ITAdmin", "Administrator" };
        foreach (var admin in preserveButClear)
        {
            var profilePath = Path.Combine(@"C:\Users", admin);
            if (!Directory.Exists(profilePath)) continue;

            string[] targets = { "Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music" };
            foreach (var t in targets)
            {
                var dir = Path.Combine(profilePath, t);
                if (!Directory.Exists(dir)) continue;
                try
                {
                    foreach (var entry in Directory.EnumerateFileSystemEntries(dir))
                    {
                        try
                        {
                            if (File.Exists(entry))
                            {
                                File.SetAttributes(entry, FileAttributes.Normal);
                                File.Delete(entry);
                            }
                            else if (Directory.Exists(entry))
                            {
                                ForceDeleteDirectory(entry);
                            }
                        }
                        catch (Exception ex)
                        {
                            _logger.LogDebug(ex, "SoftWipe: 清 {Dir} 內項 {Entry} 失敗", dir, entry);
                        }
                    }
                    _logger.LogInformation("SoftWipe 清空 {Dir} 完成", dir);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "SoftWipe: 清 {Dir} 異常", dir);
                }
            }
        }
    }

    // ============================================================
    // Phase 5: 清瀏覽器數據
    // ============================================================

    [SupportedOSPlatform("windows")]
    private void ClearBrowserData(SoftWipeSummary summary)
    {
        // Edge / Chrome 每 user 一份 profile；掃 C:\Users\*\AppData\Local\...
        var usersRoot = @"C:\Users";
        if (!Directory.Exists(usersRoot)) return;

        string[] browserRelPaths =
        {
            @"AppData\Local\Microsoft\Edge\User Data\Default", // Edge Chromium
            @"AppData\Local\Google\Chrome\User Data\Default",   // Chrome
            @"AppData\Local\BraveSoftware\Brave-Browser\User Data\Default", // Brave（bonus）
        };

        // 每個 profile 下要清的子項（保留 profile 骨架，只清 cache/cookies/history/downloads）
        string[] itemsToDelete =
        {
            "Cache", "Code Cache", "GPUCache", "Media Cache", // caches
            "Cookies", "Cookies-journal",
            "History", "History-journal",
            "Login Data", "Login Data-journal",
            "Web Data", "Web Data-journal",
            "Top Sites", "Top Sites-journal",
            "Sessions", "Session Storage",
            "IndexedDB", "Local Storage",
            "Service Worker",
            "History Provider Cache",
            "Network", // Chromium 148+ 移到這下面
        };

        var any = false;
        foreach (var userDir in Directory.GetDirectories(usersRoot))
        {
            foreach (var rel in browserRelPaths)
            {
                var profileDir = Path.Combine(userDir, rel);
                if (!Directory.Exists(profileDir)) continue;
                any = true;
                foreach (var item in itemsToDelete)
                {
                    var full = Path.Combine(profileDir, item);
                    try
                    {
                        if (File.Exists(full)) File.Delete(full);
                        else if (Directory.Exists(full)) ForceDeleteDirectory(full);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogDebug(ex, "SoftWipe browser 清 {Path} 失敗", full);
                    }
                }
            }
        }
        summary.BrowserDataCleared = true; // 執行過就標 true（沒瀏覽器裝也 vacuously true）
        _logger.LogInformation("SoftWipe 瀏覽器數據清完（found browsers={Found}）", any);
    }

    // ============================================================
    // Phase 6: 清 Recycle Bin + Temp
    // ============================================================

    [SupportedOSPlatform("windows")]
    private void ClearRecycleBinAndTemp(SoftWipeSummary summary)
    {
        // Clear-RecycleBin -Force（PS 5.1+）
        var (rbOk, _) = RunPowerShell("Clear-RecycleBin -Force -ErrorAction SilentlyContinue", 60_000);
        summary.RecycleBinCleared = rbOk;

        // Temp 目錄：%WINDIR%\Temp + 各 user 的 AppData\Local\Temp
        var tempPaths = new List<string>
        {
            Path.Combine(Environment.GetEnvironmentVariable("WINDIR") ?? @"C:\Windows", "Temp"),
        };
        var usersRoot = @"C:\Users";
        if (Directory.Exists(usersRoot))
        {
            foreach (var userDir in Directory.GetDirectories(usersRoot))
            {
                tempPaths.Add(Path.Combine(userDir, @"AppData\Local\Temp"));
            }
        }

        foreach (var tp in tempPaths)
        {
            if (!Directory.Exists(tp)) continue;
            try
            {
                foreach (var entry in Directory.EnumerateFileSystemEntries(tp))
                {
                    try
                    {
                        if (File.Exists(entry))
                        {
                            File.SetAttributes(entry, FileAttributes.Normal);
                            File.Delete(entry);
                        }
                        else if (Directory.Exists(entry))
                        {
                            ForceDeleteDirectory(entry);
                        }
                    }
                    catch { /* 進程佔用 / 權限拒絕，跳過 */ }
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "SoftWipe: 清 Temp {Path} 異常", tp);
            }
        }
        summary.TempCleared = true;
        _logger.LogInformation("SoftWipe Recycle Bin + Temp 清完");
    }

    // ============================================================
    // 上報結果
    // ============================================================

    private async Task ReportAsync(
        string wipeId,
        SoftWipeStatus status,
        SoftWipeSummary summary,
        long durationMs,
        List<string> errors,
        CancellationToken ct)
    {
        var config = _configProvider.Current;
        var serial = _facts.CollectSerialNumber();
        var payload = new SoftWipeResultPayload
        {
            WipeId = wipeId,
            SerialNumber = serial,
            Status = status switch
            {
                SoftWipeStatus.Success => "success",
                SoftWipeStatus.Partial => "partial",
                _ => "failed",
            },
            Summary = summary,
            DurationMs = durationMs,
            ErrorTail = errors.Count == 0
                ? null
                : string.Join(" | ", errors).Substring(
                    0, Math.Min(2000, string.Join(" | ", errors).Length)),
        };

        try
        {
            _http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", config.AgentToken);
            using var resp = await _http.PostAsJsonAsync(config.SoftWipeResultUrl, payload, JsonOptions, ct);
            if (!resp.IsSuccessStatusCode)
            {
                var body = await resp.Content.ReadAsStringAsync(ct);
                _logger.LogError(
                    "SoftWipe 上報失敗 {Status}: {Body}", resp.StatusCode, body);
            }
            else
            {
                _logger.LogInformation("SoftWipe 上報完成 wipeId={WipeId}", wipeId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SoftWipe 上報異常 wipeId={WipeId}", wipeId);
        }
    }

    // ============================================================
    // helpers
    // ============================================================

    private static string NormalizeGuid(string s)
    {
        var t = s.Trim();
        if (t.StartsWith('{') && t.EndsWith('}')) return t.ToUpperInvariant();
        return $"{{{t.ToUpperInvariant()}}}";
    }

    private (bool ok, string output) RunPowerShell(string script, int timeoutMs)
    {
        try
        {
            var psi = new ProcessStartInfo("powershell.exe",
                $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return (false, "process start failed");
            proc.StandardInput.Write(script);
            proc.StandardInput.Close();
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            if (!proc.WaitForExit(timeoutMs))
            {
                try { proc.Kill(); } catch { }
                return (false, "timeout");
            }
            var output = stdout + (string.IsNullOrEmpty(stderr) ? "" : $"\n[stderr]\n{stderr}");
            return (proc.ExitCode == 0, output);
        }
        catch (Exception ex)
        {
            return (false, $"exception: {ex.Message}");
        }
    }

    private void RunProcess(string cmd, string args, int timeoutMs, bool ignoreExit = false)
    {
        try
        {
            var psi = new ProcessStartInfo(cmd, args)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return;
            proc.WaitForExit(timeoutMs);
            if (!ignoreExit && proc.ExitCode != 0)
            {
                _logger.LogDebug("SoftWipe: {Cmd} {Args} 退出 {Exit}", cmd, args, proc.ExitCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "SoftWipe: {Cmd} {Args} 異常", cmd, args);
        }
    }

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

// ============================================================
// Types
// ============================================================

internal enum SoftWipeStatus { Success, Partial, Failed }

internal sealed record InstalledApp
{
    public required string ProductCode { get; init; }
    public required string DisplayName { get; init; }
}

/// <summary>Registry 讀出來的 payload。</summary>
internal sealed record SoftWipePayload
{
    public required string WipeId { get; init; }
    public required SoftWipeWhitelist Whitelist { get; init; }
}

internal sealed record SoftWipeWhitelist
{
    [JsonPropertyName("msiProductCodes")]
    public List<string> MsiProductCodes { get; init; } = new();

    [JsonPropertyName("uwpPfns")]
    public List<string> UwpPfns { get; init; } = new();

    [JsonPropertyName("wingetIds")]
    public List<string> WingetIds { get; init; } = new();
}

public sealed class SoftWipeSummary
{
    public int MsiUninstalled { get; set; }
    public int MsiFailed { get; set; }
    public int UwpUninstalled { get; set; }
    public int UwpFailed { get; set; }
    public int UserProfilesDeleted { get; set; }
    public int UserProfilesFailed { get; set; }
    public bool BrowserDataCleared { get; set; }
    public bool RecycleBinCleared { get; set; }
    public bool TempCleared { get; set; }
}

internal sealed record SoftWipeResultPayload
{
    [JsonPropertyName("wipeId")]
    public required string WipeId { get; init; }

    [JsonPropertyName("serialNumber")]
    public required string SerialNumber { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("summary")]
    public required SoftWipeSummary Summary { get; init; }

    [JsonPropertyName("durationMs")]
    public required long DurationMs { get; init; }

    [JsonPropertyName("errorTail")]
    public string? ErrorTail { get; init; }
}
