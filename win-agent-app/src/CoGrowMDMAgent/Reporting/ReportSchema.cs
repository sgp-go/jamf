using System.Text.Json.Serialization;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// DTO matching POST /api/v1/tenants/{tenantId}/agent/reports body
/// (app/routes/v1/agent.ts, reportBody schema).
/// </summary>
public sealed record AgentReportPayload
{
    [JsonPropertyName("serialNumber")]
    public required string SerialNumber { get; init; }

    [JsonPropertyName("udid")]
    public string? Udid { get; init; }

    [JsonPropertyName("batteryLevel")]
    public int? BatteryLevel { get; init; }

    [JsonPropertyName("storageAvailableMb")]
    public long? StorageAvailableMb { get; init; }

    [JsonPropertyName("storageTotalMb")]
    public long? StorageTotalMb { get; init; }

    [JsonPropertyName("networkType")]
    public string? NetworkType { get; init; }

    [JsonPropertyName("networkSsid")]
    public string? NetworkSsid { get; init; }

    [JsonPropertyName("osVersion")]
    public string? OsVersion { get; init; }

    [JsonPropertyName("appVersion")]
    public string? AppVersion { get; init; }

    /// <summary>Windows hostname; backend writes it to mdm_devices.device_name.</summary>
    [JsonPropertyName("deviceName")]
    public string? DeviceName { get; init; }

    /// <summary>"Manufacturer Model" (Win32_ComputerSystem); backend writes to mdm_devices.model.</summary>
    [JsonPropertyName("model")]
    public string? Model { get; init; }

    [JsonPropertyName("extraData")]
    public WindowsExtraData? ExtraData { get; init; }

    [JsonPropertyName("reportedAt")]
    public string? ReportedAt { get; init; }
}

/// <summary>
/// extraData recommended structure per OpenAPI description in
/// app/routes/v1/agent.ts (Windows extraData section).
/// </summary>
public sealed record WindowsExtraData
{
    [JsonPropertyName("platform")]
    public string Platform { get; init; } = "windows";

    [JsonPropertyName("windows")]
    public required WindowsFacts Windows { get; init; }
}

public sealed record WindowsFacts
{
    [JsonPropertyName("winget_version")]
    public string? WingetVersion { get; init; }

    [JsonPropertyName("defender_enabled")]
    public bool? DefenderEnabled { get; init; }

    [JsonPropertyName("firewall_enabled")]
    public bool? FirewallEnabled { get; init; }

    [JsonPropertyName("pending_updates")]
    public int? PendingUpdates { get; init; }

    [JsonPropertyName("is_local_admin")]
    public bool? IsLocalAdmin { get; init; }

    [JsonPropertyName("laps")]
    public LapsFacts? Laps { get; init; }

    [JsonPropertyName("bitlocker")]
    public BitLockerFacts? BitLocker { get; init; }
}

public sealed record LapsFacts
{
    [JsonPropertyName("rotation_id")]
    public string? RotationId { get; init; }

    [JsonPropertyName("confirmed_at")]
    public string? ConfirmedAt { get; init; }

    [JsonPropertyName("success")]
    public bool? Success { get; init; }
}

public sealed record BitLockerFacts
{
    [JsonPropertyName("protection_status")]
    public string? ProtectionStatus { get; init; }

    [JsonPropertyName("encryption_percentage")]
    public int? EncryptionPercentage { get; init; }

    [JsonPropertyName("encryption_method")]
    public string? EncryptionMethod { get; init; }

    [JsonPropertyName("volume_status")]
    public string? VolumeStatus { get; init; }

    [JsonPropertyName("key_protector_types")]
    public IReadOnlyList<string>? KeyProtectorTypes { get; init; }

    [JsonPropertyName("encryption_id")]
    public string? EncryptionId { get; init; }

    [JsonPropertyName("recovery_password")]
    public string? RecoveryPassword { get; init; }
}

/// <summary>
/// Server response: { ok: true, data: { reportId, deviceId } }.
/// </summary>
public sealed record AgentReportResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("data")]
    public AgentReportResponseData? Data { get; init; }
}

public sealed record AgentReportResponseData
{
    [JsonPropertyName("reportId")]
    public string? ReportId { get; init; }

    [JsonPropertyName("deviceId")]
    public string? DeviceId { get; init; }
}

// ---- Checkin payload ----

public sealed record AgentCheckinPayload
{
    [JsonPropertyName("serialNumber")]
    public required string SerialNumber { get; init; }

    [JsonPropertyName("osVersion")]
    public string? OsVersion { get; init; }

    [JsonPropertyName("appVersion")]
    public string? AppVersion { get; init; }

    [JsonPropertyName("lapsRotationId")]
    public string? LapsRotationId { get; init; }
}

public sealed record AgentCheckinAction
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = "";

    [JsonPropertyName("priority")]
    public int Priority { get; init; }

    [JsonPropertyName("data")]
    public Dictionary<string, object>? Data { get; init; }
}

public sealed record AgentCheckinResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("data")]
    public AgentCheckinResponseData? Data { get; init; }
}

public sealed record AgentCheckinResponseData
{
    [JsonPropertyName("deviceId")]
    public string? DeviceId { get; init; }

    [JsonPropertyName("actions")]
    public IReadOnlyList<AgentCheckinAction>? Actions { get; init; }
}

// ---- winget result payload (POST /agent/winget-result) ----

public sealed record WingetResultPayload
{
    [JsonPropertyName("serialNumber")]
    public required string SerialNumber { get; init; }

    [JsonPropertyName("commandId")]
    public required string CommandId { get; init; }

    [JsonPropertyName("exitCode")]
    public required int ExitCode { get; init; }

    /// <summary>success | failed | already-installed | not-found</summary>
    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("installedVersion")]
    public string? InstalledVersion { get; init; }

    [JsonPropertyName("stdoutTail")]
    public string? StdoutTail { get; init; }

    [JsonPropertyName("stderrTail")]
    public string? StderrTail { get; init; }

    [JsonPropertyName("durationMs")]
    public required long DurationMs { get; init; }
}

// ---- Usage payload ----

public sealed record UsageStatsPayload
{
    [JsonPropertyName("serialNumber")]
    public required string SerialNumber { get; init; }

    [JsonPropertyName("sessionId")]
    public string? SessionId { get; init; }

    [JsonPropertyName("stats")]
    public required IReadOnlyList<UsageStatItem> Stats { get; init; }
}

public sealed record UsageStatItem
{
    [JsonPropertyName("date")]
    public required string Date { get; init; }

    [JsonPropertyName("totalMinutes")]
    public required int TotalMinutes { get; init; }

    [JsonPropertyName("pickup")]
    public required int Pickup { get; init; }

    [JsonPropertyName("maxContinuous")]
    public required int MaxContinuous { get; init; }

    [JsonPropertyName("timeStats")]
    public Dictionary<string, int>? TimeStats { get; init; }
}
