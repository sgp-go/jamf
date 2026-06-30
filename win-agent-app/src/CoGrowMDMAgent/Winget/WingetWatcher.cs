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

        if (!await IsWingetAvailableAsync(stoppingToken))
        {
            _logger.LogWarning(
                "winget.exe 不在 PATH 或不可執行。需 Win10 1809+ 預裝 App Installer。watcher 不退出，因為使用者後續可能裝上"
            );
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

        if (string.IsNullOrEmpty(commandId) || string.IsNullOrEmpty(wingetId))
        {
            _logger.LogWarning("winget action 缺 commandId/wingetId: {Json}",
                JsonSerializer.Serialize(action));
            return;
        }

        var isInstall = action.Type == "winget_install";
        var args = BuildWingetArgs(isInstall, wingetId, source, scope);

        _logger.LogInformation(
            "winget {Verb} 開始: id={Id} source={Src} cmd={Cmd}",
            isInstall ? "install" : "uninstall", wingetId, source, commandId);

        var sw = Stopwatch.StartNew();
        var (exitCode, stdout, stderr) = await RunWingetAsync(args, ct);
        sw.Stop();

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

    private static string BuildWingetArgs(
        bool isInstall, string wingetId, string source, string scope)
    {
        var sb = new StringBuilder();
        sb.Append(isInstall ? "install" : "uninstall");
        sb.Append(" --id \"").Append(wingetId.Replace("\"", "\\\"")).Append('"');
        sb.Append(" --exact --silent");
        if (isInstall)
        {
            sb.Append(" --scope ").Append(scope);
            sb.Append(" --accept-source-agreements --accept-package-agreements");
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
        unchecked((int)0x8A15002B) => "already-installed",
        _ => "failed",
    };

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
        string args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "winget.exe",
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

    private static async Task<bool> IsWingetAvailableAsync(CancellationToken ct)
    {
        try
        {
            var psi = new ProcessStartInfo("winget.exe", "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            if (p is null) return false;
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cts.Token, ct);
            try { await p.WaitForExitAsync(linked.Token); }
            catch { try { p.Kill(true); } catch { } return false; }
            return p.ExitCode == 0;
        }
        catch { return false; }
    }
}
