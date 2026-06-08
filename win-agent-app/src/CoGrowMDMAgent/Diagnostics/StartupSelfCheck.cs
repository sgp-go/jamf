using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Queue;
using CoGrowMDMAgent.Reporting;
using CoGrowMDMAgent.Reporting.Usage;
using CoGrowMDMAgent.Scheduling;
using Microsoft.Extensions.DependencyInjection;

namespace CoGrowMDMAgent.Diagnostics;

/// <summary>
/// 啟動自檢：在 host.Run() 前主動解析關鍵服務 + 驗證 config，把 DI/config 錯誤
/// 提前暴露為明確診斷，而非延遲到 Worker 首次使用才裸崩成 unhandled exception →
/// FailureActions 崩潰循環。
///
/// <para>起因（2026-05-29 血淚）：一個 <c>JitterScheduler(AgentConfig)</c> 沒註冊
/// 的 DI bug 讓 host 啟動即崩、崩潰循環。若這種 build 一次推 8000 台 = 全體 agent
/// 崩潰循環。自檢讓壞 build 在啟動點就留下明確 Event Log（[[windows-agent-update-delivery]] §4）。</para>
///
/// <para>本類只回傳結果（純邏輯，可單測）；寫 Event Log 由 Program 層 ILogger 負責
/// （Windows service host 的 EventLog provider 會把 Critical/Error 落 Windows 事件記錄）。</para>
/// </summary>
public static class StartupSelfCheck
{
    /// <summary>
    /// 缺任一即 host 無法正常工作的關鍵服務。主動解析以提前暴露 DI 接線錯誤
    /// （JitterScheduler 沒註冊的 DI-bug 正是此類）。
    /// </summary>
    private static readonly (string Name, Type Type)[] DefaultCriticalServices =
    {
        ("AgentConfigProvider", typeof(AgentConfigProvider)),
        ("JitterScheduler", typeof(JitterScheduler)),
        ("DeviceReporter", typeof(DeviceReporter)),
        ("UsageReporter", typeof(UsageReporter)),
        ("IReportQueue", typeof(IReportQueue)),
        ("IUsageStore", typeof(IUsageStore)),
        ("DeviceFactsCollector", typeof(DeviceFactsCollector)),
    };

    public static SelfCheckResult Run(IServiceProvider sp) =>
        Run(sp, DefaultCriticalServices);

    /// <summary>測試用重載：傳精簡服務清單，免在單測搭全套 DI。</summary>
    internal static SelfCheckResult Run(
        IServiceProvider sp,
        IReadOnlyList<(string Name, Type Type)> criticalServices)
    {
        var failures = new List<string>();

        foreach (var (name, type) in criticalServices)
        {
            try
            {
                _ = sp.GetRequiredService(type);
            }
            catch (Exception ex)
            {
                failures.Add($"DI resolve failed: {name} — {ex.Message}");
            }
        }

        // config 欄位形態：AgentConfigProvider ctor 已 load（缺值會在上面的 resolve
        // 失敗時記錄），resolve 成功才進一步驗 config 形態。
        try
        {
            var cfg = sp.GetService<AgentConfigProvider>()?.Current;
            if (cfg is not null) failures.AddRange(ValidateConfig(cfg));
        }
        catch
        {
            // AgentConfigProvider 解析失敗已在上面記錄，不重複。
        }

        return failures.Count == 0
            ? SelfCheckResult.Success
            : SelfCheckResult.Failed(failures);
    }

    /// <summary>
    /// 純函數：驗 config 必填欄位非空、api_endpoint 為合法 http(s) 絕對 URL。
    /// （api_endpoint 缺前綴是已知環境坑，自檢提前攔住而非運行時上報才報錯。）
    /// </summary>
    public static IReadOnlyList<string> ValidateConfig(AgentConfig cfg)
    {
        var failures = new List<string>();
        if (string.IsNullOrWhiteSpace(cfg.DeviceId)) failures.Add("config: device_id empty");
        if (string.IsNullOrWhiteSpace(cfg.AgentToken)) failures.Add("config: agent_token empty");
        if (string.IsNullOrWhiteSpace(cfg.TenantId)) failures.Add("config: tenant_id empty");

        if (string.IsNullOrWhiteSpace(cfg.ApiEndpoint))
        {
            failures.Add("config: api_endpoint empty");
        }
        else if (!Uri.TryCreate(cfg.ApiEndpoint, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            failures.Add($"config: api_endpoint not a valid http(s) URL: '{cfg.ApiEndpoint}'");
        }

        return failures;
    }
}
