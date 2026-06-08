using System.Text.Json;
using System.Text.Json.Nodes;
using CoGrowMDMAgent.Reporting;

namespace CoGrowMDMAgent.Tests;

public class ReportSchemaTests
{
    [Fact]
    public void Serialized_Report_Matches_Server_FieldNames()
    {
        var payload = new AgentReportPayload
        {
            SerialNumber = "F2L1234567",
            OsVersion = "Windows 11 Pro 23H2",
            AppVersion = "1.0.0",
            StorageAvailableMb = 12345,
            StorageTotalMb = 67890,
            ExtraData = new WindowsExtraData
            {
                Windows = new WindowsFacts
                {
                    WingetVersion = "1.7.10861",
                    DefenderEnabled = true,
                    FirewallEnabled = true,
                    PendingUpdates = 3,
                    IsLocalAdmin = false,
                },
            },
            ReportedAt = "2026-05-26T03:14:15Z",
        };

        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            DefaultIgnoreCondition = System.Text.Json.Serialization
                .JsonIgnoreCondition.WhenWritingNull,
        });
        var node = JsonNode.Parse(json)!.AsObject();

        Assert.Equal("F2L1234567", (string?)node["serialNumber"]);
        Assert.Equal("Windows 11 Pro 23H2", (string?)node["osVersion"]);
        Assert.Equal(12345, (long?)node["storageAvailableMb"]);
        Assert.Null(node["batteryLevel"]); // null fields omitted
        Assert.Null(node["udid"]);

        var extra = node["extraData"]!.AsObject();
        Assert.Equal("windows", (string?)extra["platform"]);
        var win = extra["windows"]!.AsObject();
        Assert.Equal("1.7.10861", (string?)win["winget_version"]);
        Assert.Equal(true, (bool?)win["defender_enabled"]);
        Assert.Equal(3, (int?)win["pending_updates"]);
        Assert.Equal(false, (bool?)win["is_local_admin"]);
    }

    [Fact]
    public void Report_SerializesAlignedDeviceFields_BatteryAndNetwork()
    {
        // 對齊 iOS 端 report payload：batteryLevel / networkType / networkSsid
        var payload = new AgentReportPayload
        {
            SerialNumber = "F2L1234567",
            OsVersion = "Microsoft Windows NT 10.0.19045.0",
            AppVersion = "1.3.1.0",
            BatteryLevel = 87,
            NetworkType = "WiFi",
            NetworkSsid = "Campus-WLAN",
            ReportedAt = "2026-06-01T03:14:15Z",
        };

        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            DefaultIgnoreCondition = System.Text.Json.Serialization
                .JsonIgnoreCondition.WhenWritingNull,
        });
        var node = JsonNode.Parse(json)!.AsObject();

        Assert.Equal(87, (int?)node["batteryLevel"]);
        Assert.Equal("WiFi", (string?)node["networkType"]);
        Assert.Equal("Campus-WLAN", (string?)node["networkSsid"]);
    }

    [Fact]
    public void Usage_Payload_SerializesStatsArray()
    {
        var payload = new UsageStatsPayload
        {
            SerialNumber = "F2L9999999",
            SessionId = "sess-1",
            Stats = new[]
            {
                new UsageStatItem
                {
                    Date = "2026-05-26",
                    TotalMinutes = 240,
                    Pickup = 18,
                    MaxContinuous = 65,
                },
            },
        };

        var json = JsonSerializer.Serialize(payload);
        var node = JsonNode.Parse(json)!.AsObject();

        Assert.Equal("F2L9999999", (string?)node["serialNumber"]);
        var stats = node["stats"]!.AsArray();
        Assert.Single(stats);
        Assert.Equal("2026-05-26", (string?)stats[0]!["date"]);
        Assert.Equal(240, (int?)stats[0]!["totalMinutes"]);
        Assert.Equal(65, (int?)stats[0]!["maxContinuous"]);
    }
}
