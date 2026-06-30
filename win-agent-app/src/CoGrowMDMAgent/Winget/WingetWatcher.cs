using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Reporting;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Winget;

/// <summary>
/// winget App 派發執行器。
///
/// 觸發來源：<see cref="OmaDmEventLogWatcher"/> 監聽到 OMA-DM session 啟動（EventLog
/// Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Operational
/// EventID=265）後，調 <see cref="RequestPollAsync"/> 喚醒本 watcher。
///
/// 流程：trigger → POST /agent/checkin → filter winget_install/uninstall actions →
/// spawn winget.exe → POST /agent/winget-result。
///
/// 設計：與 LapsWatcher / BitLockerWatcher 的 Registry 信箱模式不同，winget 沒有
/// 對應 ADMX Policy CSP，命令必須走 /agent/checkin pull。觸發來源解耦讓單測 /
/// 真機 fallback 都容易（缺 EventLog 訂閱也能用 30s 定時 poll 兜底）。
/// </summary>
public sealed class WingetWatcher : BackgroundService
{
    private static readonly TimeSpan FallbackPollInterval = TimeSpan.FromSeconds(180);
    private static readonly TimeSpan WingetExecTimeout = TimeSpan.FromMinutes(15);
    private const int StdoutTailBytes = 2048;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly IHttpClientFactory _httpFactory;
    private readonly AgentConfigProvider _configProvider;
    private readonly DeviceFactsCollector _facts;
    private readonly ILogger<WingetWatcher> _logger;

