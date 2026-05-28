using CoGrowMDMAgent.Config;
using Microsoft.Extensions.Logging.Abstractions;

namespace CoGrowMDMAgent.Tests;

public class AgentConfigProviderTests
{
    private static AgentConfig MakeConfig(
        string deviceId = "d-1",
        string agentToken = "token-aaaa",
        string apiEndpoint = "https://api.example.com/api/v1",
        string tenantId = "t-1") => new()
    {
        DeviceId = deviceId,
        AgentToken = agentToken,
        ApiEndpoint = apiEndpoint,
        TenantId = tenantId,
    };

    [Fact]
    public void Current_ReturnsLoaderInitialResult()
    {
        var initial = MakeConfig(agentToken: "initial-token");
        var provider = new AgentConfigProvider(
            () => initial,
            NullLogger<AgentConfigProvider>.Instance);

        Assert.Equal("initial-token", provider.Current.AgentToken);
    }

    [Fact]
    public void TryReload_ReturnsFalse_WhenConfigUnchanged()
    {
        var stable = MakeConfig();
        var provider = new AgentConfigProvider(
            () => stable,
            NullLogger<AgentConfigProvider>.Instance);

        Assert.False(provider.TryReload());
        Assert.Equal(stable.AgentToken, provider.Current.AgentToken);
    }

    [Fact]
    public void TryReload_ReturnsTrue_AndUpdatesCurrent_WhenConfigChanges()
    {
        var first = MakeConfig(agentToken: "old-token");
        var second = MakeConfig(agentToken: "new-token");
        var queue = new Queue<AgentConfig>([first, second]);
        var provider = new AgentConfigProvider(
            () => queue.Dequeue(),
            NullLogger<AgentConfigProvider>.Instance);

        Assert.Equal("old-token", provider.Current.AgentToken);
        Assert.True(provider.TryReload());
        Assert.Equal("new-token", provider.Current.AgentToken);
    }

    [Fact]
    public void TryReload_FiresConfigChanged_ExactlyOnce_OnChange()
    {
        var first = MakeConfig(agentToken: "old");
        var second = MakeConfig(agentToken: "new");
        var queue = new Queue<AgentConfig>([first, second]);
        var provider = new AgentConfigProvider(
            () => queue.Dequeue(),
            NullLogger<AgentConfigProvider>.Instance);

        var firedTokens = new List<string>();
        provider.ConfigChanged += (_, cfg) => firedTokens.Add(cfg.AgentToken);

        Assert.True(provider.TryReload());
        Assert.Single(firedTokens);
        Assert.Equal("new", firedTokens[0]);
    }

    [Fact]
    public void TryReload_DoesNotFire_WhenUnchanged()
    {
        var stable = MakeConfig();
        var provider = new AgentConfigProvider(
            () => stable,
            NullLogger<AgentConfigProvider>.Instance);

        int fireCount = 0;
        provider.ConfigChanged += (_, _) => fireCount++;

        Assert.False(provider.TryReload());
        Assert.False(provider.TryReload());
        Assert.Equal(0, fireCount);
    }

    [Fact]
    public void TryReload_ReturnsFalse_AndKeepsCurrent_WhenLoaderThrows()
    {
        var initial = MakeConfig(agentToken: "good-token");
        bool throwOnNext = false;
        var provider = new AgentConfigProvider(
            () =>
            {
                if (throwOnNext) throw new InvalidOperationException("registry hiccup");
                return initial;
            },
            NullLogger<AgentConfigProvider>.Instance);

        throwOnNext = true;
        Assert.False(provider.TryReload());
        Assert.Equal("good-token", provider.Current.AgentToken);
    }

    [Fact]
    public void TryReload_DetectsChange_OnAnyOf4Fields()
    {
        // 每改一個字段都應該被偵測（DeviceId / AgentToken / ApiEndpoint / TenantId）
        var baseline = MakeConfig();
        var variants = new[]
        {
            MakeConfig(deviceId: "d-2"),
            MakeConfig(agentToken: "token-zzzz"),
            MakeConfig(apiEndpoint: "https://other.example.com/api/v1"),
            MakeConfig(tenantId: "t-99"),
        };

        foreach (var variant in variants)
        {
            var queue = new Queue<AgentConfig>([baseline, variant]);
            var provider = new AgentConfigProvider(
                () => queue.Dequeue(),
                NullLogger<AgentConfigProvider>.Instance);
            Assert.True(
                provider.TryReload(),
                $"應該偵測到字段變化: device={variant.DeviceId} token={variant.AgentToken} ep={variant.ApiEndpoint} tenant={variant.TenantId}");
        }
    }

    [Fact]
    public void Mask_HidesMiddleForLongStrings_ReturnsTripleStarForShort()
    {
        Assert.Equal("(empty)", AgentConfigProvider.Mask(""));
        Assert.Equal("(empty)", AgentConfigProvider.Mask(null));
        Assert.Equal("***", AgentConfigProvider.Mask("short"));
        Assert.Equal("***", AgentConfigProvider.Mask("12345678")); // 邊界 ≤ 8

        // > 8 字符：前 4 + ... + 後 4
        var token = "abcd_______middle_______wxyz".Substring(0, 20); // 長 20
        var masked = AgentConfigProvider.Mask(token);
        Assert.StartsWith(token[..4], masked);
        Assert.EndsWith(token[^4..], masked);
        Assert.Contains("...", masked);
    }
}
