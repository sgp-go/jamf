using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// 掃 registry Uninstall keys 收集 MSI / Win32 已裝軟體清單。
///
/// 掃三個 hive（順序上優先 HKLM 64bit，遇同 key 名以先掃到為準）：
///   HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*        （64bit + 32bit 混）
///   HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\* （32bit 專用視圖）
///   HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*        （user-scope 軟體）
///
/// 過濾規則（跟 Windows「新增/移除程式」一致）：
///   - 有 DisplayName + UninstallString 才算「可見軟體」
///   - SystemComponent=1 排除（系統元件不算）
///   - ParentKeyName 有值排除（子件不獨立列）
///   - ReleaseType != null 且非 "Application" 排除（Update / Patch 等）
///
/// 輸出 payload 直送 InstalledAppsReporter。
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class InstalledAppsCollector
{
    private readonly ILogger<InstalledAppsCollector> _logger;

    public InstalledAppsCollector(ILogger<InstalledAppsCollector> logger)
    {
        _logger = logger;
    }

    public IReadOnlyList<InstalledApp> Collect()
    {
        var seen = new Dictionary<string, InstalledApp>(StringComparer.OrdinalIgnoreCase);

        void Scan(RegistryHive hive, RegistryView view)
        {
            try
            {
                using var root = RegistryKey.OpenBaseKey(hive, view);
                using var uninstall = root.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
                if (uninstall == null) return;

                foreach (var keyName in uninstall.GetSubKeyNames())
                {
                    if (seen.ContainsKey(keyName)) continue;
                    using var sub = uninstall.OpenSubKey(keyName);
                    if (sub == null) continue;
                    var app = TryParse(keyName, sub);
                    if (app != null) seen[keyName] = app;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex, "Failed to scan uninstall keys hive={Hive} view={View}",
                    hive, view);
            }
        }

        Scan(RegistryHive.LocalMachine, RegistryView.Registry64);
        Scan(RegistryHive.LocalMachine, RegistryView.Registry32);
        Scan(RegistryHive.CurrentUser, RegistryView.Default);

        var result = seen.Values.ToList();
        _logger.LogInformation("Collected {Count} installed MSI/Win32 apps", result.Count);
        return result;
    }

    private static InstalledApp? TryParse(string keyName, RegistryKey key)
    {
        var displayName = (key.GetValue("DisplayName") as string)?.Trim();
        var uninstallString = (key.GetValue("UninstallString") as string)?.Trim();
        if (string.IsNullOrEmpty(displayName) || string.IsNullOrEmpty(uninstallString)) return null;

        // Windows「新增/移除程式」過濾邏輯
        if (Convert.ToInt32(key.GetValue("SystemComponent") ?? 0) == 1) return null;
        var parentKeyName = (key.GetValue("ParentKeyName") as string)?.Trim();
        if (!string.IsNullOrEmpty(parentKeyName)) return null;
        var releaseType = (key.GetValue("ReleaseType") as string)?.Trim();
        if (!string.IsNullOrEmpty(releaseType)
            && !releaseType.Equals("Application", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var displayVersion = (key.GetValue("DisplayVersion") as string)?.Trim();
        var publisher = (key.GetValue("Publisher") as string)?.Trim();
        var installDate = NormalizeInstallDate(key.GetValue("InstallDate") as string);
        long? estimatedSizeKb = null;
        var rawSize = key.GetValue("EstimatedSize");
        if (rawSize is int iSize && iSize > 0) estimatedSizeKb = iSize;
        else if (rawSize is long lSize && lSize > 0) estimatedSizeKb = lSize;

        return new InstalledApp
        {
            UninstallKey = keyName,
            DisplayName = displayName,
            DisplayVersion = string.IsNullOrEmpty(displayVersion) ? null : displayVersion,
            Publisher = string.IsNullOrEmpty(publisher) ? null : publisher,
            InstallDate = installDate,
            EstimatedSizeKb = estimatedSizeKb,
            UninstallString = uninstallString,
        };
    }

    /// <summary>Registry InstallDate 是 "YYYYMMDD" → 轉 "YYYY-MM-DD"；空/非法回 null。</summary>
    private static string? NormalizeInstallDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.Length != 8) return null;
        if (!int.TryParse(raw, out _)) return null;
        return $"{raw[..4]}-{raw.Substring(4, 2)}-{raw.Substring(6, 2)}";
    }
}

public sealed record InstalledApp
{
    public required string UninstallKey { get; init; }
    public required string DisplayName { get; init; }
    public string? DisplayVersion { get; init; }
    public string? Publisher { get; init; }
    public string? InstallDate { get; init; }
    public long? EstimatedSizeKb { get; init; }
    public string? UninstallString { get; init; }
}
