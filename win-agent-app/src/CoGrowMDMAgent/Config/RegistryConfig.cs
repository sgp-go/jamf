using System.Runtime.Versioning;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Config;

/// <summary>
/// Loads AgentConfig from HKLM\SOFTWARE\Policies\CoGrowMDM\Agent on Windows.
/// On non-Windows dev machines (Mac/Linux) falls back to environment variables
/// so the host can be exercised end-to-end without a real registry.
///
/// Env var fallbacks (dev only): COGROW_DEVICE_ID, COGROW_AGENT_TOKEN,
/// COGROW_API_ENDPOINT, COGROW_TENANT_ID, COGROW_ENROLLMENT_SECRET.
///
/// <para><b>device_id / agent_token 為選填。</b> 自建 MDM 的正規路徑（install-agent）
/// 經 EDA-CSP 把兩者連同 api_endpoint / tenant_id 一起注入 MSI property；但 Intune
/// 共存場景下 MSI 只帶 api_endpoint + tenant_id + enrollment_secret（共享密鑰，非
/// per-device token），device_id / agent_token 由 Agent 首啟自註冊（<c>AgentEnrollment</c>）
/// 換取後寫回。缺值時回空字串（不拋錯），讓 host 能先啟動、自註冊服務再補；上報端已對
/// 空 token 做 skip 保護。<b>api_endpoint / tenant_id 仍必填</b>（兩種模式都需要，用來
/// 定位後端與租戶；缺失視為 MSI 未正確注入 config，屬硬錯誤）。</para>
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
                $"HKLM\\{KeyPath} not found — MSI 未安裝 / config 未注入？");

        return new AgentConfig
        {
            DeviceId = ReadOptional(key, "device_id"),
            AgentToken = ReadOptional(key, "agent_token"),
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

    /// <summary>選填值：缺失 / 空 → 回空字串（device_id / agent_token 在自註冊前為空）。</summary>
    [SupportedOSPlatform("windows")]
    private static string ReadOptional(RegistryKey key, string name) =>
        key.GetValue(name) as string ?? string.Empty;

    private static AgentConfig LoadFromEnvironment()
    {
        return new AgentConfig
        {
            DeviceId = Environment.GetEnvironmentVariable("COGROW_DEVICE_ID") ?? string.Empty,
            AgentToken = Environment.GetEnvironmentVariable("COGROW_AGENT_TOKEN") ?? string.Empty,
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

    // ────────────────────────────────────────────────────────────────
    // Intune 共存自註冊 bootstrap
    // ────────────────────────────────────────────────────────────────

    /// <summary>
    /// 讀取自註冊所需的原始值（不經 AgentConfig，避免 device_id 缺失時拋錯）。
    /// Windows 讀 registry；非 Windows 讀環境變數（dev 對等）。
    /// </summary>
    public EnrollmentBootstrap ReadBootstrap()
    {
        if (OperatingSystem.IsWindows())
        {
            return ReadBootstrapFromRegistry();
        }
        return new EnrollmentBootstrap
        {
            ApiEndpoint = Environment.GetEnvironmentVariable("COGROW_API_ENDPOINT") ?? string.Empty,
            TenantId = Environment.GetEnvironmentVariable("COGROW_TENANT_ID") ?? string.Empty,
            AgentToken = Environment.GetEnvironmentVariable("COGROW_AGENT_TOKEN") ?? string.Empty,
            EnrollmentSecret =
                Environment.GetEnvironmentVariable("COGROW_ENROLLMENT_SECRET") ?? string.Empty,
        };
    }

    [SupportedOSPlatform("windows")]
    private static EnrollmentBootstrap ReadBootstrapFromRegistry()
    {
        using var key = Registry.LocalMachine.OpenSubKey(KeyPath);
        return new EnrollmentBootstrap
        {
            ApiEndpoint = key?.GetValue("api_endpoint") as string ?? string.Empty,
            TenantId = key?.GetValue("tenant_id") as string ?? string.Empty,
            AgentToken = key?.GetValue("agent_token") as string ?? string.Empty,
            EnrollmentSecret = key?.GetValue("enrollment_secret") as string ?? string.Empty,
        };
    }

    /// <summary>
    /// 自註冊成功後把 device_id + agent_token 寫回 HKLM（service 跑 LocalSystem 可寫）。
    /// 非 Windows dev 為 no-op（dev 走環境變數，不自註冊）。
    /// </summary>
    public void PersistEnrolledIdentity(string deviceId, string agentToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        using var key = Registry.LocalMachine.CreateSubKey(KeyPath, writable: true)
            ?? throw new InvalidOperationException($"無法開啟 HKLM\\{KeyPath} 寫入");
        key.SetValue("device_id", deviceId, RegistryValueKind.String);
        key.SetValue("agent_token", agentToken, RegistryValueKind.String);
    }

    /// <summary>
    /// 消費後刪除共享密鑰，縮小暴露窗口（本鍵 ACL 對 Users 開放讀，tenant 級密鑰不宜久留）。
    /// 冪等：無此值也不報錯。非 Windows dev 為 no-op。
    /// </summary>
    public void ClearEnrollmentSecret()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        using var key = Registry.LocalMachine.OpenSubKey(KeyPath, writable: true);
        if (key?.GetValue("enrollment_secret") is not null)
        {
            key.DeleteValue("enrollment_secret", throwOnMissingValue: false);
        }
    }
}

/// <summary>
/// 自註冊 bootstrap 的原始值快照。device_id 刻意不含（自註冊前必為空，用不到）。
/// </summary>
public sealed record EnrollmentBootstrap
{
    public required string ApiEndpoint { get; init; }
    public required string TenantId { get; init; }
    /// <summary>已注入的 per-device token；非空表示無需自註冊（injected 或先前已註冊）。</summary>
    public required string AgentToken { get; init; }
    /// <summary>tenant 級共享自註冊密鑰；非空表示走 Intune 共存自註冊模式。</summary>
    public required string EnrollmentSecret { get; init; }

    public string EnrollUrl =>
        $"{ApiEndpoint.TrimEnd('/')}/tenants/{TenantId}/agent/enroll";
}