    /// <summary>
    /// 解析後的 winget.exe 絕對路徑。LocalSystem service 沒有 user profile，
    /// winget.exe 不在 PATH（per-user MSIX 安裝到 `%LOCALAPPDATA%\Microsoft\WindowsApps\`）。
    /// 需手動找 system-wide x64 binary 在 `C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__*\winget.exe`。
    /// 此值由 ResolveWingetExe() 啟動時一次性解析。
    /// </summary>
    private string? _wingetExePath;
    private readonly Channel<byte> _trigger = Channel.CreateBounded<byte>(
        new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
            SingleWriter = false,
        });

    public WingetWatcher(
        IHttpClientFactory httpFactory,
        AgentConfigProvider configProvider,
        DeviceFactsCollector facts,
        ILogger<WingetWatcher> logger)
    {
        _httpFactory = httpFactory;
        _configProvider = configProvider;
        _facts = facts;
        _logger = logger;
    }

    private HttpClient CreateClient()
    {
        var http = _httpFactory.CreateClient(nameof(WingetWatcher));
        http.Timeout = TimeSpan.FromSeconds(30);
        return http;
    }

    /// <summary>
    /// 外部觸發（OmaDmEventLogWatcher / startup / 手動）：要求 watcher 立即跑一次 checkin pull。
    /// Channel 容量 1 + DropWrite：高頻觸發只生效一次，避免雪崩。
    /// </summary>
    public void RequestPoll()
    {
        if (_trigger.Writer.TryWrite(0))
        {
            _logger.LogDebug("WingetWatcher poll triggered");
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("WingetWatcher: 非 Windows 平台，停用（dev no-op）");
            return;
        }

        _wingetExePath = ResolveWingetExe();
        if (_wingetExePath is null)
        {
            _logger.LogWarning(
                "找不到 winget.exe（PATH + WindowsApps glob 都失敗）。watcher 不退出，使用者後續裝上 App Installer 後可重啟 service 重新解析"
            );
        }
        else
        {
            _logger.LogInformation("winget.exe 路徑解析: {Path}", _wingetExePath);
        }

        _logger.LogInformation(
            "WingetWatcher 啟動（trigger=Channel + fallback poll {S}s）",
            FallbackPollInterval.TotalSeconds);

        // 啟動立即跑一次，撿任何 service 重啟前未完成的命令
        RequestPoll();

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // 等 trigger 或 fallback 計時器到期
                using var timer = new CancellationTokenSource(FallbackPollInterval);
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                    timer.Token, stoppingToken);
                try
                {
                    await _trigger.Reader.ReadAsync(linked.Token);
                }
                catch (OperationCanceledException) when (timer.IsCancellationRequested)
                {
                    _logger.LogDebug("WingetWatcher fallback tick");
                }

                if (stoppingToken.IsCancellationRequested) break;
                await PollAndExecuteAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "WingetWatcher tick 失敗（不中斷循環）");
                try { await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken); }
                catch (OperationCanceledException) { break; }
            }
        }

        _logger.LogInformation("WingetWatcher 已停止");
    }

    [SupportedOSPlatform("windows")]
    private async Task PollAndExecuteAsync(CancellationToken ct)
    {
        var config = _configProvider.Current;
        if (string.IsNullOrEmpty(config.AgentToken))
        {
            _logger.LogDebug("Agent token 未配置，跳過 winget checkin");
            return;
        }

        var facts = _facts.Collect();
        var payload = new AgentCheckinPayload
        {
            SerialNumber = facts.SerialNumber,
            OsVersion = facts.OsVersion,
            AppVersion = facts.AppVersion,
        };

        var http = CreateClient();
        http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", config.AgentToken);

        AgentCheckinResponse? parsed;
        try
        {
            using var resp = await http.PostAsJsonAsync(
                config.CheckinUrl, payload, JsonOptions, ct);
            if (!resp.IsSuccessStatusCode)
            {
                var body = await resp.Content.ReadAsStringAsync(ct);
                _logger.LogWarning(
                    "winget checkin failed: {Status} body={Body}", resp.StatusCode, body);
                return;
            }
            parsed = await resp.Content.ReadFromJsonAsync<AgentCheckinResponse>(JsonOptions, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "winget checkin HTTP failure");
            return;
        }

        var actions = parsed?.Data?.Actions;
        if (actions is null || actions.Count == 0) return;

        var wingetActions = actions.Where(a =>
            a.Type == "winget_install" || a.Type == "winget_uninstall").ToList();
        if (wingetActions.Count == 0) return;

        _logger.LogInformation(
            "拿到 {Count} 條 winget 命令（共 {Total} 個 actions）",
            wingetActions.Count, actions.Count);

        foreach (var action in wingetActions)
        {
            if (ct.IsCancellationRequested) break;
            try
            {
                await ExecuteOneAsync(action, facts.SerialNumber, config, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "執行 winget action 失敗 type={Type}", action.Type);
            }
        }
    }

    [SupportedOSPlatform("windows")]
    private async Task ExecuteOneAsync(
        AgentCheckinAction action,
        string serialNumber,
        AgentConfig config,
        CancellationToken ct)
    {
        var commandId = TryGetString(action.Data, "commandId");
        var wingetId = TryGetString(action.Data, "wingetId");
        var source = TryGetString(action.Data, "source") ?? "winget";
        var scope = TryGetString(action.Data, "scope") ?? "machine";
        var displayName = TryGetString(action.Data, "displayName");

        if (string.IsNullOrEmpty(commandId) || string.IsNullOrEmpty(wingetId))
        {
            _logger.LogWarning("winget action 缺 commandId/wingetId: {Json}",
                JsonSerializer.Serialize(action));
            return;
        }

        var isInstall = action.Type == "winget_install";
        var args = BuildWingetArgs(isInstall, wingetId, source, scope);
        var exe = _wingetExePath;
        if (exe is null)
        {
            _logger.LogError(
                "winget.exe 路徑未解析，跳過 cmd={Cmd}（service 重啟後重試）", commandId);
            return;
        }

        _logger.LogInformation(
            "winget {Verb} 開始: exe={Exe} id={Id} source={Src} cmd={Cmd}",
            isInstall ? "install" : "uninstall", exe, wingetId, source, commandId);

        var sw = Stopwatch.StartNew();
        var (exitCode, stdout, stderr) = await RunWingetAsync(exe, args, ct);
        sw.Stop();

        // Uninstall fallback 鏈：
        //   Layer 1: winget --id          ← 對 EXE installer 反向映射不穩，常 NO_PACKAGES_FOUND
        //   Layer 2: winget --name        ← 撞 manifest DisplayName
        //   Layer 3: ARP UninstallString  ← winget upstream 已知 LocalSystem context 限制
        //                                   (winget-cli #4271 / #5752)，社區共識繞 winget
        //                                   直接讀 HKLM Uninstall 跑 QuietUninstallString
        //                                   PF5XSMN1 真機 7zip.7zip 暴露：winget tracking
        //                                   DB 對 EXE installer 反向映射不認，但
        //                                   `"C:\Program Files\7-Zip\Uninstall.exe" /S`
        //                                   就放在 HKLM 等著被直接調用
        if (!isInstall && IsWingetIdNotFound(exitCode) && !string.IsNullOrEmpty(displayName))
        {
            _logger.LogWarning(
                "winget uninstall --id {Id} 找不到包(exit={Exit:X})，fallback Layer 2: --name {Name}",
                wingetId, exitCode, displayName);
            var fallbackArgs = BuildWingetUninstallByName(displayName);
            sw.Restart();
            var (exit2, stdout2, stderr2) = await RunWingetAsync(exe, fallbackArgs, ct);
            sw.Stop();
            exitCode = exit2;
            stdout = stdout + "\n--- fallback --name ---\n" + stdout2;
            stderr = stderr + "\n--- fallback --name ---\n" + stderr2;

            if (IsWingetIdNotFound(exitCode))
            {
                _logger.LogWarning(
                    "winget --name {Name} 仍找不到(exit={Exit:X})，fallback Layer 3: ARP UninstallString",
                    displayName, exitCode);
                var arp = TryFindArpUninstallEntry(displayName);
                if (arp is not null)
                {
                    sw.Restart();
                    var (exit3, stdout3, stderr3) = await RunArpUninstallAsync(arp, ct);
                    sw.Stop();
                    exitCode = exit3;
                    stdout = stdout +
                        "\n--- fallback ARP ---\n" +
                        $"DisplayName: {arp.DisplayName}\n" +
                        $"Command: {arp.UninstallCommand}\n" +
                        $"IsQuiet: {arp.IsQuiet}\n" +
                        stdout3;
                    stderr = stderr + "\n--- fallback ARP ---\n" + stderr3;
                    _logger.LogInformation(
                        "ARP fallback 完成: cmd={Cmd} exit={Exit} dur={Dur}ms",
                        arp.UninstallCommand, exit3, sw.ElapsedMilliseconds);
                }
                else
                {
                    _logger.LogWarning(
                        "ARP 查無 DisplayName like {Name}* — 三層 fallback 全 fail", displayName);
                }
            }
        }

        var status = ClassifyExitCode(exitCode);
        var version = isInstall && status == "success"
            ? TryExtractVersion(stdout) : null;

        _logger.LogInformation(
            "winget {Verb} 完成: id={Id} exit={Exit} status={Status} version={Version} dur={Dur}ms",
            isInstall ? "install" : "uninstall", wingetId,
            exitCode, status, version ?? "(unknown)", sw.ElapsedMilliseconds);

        await PostResultAsync(
            config,
            new WingetResultPayload
            {
                SerialNumber = serialNumber,
                CommandId = commandId,
                ExitCode = exitCode,
                Status = status,
                InstalledVersion = version,
                StdoutTail = Tail(stdout, StdoutTailBytes),
                StderrTail = Tail(stderr, StdoutTailBytes),
                DurationMs = sw.ElapsedMilliseconds,
            },
            ct);
    }

    // punt: uninstall 用 --id 在 winget tracking DB 找不到 ARP 反向映射時 exit 0x8A150014
    //       NO_PACKAGES_FOUND（PF5XSMN1 真機 7zip.7zip uninstall 暴露；社區已知 winget
    //       ARP 模糊匹配不可靠）。短期可選 fallback 試 --name=displayName；中長期 admin
    //       上架時加 uninstallNameOverride 欄位。當前實作只走 --id，失敗回報後台
    //       status=error，managed 端可手動補卸或改派 EDA-CSP MSI 卸載。
    private static string BuildWingetArgs(
        bool isInstall, string wingetId, string source, string scope)
    {
        var sb = new StringBuilder();
        sb.Append(isInstall ? "install" : "uninstall");
        sb.Append(" --id \"").Append(wingetId.Replace("\"", "\\\"")).Append('"');
        sb.Append(" --exact --silent");
        // --disable-interactivity 關鍵：LocalSystem service context 跑 winget 時
        // 即使帶 --accept-source-agreements，msstore source 偶爾仍會 prompt
        // 「源要求在使用前查看以下协议」並阻塞等輸入（已知 winget-cli 行為）。
        // disable-interactivity 強制所有 prompt 失敗回 exit code 而非等輸入。
        // 真機 PF5XSMN1 1.4.0.11 uninstall 卡 15min 才暴露這條。
        sb.Append(" --disable-interactivity");
        sb.Append(" --accept-source-agreements");
        if (isInstall)
        {
            sb.Append(" --scope ").Append(scope);
            sb.Append(" --accept-package-agreements");
            if (!string.IsNullOrEmpty(source))
                sb.Append(" --source \"").Append(source.Replace("\"", "\\\"")).Append('"');
        }
        return sb.ToString();
    }

    /// <summary>
    /// winget 退出碼分類。參考 winget-cli/doc/windows/package-manager/winget/returnCodes.md。
    /// </summary>
    private static string ClassifyExitCode(int code) => code switch
    {
        0 => "success",
        unchecked((int)0x8A150011) => "not-found", // APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND
        unchecked((int)0x8A150014) => "not-found", // APPINSTALLER_CLI_ERROR_NO_PACKAGES_FOUND
        unchecked((int)0x8A15002B) => "already-installed",
        _ => "failed",
    };

    /// <summary>winget uninstall --id 找不到包的兩種錯誤碼。</summary>
    private static bool IsWingetIdNotFound(int code) =>
        code == unchecked((int)0x8A150011) || code == unchecked((int)0x8A150014);

    /// <summary>
    /// uninstall fallback：用 --name 撞 ARP DisplayName，繞 winget tracking DB
    /// 對 winget-pkgs ID 反向映射的不穩定。--name 是 winget 的模糊匹配（contains）。
    /// 限定 --source winget 避免 msstore source 返回 0x8A150039 Invalid data returned by rest source。
    /// </summary>
    private static string BuildWingetUninstallByName(string displayName)
    {
        var sb = new StringBuilder();
        sb.Append("uninstall --name \"")
          .Append(displayName.Replace("\"", "\\\""))
          .Append('"');
        sb.Append(" --silent --disable-interactivity --accept-source-agreements");
        sb.Append(" --source winget");
        return sb.ToString();
    }

    private static readonly Regex VersionRegex = new(
        @"(?:Version|版本)\s*[:：]?\s*([^\s\r\n]+)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static string? TryExtractVersion(string stdout)
    {
        if (string.IsNullOrEmpty(stdout)) return null;
        var m = VersionRegex.Match(stdout);
        return m.Success ? m.Groups[1].Value.Trim() : null;
    }

    private static string Tail(string s, int max) =>
        string.IsNullOrEmpty(s) ? "" : (s.Length <= max ? s : s[^max..]);

    private static string? TryGetString(Dictionary<string, object>? data, string key)
    {
        if (data is null || !data.TryGetValue(key, out var v) || v is null) return null;
        // System.Text.Json 反序列化到 object 會給 JsonElement
        if (v is JsonElement je)
        {
            return je.ValueKind == JsonValueKind.String ? je.GetString() : je.ToString();
        }
        return v.ToString();
    }

    [SupportedOSPlatform("windows")]
    private static async Task<(int exitCode, string stdout, string stderr)> RunWingetAsync(
        string exe, string args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        using var proc = Process.Start(psi);
        if (proc is null) return (-1, "", "Process.Start returned null");

        using var timeout = new CancellationTokenSource(WingetExecTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, ct);

        var stdoutTask = proc.StandardOutput.ReadToEndAsync(linked.Token);
        var stderrTask = proc.StandardError.ReadToEndAsync(linked.Token);

        try
        {
            await proc.WaitForExitAsync(linked.Token);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(true); } catch { /* best effort */ }
            return (-1, await SafeAwait(stdoutTask), "TIMEOUT after " + WingetExecTimeout);
        }

        return (proc.ExitCode, await SafeAwait(stdoutTask), await SafeAwait(stderrTask));
    }

    private static async Task<string> SafeAwait(Task<string> t)
    {
        try { return await t; } catch { return ""; }
    }

    private async Task PostResultAsync(
        AgentConfig config, WingetResultPayload payload, CancellationToken ct)
    {
        try
        {
            var http = CreateClient();
            http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", config.AgentToken);
            using var resp = await http.PostAsJsonAsync(
                config.WingetResultUrl, payload, JsonOptions, ct);
            if (!resp.IsSuccessStatusCode)
            {
                var body = await resp.Content.ReadAsStringAsync(ct);
                _logger.LogError(
                    "POST /winget-result failed: {Status} body={Body}",
                    resp.StatusCode, body);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "POST /winget-result HTTP failure");
        }
    }

    private sealed record ArpUninstallEntry(
        string DisplayName, string UninstallCommand, bool IsQuiet);

    /// <summary>
    /// 從 HKLM\SOFTWARE\...\Uninstall（兩個 64/32 hive）找 DisplayName 前綴匹配的 entry。
    /// 優先 QuietUninstallString（廠商給的 silent 命令，最穩）；
    /// 沒有則 fallback UninstallString + msi 模式重寫成 `msiexec /x {GUID} /qn /norestart`。
    /// EXE installer 的 UninstallString 沒 silent 屬性時直接用原樣（部分 EXE uninstaller
    /// 本身就 silent 行為），上層執行時失敗 admin 後台手動處理。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static ArpUninstallEntry? TryFindArpUninstallEntry(string displayNamePrefix)
    {
        var roots = new[]
        {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        };

        foreach (var root in roots)
        {
            using var rootKey = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(root);
            if (rootKey is null) continue;

            foreach (var subName in rootKey.GetSubKeyNames())
            {
                using var sub = rootKey.OpenSubKey(subName);
                if (sub is null) continue;
                var dn = sub.GetValue("DisplayName") as string;
                if (string.IsNullOrEmpty(dn)) continue;
                if (!dn.StartsWith(displayNamePrefix, StringComparison.OrdinalIgnoreCase)) continue;

                var quiet = sub.GetValue("QuietUninstallString") as string;
                if (!string.IsNullOrEmpty(quiet))
                    return new ArpUninstallEntry(dn, quiet, IsQuiet: true);

                var us = sub.GetValue("UninstallString") as string;
                if (string.IsNullOrEmpty(us)) continue;

                // MsiExec.exe /I{GUID} 或 /X{GUID} → 重寫成 silent
                // 形如:  MsiExec.exe /X{ABC-...}   或   "C:\Windows\System32\MsiExec.exe" /X{...}
                var msiMatch = MsiExecRegex.Match(us);
                if (msiMatch.Success)
                {
                    var guid = msiMatch.Groups["guid"].Value;
                    return new ArpUninstallEntry(
                        dn,
                        $"msiexec.exe /x {guid} /qn /norestart",
                        IsQuiet: true);
                }

                // 非 MSI、無 QuietUninstallString — 嘗試啟發式 silent flag（NSIS /S、InnoSetup
                // /VERYSILENT /SUPPRESSMSGBOXES）。沒辦法 100% 正確，admin 後台知道有風險。
                // punt: 啟發式 silent flag 不一定對；後續可加 admin 上架時的
                //       uninstall_command_override 欄位，讓 admin 對已知坑包手填命令
                return new ArpUninstallEntry(dn, us, IsQuiet: false);
            }
        }
        return null;
    }

    private static readonly Regex MsiExecRegex = new(
        @"MsiExec(?:\.exe)?\s+/[XI]\s*(?<guid>\{[0-9A-Fa-f-]+\})",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// 跑 ARP UninstallString。用 cmd /c 包裝以處理引號 + 空白路徑。
    /// 不是 quiet entry 時，附加 /S（NSIS 慣例）作後備——錯了會無害失敗。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static async Task<(int exitCode, string stdout, string stderr)> RunArpUninstallAsync(
        ArpUninstallEntry entry, CancellationToken ct)
    {
        var cmdline = entry.UninstallCommand;
        if (!entry.IsQuiet && !cmdline.Contains(" /S", StringComparison.OrdinalIgnoreCase)
                           && !cmdline.Contains(" /quiet", StringComparison.OrdinalIgnoreCase))
        {
            cmdline = cmdline + " /S";
        }

        var psi = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = "/c " + cmdline,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        using var proc = Process.Start(psi);
        if (proc is null) return (-1, "", "Process.Start returned null");

        using var timeout = new CancellationTokenSource(WingetExecTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, ct);

        var stdoutTask = proc.StandardOutput.ReadToEndAsync(linked.Token);
        var stderrTask = proc.StandardError.ReadToEndAsync(linked.Token);

        try
        {
            await proc.WaitForExitAsync(linked.Token);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(true); } catch { }
            return (-1, await SafeAwait(stdoutTask), "ARP TIMEOUT after " + WingetExecTimeout);
        }
        return (proc.ExitCode, await SafeAwait(stdoutTask), await SafeAwait(stderrTask));
    }

    /// <summary>
    /// 解析 winget.exe 絕對路徑。LocalSystem service 看不到 user-scope winget
    /// （per-user MSIX 在 `%LOCALAPPDATA%\Microsoft\WindowsApps`），必須找
    /// system-wide x64 binary：
    ///   <c>C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_VERSION_x64__8wekyb3d8bbwe\winget.exe</c>
    /// 同 DesktopAppInstaller 包名版本號隨 Microsoft Store 更新變，按字典序取最新。
    /// 找不到回 null，watcher 啟動但 spawn 階段會跳過命令。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static string? ResolveWingetExe()
    {
        // 1) 先試 PATH（dev 機 / interactive context 通常有）
        try
        {
            var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in pathEnv.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                var candidate = Path.Combine(dir, "winget.exe");
                if (File.Exists(candidate)) return candidate;
            }
        }
        catch { /* fall through to glob */ }

        // 2) WindowsApps glob — system-wide x64 binary 確定存在
        try
        {
            var windowsApps = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "WindowsApps");
            if (!Directory.Exists(windowsApps)) return null;

            // x64__8wekyb3d8bbwe 是真正含 winget.exe 的主包，scale-* / language-* 不含
            var candidates = Directory
                .EnumerateDirectories(windowsApps, "Microsoft.DesktopAppInstaller_*_x64__*")
                .Select(dir => Path.Combine(dir, "winget.exe"))
                .Where(File.Exists)
                .OrderByDescending(p => p, StringComparer.OrdinalIgnoreCase)
                .ToList();
            return candidates.FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }
}
