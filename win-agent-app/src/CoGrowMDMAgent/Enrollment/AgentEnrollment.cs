using CoGrowMDMAgent.Config;
using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Enrollment;

/// <summary>本次 <see cref="AgentEnrollment.EnsureEnrolledAsync"/> 的結果。</summary>
public enum EnrollmentOutcome
{
    /// <summary>registry 已有 token（自建 MDM 注入 or 先前自註冊）——無需動作。</summary>
    AlreadyEnrolled,
    /// <summary>本次成功自註冊並已寫回 token。</summary>
    Enrolled,
    /// <summary>無 token 且無共享密鑰 / 缺 endpoint —— 非自註冊模式，無事可做（不重試）。</summary>
    NotConfigured,
    /// <summary>有共享密鑰但本次註冊失敗（網路等）—— 可重試。</summary>
    Failed,
}

/// <summary>
/// Intune 共存自註冊編排：把 registry 讀寫（<see cref="RegistryConfig"/>）與 HTTP 呼叫
/// （<see cref="AgentEnrollmentClient"/>）黏合。
///
/// 決策：registry 已有 token → <see cref="EnrollmentOutcome.AlreadyEnrolled"/>（順手清殘留
/// 共享密鑰）；有 enrollment_secret + api_endpoint + tenant_id → POST /agent/enroll 換 token
/// 寫回 → <see cref="EnrollmentOutcome.Enrolled"/>；缺共享密鑰 / endpoint →
/// <see cref="EnrollmentOutcome.NotConfigured"/>；請求失敗 → <see cref="EnrollmentOutcome.Failed"/>。
/// </summary>
public static class AgentEnrollment
{
    public static async Task<EnrollmentOutcome> EnsureEnrolledAsync(
        RegistryConfig registryConfig,
        HttpClient http,
        Func<string> serialProvider,
        ILogger logger,
        CancellationToken ct)
    {
        var bootstrap = registryConfig.ReadBootstrap();

        if (!string.IsNullOrEmpty(bootstrap.AgentToken))
        {
            // 已有 per-device token。若共享密鑰仍殘留（首啟未清 / 升級重寫）則清掉縮小暴露。
            if (!string.IsNullOrEmpty(bootstrap.EnrollmentSecret))
            {
                registryConfig.ClearEnrollmentSecret();
                logger.LogInformation("Enrollment: token 已存在，清除殘留 enrollment_secret");
            }
            return EnrollmentOutcome.AlreadyEnrolled;
        }

        if (string.IsNullOrEmpty(bootstrap.EnrollmentSecret))
        {
            // 沒 token 也沒共享密鑰 → 非 Intune 自註冊模式。injected 模式本應由 MSI 注入 token；
            // 此處屬 config 缺失，交由 StartupSelfCheck / 上報端 skip 呈現，不在這裡重試。
            return EnrollmentOutcome.NotConfigured;
        }

        if (string.IsNullOrEmpty(bootstrap.ApiEndpoint) || string.IsNullOrEmpty(bootstrap.TenantId))
        {
            logger.LogWarning(
                "Enrollment: 有 enrollment_secret 但缺 api_endpoint / tenant_id，無法自註冊");
            return EnrollmentOutcome.NotConfigured;
        }

        var serial = serialProvider();
        try
        {
            var result = await AgentEnrollmentClient.EnrollAsync(
                http, bootstrap.EnrollUrl, serial, bootstrap.EnrollmentSecret, ct);
            if (result is null)
            {
                logger.LogWarning(
                    "Enrollment: 後端拒絕或回應殘缺 serial={Serial}，稍後重試", serial);
                return EnrollmentOutcome.Failed;
            }
            // 先寫 token 再清密鑰：確保 token 落地才移除補救所需的密鑰。
            registryConfig.PersistEnrolledIdentity(result.DeviceId, result.AgentToken);
            registryConfig.ClearEnrollmentSecret();
            logger.LogInformation(
                "Enrollment: 自註冊成功 deviceId={DeviceId} serial={Serial}",
                result.DeviceId, serial);
            return EnrollmentOutcome.Enrolled;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Enrollment: 自註冊請求失敗 serial={Serial}，稍後重試", serial);
            return EnrollmentOutcome.Failed;
        }
    }
}
