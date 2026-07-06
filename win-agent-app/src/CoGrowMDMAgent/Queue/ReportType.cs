namespace CoGrowMDMAgent.Queue;

/// <summary>
/// Discriminator stored in <see cref="PendingReport.ReportType"/> so the
/// drainer can route a queued JSON payload to the correct reporter.
/// </summary>
public static class ReportType
{
    public const string DeviceReport = "device_report";
    public const string UsageReport = "usage_report";
    public const string GpsReport = "gps_report";
    public const string InstalledAppsReport = "installed_apps_report";
}
