using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Reporting;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Enrollment;

/// <summary>
/// Intune 共存自註冊背景服務：開機時確保設備已有 per-device token。
///
/// Program.cs 已在 <c>host.Run()</c> 前跑一次同步嘗試（讓 JitterScheduler / AgentConfig
/// 快照拿到真 DeviceId，避免整批 Intune 設備同 offset 導致上報錯峰塌縮）；本服務是「開機時
/// 網路未就緒」的重試兜底：每 <see cref="RetryInterval"/> 重試直到成功、或判定非自註冊模式。
/// 成功後 <see cref="AgentConfigProvider.TryReload"/> 讓 provider 立即用上新 token（免重啟）。
/// </summary>
public sealed class AgentEnrollmentService : BackgroundService
{
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(30);

    private readonly HttpClient _http;
    private readonly RegistryConfig _registryConfig;
    private readonly AgentConfigProvider _configProvider;
    private readonly DeviceFactsCollector _facts;
    private readonly ILogger<AgentEnrollmentService> _logger;

    public AgentEnrollmentService(
        HttpClient http,
        RegistryConfig registryConfig,
        AgentConfigProvider configProvider,
        DeviceFactsCollector facts,
        ILogger<AgentEnrollmentService> logger)
    {
        _http = http;
        _registryConfig = registryConfig;
        _configProvider = configProvider;
        _facts = facts;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var outcome = await AgentEnrollment.EnsureEnrolledAsync(
                _registryConfig, _http, _facts.CollectSerialNumber, _logger, stoppingToken);

            switch (outcome)
            {
                case EnrollmentOutcome.Enrolled:
                    // 熱重載：讓其餘服務下個週期即讀到新 token（本進程內即時生效）。
                    _configProvider.TryReload();
                    return;
                case EnrollmentOutcome.AlreadyEnrolled:
                case EnrollmentOutcome.NotConfigured:
                    return;
                case EnrollmentOutcome.Failed:
                    try
                    {
                        await Task.Delay(RetryInterval, stoppingToken);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                    break;
            }
        }
    }
}
