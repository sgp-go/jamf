using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Locking;
using CoGrowMDMAgent.Scheduling;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// DI 接線回歸測試。
///
/// 守住 pre-existing bug：JitterScheduler 構造取 AgentConfig，但 Program.cs 只註冊
/// AgentConfigProvider → host 啟動時無法解析 AgentConfig → 服務崩潰循環。單元測試此前
/// 走 internal ctor 繞過 DI 未暴露。本測試鏡像 Program.cs 關鍵註冊並真正 BuildServiceProvider
/// + 解析，缺 AgentConfig 註冊即失敗。
/// </summary>
public class DiWiringTests
{
    private static readonly AgentConfig TestConfig = new()
    {
        DeviceId = "windows-di-test",
        AgentToken = "tok",
        ApiEndpoint = "https://example.com",
        TenantId = "tenant-1",
    };

    [Fact]
    public void JitterScheduler_resolves_when_AgentConfig_registered()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        // 鏡像 Program.cs
        services.AddSingleton<AgentConfigProvider>(sp =>
            new AgentConfigProvider(
                () => TestConfig,
                sp.GetRequiredService<ILogger<AgentConfigProvider>>()));
        services.AddSingleton<AgentConfig>(sp =>
            sp.GetRequiredService<AgentConfigProvider>().Current);
        services.AddSingleton<JitterScheduler>();

        using var provider = services.BuildServiceProvider(validateScopes: true);

        // 不拋 = DI 鏈通（缺 AgentConfig 註冊此處 throw InvalidOperationException）
        var scheduler = provider.GetRequiredService<JitterScheduler>();
        Assert.NotNull(scheduler);
    }

    [Fact]
    public void LockWatcher_resolves_as_hosted_service()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddHostedService<LockWatcher>();

        using var provider = services.BuildServiceProvider();

        var hosted = provider.GetServices<IHostedService>();
        Assert.Contains(hosted, h => h is LockWatcher);
    }
}
