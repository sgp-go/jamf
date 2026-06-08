using CoGrowMDMAgent.Config;

namespace CoGrowMDMAgent.Tests;

public class AgentConfigTests
{
    [Fact]
    public void ReportsUrl_AppendsTenantPath()
    {
        var cfg = MakeConfig("https://api.example.com/api/v1");

        Assert.Equal(
            "https://api.example.com/api/v1/tenants/t-1/agent/reports",
            cfg.ReportsUrl);
    }

    [Fact]
    public void UsageUrl_AppendsTenantPath()
    {
        var cfg = MakeConfig("https://api.example.com/api/v1");

        Assert.Equal(
            "https://api.example.com/api/v1/tenants/t-1/agent/usage",
            cfg.UsageUrl);
    }

    [Fact]
    public void Urls_StripTrailingSlash()
    {
        var cfg = MakeConfig("https://api.example.com/api/v1/");

        Assert.Equal(
            "https://api.example.com/api/v1/tenants/t-1/agent/reports",
            cfg.ReportsUrl);
    }

    private static AgentConfig MakeConfig(string endpoint) => new()
    {
        DeviceId = "d-1",
        AgentToken = "token",
        ApiEndpoint = endpoint,
        TenantId = "t-1",
    };
}
