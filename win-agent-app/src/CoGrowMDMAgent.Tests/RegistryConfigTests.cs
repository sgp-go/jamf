using CoGrowMDMAgent.Config;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// Tests for the env-var fallback path used on non-Windows dev hosts.
/// Real HKLM coverage is exercised on Windows test machines (out of scope
/// for cross-platform CI).
/// </summary>
public class RegistryConfigTests
{
    private const string DeviceIdVar = "COGROW_DEVICE_ID";
    private const string TokenVar = "COGROW_AGENT_TOKEN";
    private const string EndpointVar = "COGROW_API_ENDPOINT";
    private const string TenantVar = "COGROW_TENANT_ID";

    [Fact]
    public void Load_FromEnvironment_Succeeds_OnNonWindows()
    {
        if (OperatingSystem.IsWindows())
        {
            // On Windows the loader reads HKLM and skips the env-var path.
            // Skip rather than fail to keep the suite green on both OSes.
            return;
        }

        var prev = SnapshotEnv();
        try
        {
            Environment.SetEnvironmentVariable(DeviceIdVar, "dev-device");
            Environment.SetEnvironmentVariable(TokenVar, "dev-token");
            Environment.SetEnvironmentVariable(EndpointVar, "https://dev.example.com/api/v1");
            Environment.SetEnvironmentVariable(TenantVar, "dev-tenant");

            var cfg = new RegistryConfig().Load();

            Assert.Equal("dev-device", cfg.DeviceId);
            Assert.Equal("dev-token", cfg.AgentToken);
            Assert.Equal("https://dev.example.com/api/v1", cfg.ApiEndpoint);
            Assert.Equal("dev-tenant", cfg.TenantId);
        }
        finally
        {
            RestoreEnv(prev);
        }
    }

    [Fact]
    public void Load_MissingEnvVar_Throws_OnNonWindows()
    {
        if (OperatingSystem.IsWindows()) return;

        var prev = SnapshotEnv();
        try
        {
            Environment.SetEnvironmentVariable(DeviceIdVar, null);
            Environment.SetEnvironmentVariable(TokenVar, "t");
            Environment.SetEnvironmentVariable(EndpointVar, "e");
            Environment.SetEnvironmentVariable(TenantVar, "x");

            Assert.Throws<InvalidOperationException>(() => new RegistryConfig().Load());
        }
        finally
        {
            RestoreEnv(prev);
        }
    }

    private static Dictionary<string, string?> SnapshotEnv() => new()
    {
        [DeviceIdVar] = Environment.GetEnvironmentVariable(DeviceIdVar),
        [TokenVar] = Environment.GetEnvironmentVariable(TokenVar),
        [EndpointVar] = Environment.GetEnvironmentVariable(EndpointVar),
        [TenantVar] = Environment.GetEnvironmentVariable(TenantVar),
    };

    private static void RestoreEnv(Dictionary<string, string?> prev)
    {
        foreach (var (key, value) in prev)
        {
            Environment.SetEnvironmentVariable(key, value);
        }
    }
}
