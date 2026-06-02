using CoGrowMDMAgent;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Diagnostics;
using CoGrowMDMAgent.Locking;
using CoGrowMDMAgent.Queue;
using CoGrowMDMAgent.Reporting;
using CoGrowMDMAgent.Reporting.Usage;
using CoGrowMDMAgent.Scheduling;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "CoGrowMDMAgent";
});

builder.Services.AddSingleton<RegistryConfig>();
// AgentConfigProvider 持有 mutable snapshot，支援 Worker 每 cycle 前 TryReload
// 讓 MDM 旋轉 token / 切換 endpoint 不需重啟 service。
// loader 是 lambda 包 RegistryConfig.Load，便於測試傳任意來源 mock。
builder.Services.AddSingleton<AgentConfigProvider>(sp =>
{
    var registry = sp.GetRequiredService<RegistryConfig>();
    var logger = sp.GetRequiredService<ILogger<AgentConfigProvider>>();
    return new AgentConfigProvider(() => registry.Load(), logger);
});
// AgentConfig 啟動快照：JitterScheduler 只用 DeviceId 算一次錯峰 offset（不變），
// 注入快照即可。缺這條 → JitterScheduler(AgentConfig) 無法解析 → host 啟動崩潰
// （pre-existing bug：單測走 internal ctor 繞過 DI，故未暴露）。
builder.Services.AddSingleton<AgentConfig>(sp =>
    sp.GetRequiredService<AgentConfigProvider>().Current);
builder.Services.AddSingleton<JitterScheduler>();
builder.Services.AddSingleton<DeviceFactsCollector>();

// Local persistent SQLite stores. Path:
//   Windows:  C:\ProgramData\CoGrow\MDM Agent\*.db
//   dev/test: $TMPDIR/CoGrow/MDM Agent/*.db （SpecialFolder fallback）
static string DataDir()
{
    var dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "CoGrow", "MDM Agent");
    Directory.CreateDirectory(dir);
    return dir;
}

// 失敗上報的持久重試佇列（queue.db）。
builder.Services.AddSingleton<IReportQueue>(sp =>
{
    var dbPath = Path.Combine(DataDir(), "queue.db");
    var logger = sp.GetRequiredService<ILogger<SqliteReportQueue>>();
    return new SqliteReportQueue(dbPath, logger);
});

// 每日使用統計持久化（usage.db）；與佇列分開，schema 互不干擾。
builder.Services.AddSingleton<IUsageStore>(sp =>
{
    var dbPath = Path.Combine(DataDir(), "usage.db");
    var logger = sp.GetRequiredService<ILogger<SqliteUsageStore>>();
    return new SqliteUsageStore(dbPath, logger);
});

builder.Services.AddHttpClient<DeviceReporter>();
builder.Services.AddHttpClient<UsageReporter>();
builder.Services.AddHostedService<Worker>();
// 遠端鎖定：監控 Registry 鎖定旗標，在使用者 session 拉起全螢幕鎖定窗（[[windows-lock-design]]）。
// 與上報 Worker 並行的獨立 hosted service；非 Windows 平台 no-op。
builder.Services.AddHostedService<LockWatcher>();
// 使用時長採集：每分鐘探測 active console session 在用狀態，累計並持久化到 usage.db。
// 與 Worker / LockWatcher 並行的獨立 hosted service；非 Windows 平台 no-op。
builder.Services.AddHostedService<SessionUsageMonitor>();

var host = builder.Build();

// 啟動自檢：主動解析關鍵服務 + 驗證 config，提前把 DI/config 錯誤暴露為明確 Event Log
// 診斷（Windows service host 的 EventLog provider 落 Critical），而非延遲到 Worker 首次
// 使用才裸崩成 unhandled exception → FailureActions 崩潰循環（[[windows-agent-update-delivery]] §4）。
var startupLogger = host.Services.GetRequiredService<ILogger<Program>>();
var selfCheck = StartupSelfCheck.Run(host.Services);
if (!selfCheck.Ok)
{
    startupLogger.LogCritical(
        "Startup self-check FAILED — service will not start. {Count} problem(s):\n{Failures}",
        selfCheck.Failures.Count,
        string.Join("\n", selfCheck.Failures));
    // 非 0 退出碼（EX_CONFIG）：SCM 標記服務失敗，Event Log 留明確診斷，
    // 不再是裸 unhandled exception。崩潰循環由 Service.wxs FailureActions 限制。
    Environment.Exit(78);
}
startupLogger.LogInformation("Startup self-check passed");

// Initialise SQLite schemas before hosted services start (idempotent CREATE TABLE IF NOT EXISTS).
await host.Services.GetRequiredService<IReportQueue>()
    .InitializeAsync(CancellationToken.None);
await host.Services.GetRequiredService<IUsageStore>()
    .InitializeAsync(CancellationToken.None);

host.Run();
