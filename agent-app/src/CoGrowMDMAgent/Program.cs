using CoGrowMDMAgent;
using CoGrowMDMAgent.Config;
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
builder.Services.AddHttpClient<DeviceReporter>();
builder.Services.AddHttpClient<UsageReporter>();
builder.Services.AddHostedService<Worker>();

var host = builder.Build();
host.Run();
