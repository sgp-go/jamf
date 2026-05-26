using System.Diagnostics;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Principal;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Collects device facts that go into the agent report.
///
/// Windows path uses WMI / DriveInfo / WindowsIdentity. Non-Windows hosts
/// (Mac/Linux during dev) return best-effort placeholders so the wire path
/// can still be exercised without a real Windows machine.
/// </summary>
public sealed class DeviceFactsCollector
{
    private static readonly string AppVersion =
        typeof(DeviceFactsCollector).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(DeviceFactsCollector).Assembly.GetName().Version?.ToString()
        ?? "0.0.0";

    private readonly ILogger<DeviceFactsCollector> _logger;

    public DeviceFactsCollector(ILogger<DeviceFactsCollector> logger)
    {
        _logger = logger;
    }

    public DeviceFacts Collect()
    {
        var systemDrive = GetSystemDriveStats();

        return new DeviceFacts
        {
            SerialNumber = GetSerialNumber(),
            OsVersion = Environment.OSVersion.VersionString,
            AppVersion = AppVersion,
            StorageAvailableMb = systemDrive.AvailableMb,
            StorageTotalMb = systemDrive.TotalMb,
            Windows = OperatingSystem.IsWindows() ? CollectWindowsFacts() : null,
        };
    }

    private string GetSerialNumber()
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                return WindowsSerialNumber() ?? Environment.MachineName;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to read Win32_BIOS serial; falling back to MachineName");
                return Environment.MachineName;
            }
        }
        return Environment.MachineName;
    }

    [SupportedOSPlatform("windows")]
    private static string? WindowsSerialNumber()
    {
        using var searcher = new System.Management.ManagementObjectSearcher(
            "SELECT SerialNumber FROM Win32_BIOS");
        foreach (var obj in searcher.Get())
        {
            var serial = obj["SerialNumber"]?.ToString()?.Trim();
            if (!string.IsNullOrEmpty(serial)) return serial;
        }
        return null;
    }

    private (long? AvailableMb, long? TotalMb) GetSystemDriveStats()
    {
        try
        {
            var root = Path.GetPathRoot(Environment.SystemDirectory) ?? "/";
            var drive = new DriveInfo(root);
            if (!drive.IsReady) return (null, null);
            return (drive.AvailableFreeSpace / 1024 / 1024, drive.TotalSize / 1024 / 1024);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read system drive stats");
            return (null, null);
        }
    }

    [SupportedOSPlatform("windows")]
    private WindowsFacts CollectWindowsFacts()
    {
        return new WindowsFacts
        {
            WingetVersion = TryWingetVersion(),
            IsLocalAdmin = IsCurrentUserLocalAdmin(),
            // defender / firewall / pending_updates probe TBD (W3) — left null
            // intentionally so the field appears but the value is not faked.
            DefenderEnabled = null,
            FirewallEnabled = null,
            PendingUpdates = null,
        };
    }

    [SupportedOSPlatform("windows")]
    private string? TryWingetVersion()
    {
        try
        {
            var psi = new ProcessStartInfo("winget", "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return null;
            if (!proc.WaitForExit(2000)) { proc.Kill(); return null; }
            var output = proc.StandardOutput.ReadToEnd().Trim();
            return string.IsNullOrEmpty(output) ? null : output;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "winget --version probe failed");
            return null;
        }
    }

    [SupportedOSPlatform("windows")]
    private static bool IsCurrentUserLocalAdmin()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }
}

public sealed record DeviceFacts
{
    public required string SerialNumber { get; init; }
    public required string OsVersion { get; init; }
    public required string AppVersion { get; init; }
    public long? StorageAvailableMb { get; init; }
    public long? StorageTotalMb { get; init; }
    public WindowsFacts? Windows { get; init; }
}
