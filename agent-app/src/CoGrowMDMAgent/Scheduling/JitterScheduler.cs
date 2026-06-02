using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using CoGrowMDMAgent.Config;

namespace CoGrowMDMAgent.Scheduling;

/// <summary>
/// Daily jittered scheduler. Each device gets a stable minute offset in the
/// 0:00-5:00 UTC window derived from <c>sha256(device_id) % 300</c>.
///
/// Same device → same minute every day, avoiding both per-day drift and the
/// thundering-herd problem when 8000+ devices come online at 00:00.
/// </summary>
public sealed class JitterScheduler
{
    public const int WindowMinutes = 300;

    /// <summary>
    /// 測試用環境變數：設為正整數秒則改用固定間隔輪詢上報（覆蓋每日 jitter slot），
    /// 方便在單台設備上即時驗證端到端上報，不必等一天一次。⚠️ 生產不設此變數。
    /// </summary>
    public const string OverrideIntervalEnvVar = "COGROW_REPORT_INTERVAL_SECONDS";

    private readonly int _offsetMinute;
    private readonly TimeSpan? _overrideInterval;

    public JitterScheduler(AgentConfig config)
        : this(ComputeOffsetMinute(config.DeviceId), ReadOverrideInterval())
    {
    }

    internal JitterScheduler(int offsetMinute)
        : this(offsetMinute, overrideInterval: null)
    {
    }

    internal JitterScheduler(int offsetMinute, TimeSpan? overrideInterval)
    {
        if (offsetMinute < 0 || offsetMinute >= WindowMinutes)
        {
            throw new ArgumentOutOfRangeException(
                nameof(offsetMinute), offsetMinute,
                $"Offset must be in [0, {WindowMinutes})");
        }
        _offsetMinute = offsetMinute;
        _overrideInterval = overrideInterval;
    }

    /// <summary>Stable minute in [0, 300) derived from device id.</summary>
    public int OffsetMinute => _offsetMinute;

    /// <summary>
    /// Next UTC instant the worker should run a report cycle.
    /// If <paramref name="nowUtc"/> is already past today's slot, returns
    /// tomorrow's slot.
    /// </summary>
    public DateTime GetNextRunTime(DateTime nowUtc)
    {
        if (nowUtc.Kind != DateTimeKind.Utc)
        {
            throw new ArgumentException("nowUtc must be UTC", nameof(nowUtc));
        }

        // 測試覆蓋：固定間隔輪詢，繞過每日 slot。
        if (_overrideInterval is { } interval)
        {
            return nowUtc + interval;
        }

        var todaySlot = nowUtc.Date.AddMinutes(_offsetMinute);
        return nowUtc < todaySlot ? todaySlot : todaySlot.AddDays(1);
    }

    /// <summary>讀測試覆蓋間隔；未設 / 非正整數秒 → null（容錯，不崩）。</summary>
    internal static TimeSpan? ReadOverrideInterval()
    {
        var raw = Environment.GetEnvironmentVariable(OverrideIntervalEnvVar);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds)
            && seconds > 0)
        {
            return TimeSpan.FromSeconds(seconds);
        }
        return null;
    }

    internal static int ComputeOffsetMinute(string deviceId)
    {
        ArgumentException.ThrowIfNullOrEmpty(deviceId);
        var bytes = Encoding.UTF8.GetBytes(deviceId);
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        var raw = BitConverter.ToUInt32(hash[..4]);
        return (int)(raw % WindowMinutes);
    }
}
