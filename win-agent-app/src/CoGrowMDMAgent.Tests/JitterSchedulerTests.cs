using CoGrowMDMAgent.Scheduling;

namespace CoGrowMDMAgent.Tests;

public class JitterSchedulerTests
{
    [Fact]
    public void OffsetMinute_IsDeterministic_ForSameDeviceId()
    {
        const string deviceId = "8b8e0b4e-1f4a-4c2c-9a3b-1f7d2c0e1a3d";

        var a = JitterScheduler.ComputeOffsetMinute(deviceId);
        var b = JitterScheduler.ComputeOffsetMinute(deviceId);

        Assert.Equal(a, b);
    }

    [Fact]
    public void OffsetMinute_FallsInWindow()
    {
        // Sample 200 random-looking ids; every offset must be in [0, 300).
        var rnd = new Random(42);
        for (var i = 0; i < 200; i++)
        {
            var deviceId = Guid.NewGuid().ToString();
            var offset = JitterScheduler.ComputeOffsetMinute(deviceId);
            Assert.InRange(offset, 0, JitterScheduler.WindowMinutes - 1);
            _ = rnd;
        }
    }

    [Fact]
    public void OffsetMinute_DiffersAcrossDevices()
    {
        // Distinct ids should mostly map to distinct minutes — we only assert
        // that we get more than one bucket across 50 random ids.
        var buckets = new HashSet<int>();
        for (var i = 0; i < 50; i++)
        {
            buckets.Add(JitterScheduler.ComputeOffsetMinute(Guid.NewGuid().ToString()));
        }
        Assert.True(buckets.Count > 5, "Expected reasonable spread across ids");
    }

    [Fact]
    public void GetNextRunTime_BeforeTodaySlot_ReturnsTodaySlot()
    {
        var scheduler = new JitterScheduler(offsetMinute: 137);
        var todayBase = new DateTime(2026, 5, 26, 0, 0, 0, DateTimeKind.Utc);
        var nowBeforeSlot = todayBase.AddHours(1); // 01:00 < 02:17 slot

        var next = scheduler.GetNextRunTime(nowBeforeSlot);

        Assert.Equal(todayBase.AddMinutes(137), next);
    }

    [Fact]
    public void GetNextRunTime_AfterTodaySlot_ReturnsTomorrowSlot()
    {
        var scheduler = new JitterScheduler(offsetMinute: 137);
        var todayBase = new DateTime(2026, 5, 26, 0, 0, 0, DateTimeKind.Utc);
        var nowAfterSlot = todayBase.AddHours(6); // 06:00 > 02:17 slot

        var next = scheduler.GetNextRunTime(nowAfterSlot);

        Assert.Equal(todayBase.AddDays(1).AddMinutes(137), next);
    }

    [Fact]
    public void GetNextRunTime_AtExactSlot_ReturnsTomorrow()
    {
        var scheduler = new JitterScheduler(offsetMinute: 100);
        var todayBase = new DateTime(2026, 5, 26, 0, 0, 0, DateTimeKind.Utc);
        var nowAtSlot = todayBase.AddMinutes(100);

        var next = scheduler.GetNextRunTime(nowAtSlot);

        Assert.Equal(todayBase.AddDays(1).AddMinutes(100), next);
    }

    [Fact]
    public void GetNextRunTime_RejectsNonUtcInput()
    {
        var scheduler = new JitterScheduler(offsetMinute: 0);
        var local = new DateTime(2026, 5, 26, 0, 0, 0, DateTimeKind.Local);

        Assert.Throws<ArgumentException>(() => scheduler.GetNextRunTime(local));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(300)]
    [InlineData(1000)]
    public void Constructor_RejectsOutOfRangeOffset(int offset)
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new JitterScheduler(offsetMinute: offset));
    }

    [Fact]
    public void GetNextRunTime_WithOverrideInterval_IgnoresDailySlot()
    {
        // 測試覆蓋：固定 60s 間隔，從 now 起算，不管 daily slot。
        var scheduler = new JitterScheduler(
            offsetMinute: 137, overrideInterval: TimeSpan.FromSeconds(60));
        var now = new DateTime(2026, 5, 26, 9, 30, 0, DateTimeKind.Utc);

        var next = scheduler.GetNextRunTime(now);

        Assert.Equal(now.AddSeconds(60), next);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("0", false)]
    [InlineData("-5", false)]
    [InlineData("abc", false)]
    [InlineData("60", true)]
    public void ReadOverrideInterval_ParsesEnvVar(string? raw, bool expectInterval)
    {
        var original = Environment.GetEnvironmentVariable(JitterScheduler.OverrideIntervalEnvVar);
        try
        {
            Environment.SetEnvironmentVariable(JitterScheduler.OverrideIntervalEnvVar, raw);
            var result = JitterScheduler.ReadOverrideInterval();
            if (expectInterval)
                Assert.Equal(TimeSpan.FromSeconds(60), result);
            else
                Assert.Null(result);
        }
        finally
        {
            Environment.SetEnvironmentVariable(JitterScheduler.OverrideIntervalEnvVar, original);
        }
    }
}
