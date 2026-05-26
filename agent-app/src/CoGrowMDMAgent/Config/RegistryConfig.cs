using System.Runtime.Versioning;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Config;

/// <summary>
/// Loads AgentConfig from HKLM\SOFTWARE\Policies\CoGrowMDM\Agent on Windows.
/// On non-Windows dev machines (Mac/Linux) falls back to environment variables
/// so the host can be exercised end-to-end without a real registry.
///
/// Env var fallbacks (dev only): COGROW_DEVICE_ID, COGROW_AGENT_TOKEN,
/// COGROW_API_ENDPOINT, COGROW_TENANT_ID.
/// </summary>
public sealed class RegistryConfig
{
    public const string KeyPath = @"SOFTWARE\Policies\CoGrowMDM\Agent";

    public AgentConfig Load()
    {
        if (OperatingSystem.IsWindows())
        {
            return LoadFromRegistry();
        }
        return LoadFromEnvironment();
    }

    [SupportedOSPlatform("windows")]
    private static AgentConfig LoadFromRegistry()
    {
        using var key = Registry.LocalMachine.OpenSubKey(KeyPath)
            ?? throw new InvalidOperationException(
                $"HKLM\\{KeyPath} not found — was install-agent run yet?");

        return new AgentConfig
        {
            DeviceId = ReadRequired(key, "device_id"),
            AgentToken = ReadRequired(key, "agent_token"),
            ApiEndpoint = ReadRequired(key, "api_endpoint"),
            TenantId = ReadRequired(key, "tenant_id"),
        };
    }

    [SupportedOSPlatform("windows")]
    private static string ReadRequired(RegistryKey key, string name)
    {
        var value = key.GetValue(name) as string;
        if (string.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException(
                $"Registry value '{name}' missing under HKLM\\{KeyPath}");
        }
        return value;
    }

    private static AgentConfig LoadFromEnvironment()
    {
        return new AgentConfig
        {
            DeviceId = EnvRequired("COGROW_DEVICE_ID"),
            AgentToken = EnvRequired("COGROW_AGENT_TOKEN"),
            ApiEndpoint = EnvRequired("COGROW_API_ENDPOINT"),
            TenantId = EnvRequired("COGROW_TENANT_ID"),
        };
    }

    private static string EnvRequired(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException(
                $"Environment variable '{name}' missing — required on non-Windows dev hosts");
        }
        return value;
    }
}
