using CoGrowMDMAgent.Queue;

namespace CoGrowMDMAgent.Tests;

public class RetryBackoffTests
{
    [Theory]
    [InlineData(0, 15)]   // 15min 起步
    [InlineData(1, 30)]
    [InlineData(2, 60)]
    [InlineData(3, 120)]
    [InlineData(4, 240)]
    public void Compute_FollowsExponentialSequence(int attempt, double expectedMinutes)
    {
        Assert.Equal(expectedMinutes, RetryBackoff.Compute(attempt).TotalMinutes, precision: 3);
    }

    [Theory]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(50)]
    [InlineData(int.MaxValue)]
    public void Compute_CapsAtMax(int attempt)
    {
        Assert.Equal(RetryBackoff.Max, RetryBackoff.Compute(attempt));
    }

    [Fact]
    public void Compute_NegativeAttempt_TreatedAsZero()
    {
        Assert.Equal(RetryBackoff.Base, RetryBackoff.Compute(-3));
    }

    [Fact]
    public void Compute_IsMonotonicNonDecreasing()
    {
        var prev = TimeSpan.Zero;
        for (var attempt = 0; attempt <= 10; attempt++)
        {
            var delay = RetryBackoff.Compute(attempt);
            Assert.True(delay >= prev, $"attempt {attempt} regressed: {delay} < {prev}");
            Assert.True(delay <= RetryBackoff.Max, $"attempt {attempt} exceeded cap");
            prev = delay;
        }
    }
}
