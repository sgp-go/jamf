using CoGrowMDMAgent;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Queue;
using CoGrowMDMAgent.Reporting;
using CoGrowMDMAgent.Scheduling;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "CoGrowMDMAgent";
});

builder.Services.AddSingleton<RegistryConfig>();
builder.Services.AddSingleton<AgentConfig>(sp =>
    sp.GetRequiredService<RegistryConfig>().Load());
builder.Services.AddSingleton<JitterScheduler>();
builder.Services.AddSingleton<DeviceFactsCollector>();

// Local persistent queue for failed reports. Path:
//   Windows:  C:\ProgramData\CoGrow\MDM Agent\queue.db
//   dev/test: $TMPDIR/CoGrow/MDM Agent/queue.db （SpecialFolder fallback）
builder.Services.AddSingleton<IReportQueue>(sp =>
{
    var dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "CoGrow", "MDM Agent");
    Directory.CreateDirectory(dir);
    var dbPath = Path.Combine(dir, "queue.db");
    var logger = sp.GetRequiredService<ILogger<SqliteReportQueue>>();
    return new SqliteReportQueue(dbPath, logger);
});

builder.Services.AddHttpClient<DeviceReporter>();
builder.Services.AddHttpClient<UsageReporter>();
builder.Services.AddHostedService<Worker>();

var host = builder.Build();

// Initialise SQLite schema before Worker starts (idempotent CREATE TABLE IF NOT EXISTS).
await host.Services.GetRequiredService<IReportQueue>()
    .InitializeAsync(CancellationToken.None);

host.Run();
