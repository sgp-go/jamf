using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text.Json;
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
        var network = GetNetwork();

        return new DeviceFacts
        {
            SerialNumber = GetSerialNumber(),
            OsVersion = Environment.OSVersion.VersionString,
            AppVersion = AppVersion,
            StorageAvailableMb = systemDrive.AvailableMb,
            StorageTotalMb = systemDrive.TotalMb,
            BatteryLevel = GetBatteryLevel(),
            NetworkType = network.Type,
            NetworkSsid = network.Ssid,
            Windows = OperatingSystem.IsWindows() ? CollectWindowsFacts() : null,
        };
    }

    /// <summary>序號採集對外暴露（usage 上報只需序號，不必跑完整 Collect）。</summary>
    public string CollectSerialNumber() => GetSerialNumber();

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

    private int? GetBatteryLevel()
    {
        if (!OperatingSystem.IsWindows()) return null;
        try
        {
            return PowerInterop.GetBatteryPercent();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read battery level");
            return null;
        }
    }

    /// <summary>
    /// 取目前有預設閘道（即實際對外）的網卡，映射成 networkType；WiFi 時再解析
    /// SSID。<see cref="NetworkInterface"/> 跨平台可用（dev 機亦可跑），SSID 解析
    /// 僅 Windows。
    /// </summary>
    private (string? Type, string? Ssid) GetNetwork()
    {
        try
        {
            var active = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up
                    && n.NetworkInterfaceType != NetworkInterfaceType.Loopback
                    && n.NetworkInterfaceType != NetworkInterfaceType.Tunnel)
                .FirstOrDefault(n => n.GetIPProperties().GatewayAddresses
                    .Any(g => g.Address is not null && !g.Address.Equals(IPAddress.Any)));

            if (active is null) return (null, null);

            var type = active.NetworkInterfaceType switch
            {
                NetworkInterfaceType.Wireless80211 => "WiFi",
                NetworkInterfaceType.Ethernet
                    or NetworkInterfaceType.GigabitEthernet
                    or NetworkInterfaceType.FastEthernetT
                    or NetworkInterfaceType.FastEthernetFx => "Ethernet",
                _ => active.NetworkInterfaceType.ToString(),
            };

            var ssid = (type == "WiFi" && OperatingSystem.IsWindows())
                ? TryWifiSsid()
                : null;

            return (type, ssid);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read network info");
            return (null, null);
        }
    }

    [SupportedOSPlatform("windows")]
    private string? TryWifiSsid()
    {
        // netsh wlan show interfaces 解析 SSID。⚠️ 輸出在地化（[[ps5-sc-locale-binary-parse]]）：
        // 不依賴在地化欄位名，只匹配行首 ASCII "SSID"（排除 "BSSID"），值在冒號後。
        // 拿不到（無 WiFi 介面 / 服務未啟）回 null，不阻斷上報。
        try
        {
            var psi = new ProcessStartInfo("netsh", "wlan show interfaces")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return null;
            var output = proc.StandardOutput.ReadToEnd();
            if (!proc.WaitForExit(2000)) { proc.Kill(); return null; }

            foreach (var raw in output.Split('\n'))
            {
                var line = raw.Trim();
                if (line.StartsWith("SSID", StringComparison.OrdinalIgnoreCase)
                    && !line.StartsWith("BSSID", StringComparison.OrdinalIgnoreCase))
                {
                    var colon = line.IndexOf(':');
                    if (colon < 0) continue;
                    var value = line[(colon + 1)..].Trim();
                    return string.IsNullOrEmpty(value) ? null : value;
                }
            }
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "netsh wlan ssid probe failed");
            return null;
        }
    }

    [SupportedOSPlatform("windows")]
    private WindowsFacts CollectWindowsFacts()
    {
        return new WindowsFacts
        {
            WingetVersion = TryWingetVersion(),
            IsLocalAdmin = IsCurrentUserLocalAdmin(),
            DefenderEnabled = null,
            FirewallEnabled = null,
            PendingUpdates = null,
            Laps = ReadLapsConfirmation(),
            BitLocker = ReadBitLockerStatus(),
        };
    }

    /// <summary>
    /// 讀取 LAPS 確認檔（LapsWatcher 改密成功後寫入）。讀到後刪除，
    /// 確保只上報一次。解析失敗靜默返回 null。
    /// </summary>
    private LapsFacts? ReadLapsConfirmation()
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CoGrow", "MDM Agent", "laps-confirmation.json");
            if (!File.Exists(path)) return null;

            var json = File.ReadAllText(path);
            var data = JsonSerializer.Deserialize<LapsFacts>(json);
            if (data?.RotationId is null) return null;

            File.Delete(path);
            _logger.LogInformation("LAPS 確認檔已讀取並刪除: rotation={RotationId}", data.RotationId);
            return data;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "LAPS confirmation read failed");
            return null;
        }
    }

    /// <summary>
    /// 透過 WMI Win32_EncryptableVolume 查詢系統碟 BitLocker 狀態。
    /// 需要 SYSTEM 或管理員權限。失敗靜默返回 null。
    /// </summary>
    [SupportedOSPlatform("windows")]
    private BitLockerFacts? ReadBitLockerStatus()
    {
        try
        {
            using var searcher = new System.Management.ManagementObjectSearcher(
                @"root\cimv2\Security\MicrosoftVolumeEncryption",
                "SELECT * FROM Win32_EncryptableVolume WHERE DriveLetter = 'C:'");

            foreach (System.Management.ManagementObject vol in searcher.Get())
            {
                var protectionStatus = vol["ProtectionStatus"]?.ToString() switch
                {
                    "0" => "Off",
                    "1" => "On",
                    "2" => "Unknown",
                    _ => vol["ProtectionStatus"]?.ToString(),
                };

                var conversionArgs = vol.GetMethodParameters("GetConversionStatus");
                var conversionResult = vol.InvokeMethod("GetConversionStatus", conversionArgs, null);
                var encPercentage = conversionResult?["EncryptionPercentage"] is uint pct
                    ? (int)pct : (int?)null;

                var encMethodArgs = vol.GetMethodParameters("GetEncryptionMethod");
                var encMethod = vol.InvokeMethod("GetEncryptionMethod", encMethodArgs, null);
                var methodValue = encMethod?["EncryptionMethod"]?.ToString() switch
                {
                    "0" => "None",
                    "1" => "AES-CBC-128-Diffuser",
                    "2" => "AES-CBC-256-Diffuser",
                    "3" => "AES-CBC-128",
                    "4" => "AES-CBC-256",
                    "6" => "XTS-AES-128",
                    "7" => "XTS-AES-256",
                    var v => v,
                };

                var volumeStatus = conversionResult?["ConversionStatus"]?.ToString() switch
                {
                    "0" => "FullyDecrypted",
                    "1" => "FullyEncrypted",
                    "2" => "EncryptionInProgress",
                    "3" => "DecryptionInProgress",
                    "4" => "EncryptionPaused",
                    "5" => "DecryptionPaused",
                    var v => v,
                };

                var kpArgs = vol.GetMethodParameters("GetKeyProtectors");
                kpArgs["KeyProtectorType"] = (uint)0;
                var kpResult = vol.InvokeMethod("GetKeyProtectors", kpArgs, null);
                var kpIds = kpResult?["VolumeKeyProtectorID"] as string[];
                var kpTypes = new List<string>();
                if (kpIds != null)
                {
                    foreach (var kpId in kpIds)
                    {
                        var typeArgs = vol.GetMethodParameters("GetKeyProtectorType");
                        typeArgs["VolumeKeyProtectorID"] = kpId;
                        var typeResult = vol.InvokeMethod("GetKeyProtectorType", typeArgs, null);
                        var kpType = typeResult?["KeyProtectorType"]?.ToString() switch
                        {
                            "1" => "TPM",
                            "2" => "ExternalKey",
                            "3" => "NumericalPassword",
                            "4" => "TPMAndPIN",
                            "5" => "TPMAndStartupKey",
                            "6" => "TPMAndPINAndStartupKey",
                            "7" => "PublicKey",
                            "8" => "Passphrase",
                            "9" => "TPMCertificate",
                            "10" => "SID",
                            var v => v,
                        };
                        if (kpType != null) kpTypes.Add(kpType);
                    }
                }

                var confirmation = ReadBitLockerConfirmation();

                return new BitLockerFacts
                {
                    ProtectionStatus = protectionStatus,
                    EncryptionPercentage = encPercentage,
                    EncryptionMethod = methodValue,
                    VolumeStatus = volumeStatus,
                    KeyProtectorTypes = kpTypes.Count > 0 ? kpTypes : null,
                    EncryptionId = confirmation?.EncryptionId,
                    RecoveryPassword = confirmation?.RecoveryPassword,
                };
            }
            return ReadBitLockerConfirmationAsFacts();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "BitLocker status read failed");
            return ReadBitLockerConfirmationAsFacts();
        }
    }

    private BitLockerFacts? ReadBitLockerConfirmationAsFacts()
    {
        var c = ReadBitLockerConfirmation();
        if (c == null) return null;
        return new BitLockerFacts
        {
            EncryptionId = c.EncryptionId,
            RecoveryPassword = c.RecoveryPassword,
        };
    }

    private BitLockerConfirmationFile? ReadBitLockerConfirmation()
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CoGrow", "MDM Agent", "bitlocker-confirmation.json");
            if (!File.Exists(path)) return null;

            var json = File.ReadAllText(path);
            var data = System.Text.Json.JsonSerializer.Deserialize<BitLockerConfirmationFile>(json);
            if (data?.EncryptionId is null) return null;

            File.Delete(path);
            _logger.LogInformation("BitLocker 確認檔已讀取並刪除: encryptionId={EncryptionId}", data.EncryptionId);
            return data;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "BitLocker confirmation read failed");
            return null;
        }
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
    public int? BatteryLevel { get; init; }
    public string? NetworkType { get; init; }
    public string? NetworkSsid { get; init; }
    public WindowsFacts? Windows { get; init; }
}

internal sealed record BitLockerConfirmationFile
{
    [System.Text.Json.Serialization.JsonPropertyName("encryption_id")]
    public string? EncryptionId { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("recovery_password")]
    public string? RecoveryPassword { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("confirmed_at")]
    public string? ConfirmedAt { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("success")]
    public bool Success { get; init; }
}
