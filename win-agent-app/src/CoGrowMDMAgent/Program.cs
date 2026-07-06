using CoGrowMDMAgent;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Diagnostics;
using CoGrowMDMAgent.BitLocker;
using CoGrowMDMAgent.Geolocation;
using CoGrowMDMAgent.Laps;
using CoGrowMDMAgent.Locking;
using CoGrowMDMAgent.Queue;
using CoGrowMDMAgent.Reporting;
using CoGrowMDMAgent.Reporting.Usage;
using CoGrowMDMAgent.Scheduling;
using CoGrowMDMAgent.OsServices;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "CoGrowMDMAgent";
});

// 單一 BackgroundService（watcher / reporter）未處理異常不應拖垮整個 host。
// .NET 6+ 預設 StopHost → 開機時網路 / registry 未就緒的競態若在 watcher try/catch 迴圈
// 外拋出，會 crash 全 agent（APPCRASH 0xe0434352，隨後 SCM 重啟）。改 Ignore：出事的
// watcher 停掉、其餘（LAPS / BitLocker / rename / GPS / report）續跑，fleet agent 更韌。
builder.Services.Configure<HostOptions>(o =>
    o.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore);

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
builder.Services.AddHttpClient<GpsReporter>();
builder.Services.AddHttpClient<InstalledAppsReporter>();
builder.Services.AddSingleton<InstalledAppsCollector>();
builder.Services.AddHttpClient<StartupCheckinService>();
builder.Services.AddHostedService<StartupCheckinService>();
builder.Services.AddHostedService<Worker>();
// GPS 採集：平時 24h、Lost Mode 30s；獨立 hosted service，與 Worker 並行；非 Windows no-op。
builder.Services.AddHostedService<GpsCollector>();
// 遠端鎖定：監控 Registry 鎖定旗標，在使用者 session 拉起全螢幕鎖定窗（[[windows-lock-design]]）。
// 與上報 Worker 並行的獨立 hosted service；非 Windows 平台 no-op。
builder.Services.AddHostedService<LockWatcher>();
builder.Services.AddHttpClient<LapsWatcher>();
builder.Services.AddHostedService<LapsWatcher>();
builder.Services.AddHostedService<BitLockerWatcher>();
builder.Services.AddHostedService<PpkgRemovalWatcher>();
builder.Services.AddHostedService<SelfUninstallWatcher>();
builder.Services.AddHostedService<RenameWatcher>();
// SoftWipe：Registry 觸發深度清理（畢業換人零 IT 介入）— 卸非白名單 MSI/UWP，
// 刪 non-admin user profile，清瀏覽器數據 / Recycle Bin / Temp。保 Agent + MDM。
builder.Services.AddHttpClient<CoGrowMDMAgent.SoftWipe.SoftWipeWatcher>();
builder.Services.AddHostedService<CoGrowMDMAgent.SoftWipe.SoftWipeWatcher>();
// winget App 派發：WingetWatcher 為 singleton（被 OmaDmEventLogWatcher 持有引用以觸發 RequestPoll），
// 同時以 hosted service 身分跑後台 loop；OmaDmEventLogWatcher 監聽 EventLog 265 喚醒它。
builder.Services.AddHttpClient(nameof(CoGrowMDMAgent.Winget.WingetWatcher));
builder.Services.AddSingleton<CoGrowMDMAgent.Winget.WingetWatcher>();
builder.Services.AddHostedService(sp =>
    sp.GetRequiredService<CoGrowMDMAgent.Winget.WingetWatcher>());
builder.Services.AddHostedService<CoGrowMDMAgent.Winget.OmaDmEventLogWatcher>();
// 使用時長採集：每分鐘探測 active console session 在用狀態，累計並持久化到 usage.db。
// 與 Worker / LockWatcher 並行的獨立 hosted service；非 Windows 平台 no-op。
builder.Services.AddHostedService<SessionUsageMonitor>();
// dmwappushservice keepalive：EDA-CSP 派發依賴此服務 route OMA-DM callbacks，
// Win11 24H2 上它 idle 會被 SCM 停掉導致 BITS 完成通知丟失、job orphan
// （2026-07-02 真機抓到 1.4.0.17 派發卡 Status=20 的 root cause）。
builder.Services.AddHostedService<DmwappushKeepaliveService>();

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
