using CoGrowMDMAgent.Reporting;
using CoGrowMDMAgent.Reporting.Usage;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// <see cref="UsageSignature"/> 跨語言一致性測試：斷言與後端
/// <c>usage-signature.test.ts</c> 完全相同的向量 hex。任一端改 canonical
/// 格式或 HMAC 計算，兩端測試同時變紅 —— 鎖住兩端契約。
/// </summary>
public class UsageSignatureTests
{
    private const string Token = "test-token-123";
    private const string ExpectedCanonical =
        "F2L0001\n\n2026-06-01|120|15|45|9=30,10=25,14=65";
    private const string ExpectedHex =
        "73ac28e55b7bf02a722bbfb1c4ebd5ad7416f07a75c12afa3de8c98fb82bc33c";

    private static UsageStatsPayload Vector() => new()
    {
        SerialNumber = "F2L0001",
        SessionId = null,
        Stats = new[]
        {
            new UsageStatItem
            {
                Date = "2026-06-01",
                TotalMinutes = 120,
                Pickup = 15,
                MaxContinuous = 45,
                TimeStats = new Dictionary<string, int> { ["9"] = 30, ["10"] = 25, ["14"] = 65 },
            },
        },
    };

    [Fact]
    public void CanonicalMessage_matches_cross_language_contract()
    {
        Assert.Equal(ExpectedCanonical, UsageSignature.CanonicalMessage(Vector()));
    }

    [Fact]
    public void Compute_matches_backend_hex_vector()
    {
        Assert.Equal(ExpectedHex, UsageSignature.Compute(Token, Vector()));
    }

    [Fact]
    public void Compute_changes_when_payload_tampered()
    {
        var tampered = Vector() with
        {
            Stats = new[]
            {
                new UsageStatItem
                {
                    Date = "2026-06-01",
                    TotalMinutes = 5, // 少報
                    Pickup = 15,
                    MaxContinuous = 45,
                    TimeStats = new Dictionary<string, int> { ["9"] = 30, ["10"] = 25, ["14"] = 65 },
                },
            },
        };
        Assert.NotEqual(ExpectedHex, UsageSignature.Compute(Token, tampered));
    }

    [Fact]
    public void TimeStats_sorted_numerically_not_lexically()
    {
        var payload = new UsageStatsPayload
        {
            SerialNumber = "S",
            SessionId = null,
            Stats = new[]
            {
                new UsageStatItem
                {
                    Date = "2026-06-01",
                    TotalMinutes = 1,
                    Pickup = 0,
                    MaxContinuous = 1,
                    TimeStats = new Dictionary<string, int> { ["10"] = 3, ["2"] = 1, ["9"] = 2 },
                },
            },
        };
        // 2 < 9 < 10（數值序），非 "10" < "2" < "9"（字典序）
        Assert.EndsWith("2=1,9=2,10=3", UsageSignature.CanonicalMessage(payload));
    }
}
