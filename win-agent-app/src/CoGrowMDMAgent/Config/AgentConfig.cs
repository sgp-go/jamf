namespace CoGrowMDMAgent.Config;

/// <summary>
/// Strongly typed configuration read from HKLM\SOFTWARE\Policies\CoGrowMDM\Agent
/// (or environment variables on non-Windows dev).
/// </summary>
public sealed record AgentConfig
{
    public required string DeviceId { get; init; }
    public required string AgentToken { get; init; }
    public required string ApiEndpoint { get; init; }
    public required string TenantId { get; init; }

    public string ReportsUrl =>
        $"{ApiEndpoint.TrimEnd('/')}/tenants/{TenantId}/agent/reports";

    public string UsageUrl =>
        $"{ApiEndpoint.TrimEnd('/')}/tenants/{TenantId}/agent/usage";

    public string CheckinUrl =>
        $"{ApiEndpoint.TrimEnd('/')}/tenants/{TenantId}/agent/checkin";

    public string GpsUrl =>
        $"{ApiEndpoint.TrimEnd('/')}/tenants/{TenantId}/agent/gps";

    public string WingetResultUrl =>
        $"{ApiEndpoint.TrimEnd('/')}/tenants/{TenantId}/agent/winget-result";

    public string SoftWipeResultUrl =>
        $"{ApiEndpoint.TrimEnd('/')}/tenants/{TenantId}/agent/soft-wipe-result";

    public string InstalledAppsUrl =>
        $"{ApiEndpoint.TrimEnd('/')}/tenants/{TenantId}/agent/installed-apps";
}
