using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Diagnostics;
using CoGrowMDMAgent.Scheduling;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Tests;

public class StartupSelfCheckTests
{
    private static readonly AgentConfig GoodConfig = new()
    {
        DeviceId = "dev-1",
        AgentToken = "tok-abc",
        ApiEndpoint = "https://api.example.com",
        TenantId = "tenant-1",
    };

    // ---- ValidateConfig（純函數）----

    [Fact]
    public void ValidateConfig_Good_NoFailures()
    {
        Assert.Empty(StartupSelfCheck.ValidateConfig(GoodConfig));
    }

    [Fact]
    public void ValidateConfig_EmptyTenantId_Reported()
    {
        var cfg = GoodConfig with { TenantId = "" };
        var failures = StartupSelfCheck.ValidateConfig(cfg);
        Assert.Contains(failures, f => f.Contains("tenant_id"));
    }

    [Fact]
    public void ValidateConfig_EmptyIdentity_NotFatal_PreEnroll()
    {
        // Intune 共存首啟：device_id / agent_token 尚未換取為空 → 選填，不列入 failures
        // （AgentEnrollmentService 會補；上報端對空 token skip）。tenant_id / api_endpoint 仍在。
        var cfg = GoodConfig with { DeviceId = "", AgentToken = "  " };
        Assert.Empty(StartupSelfCheck.ValidateConfig(cfg));
    }

    [Theory]
    [InlineData("api.example.com")]   // 缺 scheme（已知環境坑）
    [InlineData("ftp://x.example")]   // 非 http(s)
    [InlineData("not a url")]
    [InlineData("")]
    public void ValidateConfig_BadEndpoint_Reports(string endpoint)
    {
        var cfg = GoodConfig with { ApiEndpoint = endpoint };
        var failures = StartupSelfCheck.ValidateConfig(cfg);
        Assert.Contains(failures, f => f.Contains("api_endpoint"));
    }

    [Theory]
    [InlineData("https://api.example.com")]
    [InlineData("http://10.0.0.1:8000")]
    public void ValidateConfig_GoodEndpoint_NoEndpointFailure(string endpoint)
    {
        var cfg = GoodConfig with { ApiEndpoint = endpoint };
        var failures = StartupSelfCheck.ValidateConfig(cfg);
        Assert.DoesNotContain(failures, f => f.Contains("api_endpoint"));
    }

    // ---- Run（DI graph 自檢）----

    private static ServiceProvider BuildProvider(bool registerScheduler)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<AgentConfigProvider>(sp =>
            new AgentConfigProvider(
                () => GoodConfig,
                sp.GetRequiredService<ILogger<AgentConfigProvider>>()));
        services.AddSingleton<AgentConfig>(sp =>
            sp.GetRequiredService<AgentConfigProvider>().Current);
        if (registerScheduler) services.AddSingleton<JitterScheduler>();
        return services.BuildServiceProvider();
    }

    private static readonly (string, Type)[] MiniCritical =
    {
        ("AgentConfigProvider", typeof(AgentConfigProvider)),
        ("JitterScheduler", typeof(JitterScheduler)),
    };

    [Fact]
    public void Run_AllCriticalResolve_Ok()
    {
        using var sp = BuildProvider(registerScheduler: true);
        var result = StartupSelfCheck.Run(sp, MiniCritical);
        Assert.True(result.Ok, string.Join("; ", result.Failures));
        Assert.Empty(result.Failures);
    }

    [Fact]
    public void Run_MissingCriticalService_ReportsFailure()
    {
        // 鏡像 DI-bug：JitterScheduler 未註冊 → 自檢必須捕獲並報告。
        using var sp = BuildProvider(registerScheduler: false);
        var result = StartupSelfCheck.Run(sp, MiniCritical);
        Assert.False(result.Ok);
        Assert.Contains(result.Failures, f => f.Contains("JitterScheduler"));
    }

    [Fact]
    public void Run_BadConfig_ReportsConfigFailure()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        var badConfig = GoodConfig with { ApiEndpoint = "api.example.com" }; // 缺 scheme
        services.AddSingleton<AgentConfigProvider>(sp =>
            new AgentConfigProvider(
                () => badConfig,
                sp.GetRequiredService<ILogger<AgentConfigProvider>>()));
        using var sp = services.BuildServiceProvider();

        var result = StartupSelfCheck.Run(
            sp, new[] { ("AgentConfigProvider", typeof(AgentConfigProvider)) });
        Assert.False(result.Ok);
        Assert.Contains(result.Failures, f => f.Contains("api_endpoint"));
    }
}
