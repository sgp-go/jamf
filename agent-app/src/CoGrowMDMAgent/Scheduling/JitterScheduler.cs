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

    private readonly int _offsetMinute;

    public JitterScheduler(AgentConfig config)
        : this(ComputeOffsetMinute(config.DeviceId))
    {
    }

    internal JitterScheduler(int offsetMinute)
    {
        if (offsetMinute < 0 || offsetMinute >= WindowMinutes)
        {
            throw new ArgumentOutOfRangeException(
                nameof(offsetMinute), offsetMinute,
                $"Offset must be in [0, {WindowMinutes})");
        }
        _offsetMinute = offsetMinute;
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

        var todaySlot = nowUtc.Date.AddMinutes(_offsetMinute);
        return nowUtc < todaySlot ? todaySlot : todaySlot.AddDays(1);
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
