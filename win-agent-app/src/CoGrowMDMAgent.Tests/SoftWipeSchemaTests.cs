using System.Text.Json;
using System.Text.Json.Nodes;
using CoGrowMDMAgent.SoftWipe;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// 驗 SoftWipe 上報 payload JSON schema 對齊後端 zod schema
/// （app/routes/v1/agent.ts softWipeResultBody）。
/// </summary>
public class SoftWipeSchemaTests
{
    [Fact]
    public void ResultPayload_Serializes_With_CamelCase_Field_Names()
    {
        var payload = new SoftWipeResultPayload
        {
            WipeId = "abc123-def456",
            SerialNumber = "PF5XSMN1",
            Status = "success",
            DurationMs = 12345,
            Summary = new SoftWipeSummary
            {
                MsiUninstalled = 3,
                MsiFailed = 0,
                UwpUninstalled = 5,
                UwpFailed = 1,
                UserProfilesDeleted = 2,
                UserProfilesFailed = 0,
                BrowserDataCleared = true,
                RecycleBinCleared = true,
                TempCleared = true,
            },
            ErrorTail = null,
        };

        var json = JsonSerializer.Serialize(payload, SoftWipeWatcher.JsonOptions);
        var node = JsonNode.Parse(json)!.AsObject();

        Assert.Equal("abc123-def456", (string?)node["wipeId"]);
        Assert.Equal("PF5XSMN1", (string?)node["serialNumber"]);
        Assert.Equal("success", (string?)node["status"]);
        Assert.Equal(12345L, (long?)node["durationMs"]);
        Assert.Null(node["errorTail"]);   // null fields omitted (WhenWritingNull)

        var s = node["summary"]!.AsObject();
        Assert.Equal(3, (int?)s["msiUninstalled"]);
        Assert.Equal(0, (int?)s["msiFailed"]);
        Assert.Equal(5, (int?)s["uwpUninstalled"]);
        Assert.Equal(1, (int?)s["uwpFailed"]);
        Assert.Equal(2, (int?)s["userProfilesDeleted"]);
        Assert.True((bool?)s["browserDataCleared"]);
        Assert.True((bool?)s["recycleBinCleared"]);
        Assert.True((bool?)s["tempCleared"]);
    }

    [Fact]
    public void ResultPayload_Failed_Status_With_ErrorTail_Included()
    {
        var payload = new SoftWipeResultPayload
        {
            WipeId = "wipe-xyz",
            SerialNumber = "SN",
            Status = "failed",
            DurationMs = 500,
            Summary = new SoftWipeSummary(),
            ErrorTail = "UWP phase: script exit 1",
        };

        var json = JsonSerializer.Serialize(payload, SoftWipeWatcher.JsonOptions);
        var node = JsonNode.Parse(json)!.AsObject();

        Assert.Equal("failed", (string?)node["status"]);
        Assert.Equal("UWP phase: script exit 1", (string?)node["errorTail"]);
    }

    [Fact]
    public void Whitelist_Deserializes_From_Backend_JSON_Shape()
    {
        // 模擬後端 buildSoftWipeTrigger 送過來的 JSON（camelCase）
        const string json = @"{
            ""msiProductCodes"": [""{12345678-1234-1234-1234-123456789ABC}""],
            ""uwpPfns"": [""Microsoft.WindowsCalculator"", ""Microsoft.Windows.Photos""],
            ""wingetIds"": [""7zip.7zip""]
        }";

        var whitelist = JsonSerializer.Deserialize<SoftWipeWhitelist>(
            json, SoftWipeWatcher.JsonOptions);

        Assert.NotNull(whitelist);
        Assert.Single(whitelist!.MsiProductCodes);
        Assert.Equal("{12345678-1234-1234-1234-123456789ABC}", whitelist.MsiProductCodes[0]);
        Assert.Equal(2, whitelist.UwpPfns.Count);
        Assert.Equal("Microsoft.WindowsCalculator", whitelist.UwpPfns[0]);
        Assert.Single(whitelist.WingetIds);
        Assert.Equal("7zip.7zip", whitelist.WingetIds[0]);
    }

    [Fact]
    public void Whitelist_Deserializes_Empty_Arrays()
    {
        const string json = @"{""msiProductCodes"":[],""uwpPfns"":[],""wingetIds"":[]}";
        var whitelist = JsonSerializer.Deserialize<SoftWipeWhitelist>(
            json, SoftWipeWatcher.JsonOptions);
        Assert.NotNull(whitelist);
        Assert.Empty(whitelist!.MsiProductCodes);
        Assert.Empty(whitelist.UwpPfns);
        Assert.Empty(whitelist.WingetIds);
    }

    [Fact]
    public void Status_Values_Cover_All_Three()
    {
        // Enum → string 映射（Watcher 內部邏輯是 switch），這裡驗常量清單
        // 對應後端 zod enum(["success", "partial", "failed"])
        var expected = new[] { "success", "partial", "failed" };
        foreach (var s in expected)
        {
            var payload = new SoftWipeResultPayload
            {
                WipeId = "x",
                SerialNumber = "SN",
                Status = s,
                DurationMs = 0,
                Summary = new SoftWipeSummary(),
            };
            var json = JsonSerializer.Serialize(payload, SoftWipeWatcher.JsonOptions);
            Assert.Contains($"\"status\":\"{s}\"", json);
        }
    }
}
