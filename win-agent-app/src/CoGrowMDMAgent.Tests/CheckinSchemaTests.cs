using System.Text.Json;
using System.Text.Json.Nodes;
using CoGrowMDMAgent.Reporting;

namespace CoGrowMDMAgent.Tests;

public class CheckinSchemaTests
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization
            .JsonIgnoreCondition.WhenWritingNull,
    };

    [Fact]
    public void Checkin_Payload_MatchesServerFieldNames()
    {
        var payload = new AgentCheckinPayload
        {
            SerialNumber = "F2L1234567",
            OsVersion = "10.0.19045.4170",
            AppVersion = "1.3.12.0",
            LapsRotationId = "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
        };

        var json = JsonSerializer.Serialize(payload, JsonOptions);
        var node = JsonNode.Parse(json)!.AsObject();

        Assert.Equal("F2L1234567", (string?)node["serialNumber"]);
        Assert.Equal("10.0.19045.4170", (string?)node["osVersion"]);
        Assert.Equal("1.3.12.0", (string?)node["appVersion"]);
        Assert.Equal("aaaabbbb-cccc-dddd-eeee-ffffffffffff", (string?)node["lapsRotationId"]);
    }

    [Fact]
    public void Checkin_Payload_OmitsNullFields()
    {
        var payload = new AgentCheckinPayload
        {
            SerialNumber = "F2L1234567",
        };

        var json = JsonSerializer.Serialize(payload, JsonOptions);
        var node = JsonNode.Parse(json)!.AsObject();

        Assert.Equal("F2L1234567", (string?)node["serialNumber"]);
        Assert.Null(node["osVersion"]);
        Assert.Null(node["appVersion"]);
        Assert.Null(node["lapsRotationId"]);
    }

    [Fact]
    public void Checkin_Response_Deserializes_WithActions()
    {
        var json = """
        {
          "ok": true,
          "data": {
            "deviceId": "11111111-2222-3333-4444-555555555555",
            "actions": [
              {
                "type": "laps_rotation_pending",
                "priority": 100,
                "data": {
                  "rotationId": "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
                  "adminAccount": "Administrator"
                }
              }
            ]
          }
        }
        """;

        var parsed = JsonSerializer.Deserialize<AgentCheckinResponse>(json);

        Assert.NotNull(parsed);
        Assert.True(parsed!.Ok);
        Assert.NotNull(parsed.Data);
        Assert.Equal("11111111-2222-3333-4444-555555555555", parsed.Data!.DeviceId);
        Assert.NotNull(parsed.Data.Actions);
        Assert.Single(parsed.Data.Actions!);
        Assert.Equal("laps_rotation_pending", parsed.Data.Actions![0].Type);
        Assert.Equal(100, parsed.Data.Actions[0].Priority);
    }

    [Fact]
    public void Checkin_Response_Deserializes_EmptyActions()
    {
        var json = """
        {
          "ok": true,
          "data": {
            "deviceId": "11111111-2222-3333-4444-555555555555",
            "actions": []
          }
        }
        """;

        var parsed = JsonSerializer.Deserialize<AgentCheckinResponse>(json);

        Assert.NotNull(parsed);
        Assert.True(parsed!.Ok);
        Assert.NotNull(parsed.Data?.Actions);
        Assert.Empty(parsed.Data!.Actions!);
    }

    [Fact]
    public void AgentConfig_CheckinUrl_MatchesPattern()
    {
        var config = new CoGrowMDMAgent.Config.AgentConfig
        {
            DeviceId = "dev-1",
            AgentToken = "tok-1",
            ApiEndpoint = "https://mdm.school.edu/api/v1",
            TenantId = "00000000-0000-0000-0000-000000000001",
        };

        Assert.Equal(
            "https://mdm.school.edu/api/v1/tenants/00000000-0000-0000-0000-000000000001/agent/checkin",
            config.CheckinUrl);
    }
}
