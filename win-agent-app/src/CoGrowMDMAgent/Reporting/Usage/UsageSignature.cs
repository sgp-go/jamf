using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using CoGrowMDMAgent.Reporting;

namespace CoGrowMDMAgent.Reporting.Usage;

/// <summary>
/// 使用統計上報的 HMAC 簽名（防篡改第 3 層，輕量版）。密鑰＝per-device
/// agent_token；後端鑑權時拿到同一 token 原文驗簽，無需額外密鑰下發。
///
/// <para>⚠️ 規範化格式必須與後端 <c>app/services/usage-signature.ts</c> 逐字節
/// 一致。兩端各有單元測試對同一向量斷言同一 hex（<c>UsageSignatureTests</c> /
/// <c>usage-signature.test.ts</c>），改任一端 canonical 即兩端紅。</para>
/// </summary>
internal static class UsageSignature
{
    /// <summary>
    /// 規範化字串：
    /// <code>
    /// line 0: serialNumber
    /// line 1: sessionId（null → 空）
    /// line 2..: date|totalMinutes|pickup|maxContinuous|timeStats
    ///           timeStats: hour 數字升序 "hour=minutes" 以 "," join（無則空）
    /// </code>
    /// 行間以 "\n" 連接。
    /// </summary>
    public static string CanonicalMessage(UsageStatsPayload payload)
    {
        var sb = new StringBuilder();
        sb.Append(payload.SerialNumber);
        sb.Append('\n');
        sb.Append(payload.SessionId ?? string.Empty);
        foreach (var stat in payload.Stats)
        {
            sb.Append('\n');
            sb.Append(stat.Date);
            sb.Append('|');
            sb.Append(stat.TotalMinutes.ToString(CultureInfo.InvariantCulture));
            sb.Append('|');
            sb.Append(stat.Pickup.ToString(CultureInfo.InvariantCulture));
            sb.Append('|');
            sb.Append(stat.MaxContinuous.ToString(CultureInfo.InvariantCulture));
            sb.Append('|');
            sb.Append(CanonicalTimeStats(stat.TimeStats));
        }
        return sb.ToString();
    }

    private static string CanonicalTimeStats(Dictionary<string, int>? timeStats)
    {
        if (timeStats is null || timeStats.Count == 0) return string.Empty;
        return string.Join(
            ",",
            timeStats
                .Select(kv => (Hour: int.Parse(kv.Key, CultureInfo.InvariantCulture), kv.Value))
                .OrderBy(x => x.Hour)
                .Select(x => $"{x.Hour.ToString(CultureInfo.InvariantCulture)}={x.Value.ToString(CultureInfo.InvariantCulture)}"));
    }

    /// <summary>HMAC-SHA256(key=token, CanonicalMessage) → lowercase hex。</summary>
    public static string Compute(string token, UsageStatsPayload payload)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(token));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(CanonicalMessage(payload)));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
