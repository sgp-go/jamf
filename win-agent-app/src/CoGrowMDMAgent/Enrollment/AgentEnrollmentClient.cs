using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoGrowMDMAgent.Enrollment;

/// <summary>
/// Enroll HTTP 呼叫（與 registry / hosting 解耦，便於單測用 mock handler 驗證）。
///
/// 對接 <c>POST {api_endpoint}/tenants/{tenant_id}/agent/enroll</c>：
/// body <c>{ serialNumber, enrollmentSecret }</c> → 2xx 回信封 <c>{ ok, data:{ deviceId,
/// agentToken, issuedAt } }</c>。
/// </summary>
public static class AgentEnrollmentClient
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>
    /// POST 自註冊請求。2xx 且信封含非空 deviceId + agentToken → 回結果；
    /// 非 2xx / 回應殘缺 → 回 null（呼叫方視為可重試）。網路 / 逾時例外向上拋。
    /// </summary>
    public static async Task<EnrollmentResult?> EnrollAsync(
        HttpClient http,
        string enrollUrl,
        string serialNumber,
        string enrollmentSecret,
        CancellationToken ct)
    {
        var request = new EnrollmentRequest
        {
            SerialNumber = serialNumber,
            EnrollmentSecret = enrollmentSecret,
        };
        using var response = await http.PostAsJsonAsync(enrollUrl, request, JsonOptions, ct);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }
        var envelope = await response.Content
            .ReadFromJsonAsync<EnrollmentEnvelope>(JsonOptions, ct);
        var data = envelope?.Data;
        if (data is null
            || string.IsNullOrEmpty(data.DeviceId)
            || string.IsNullOrEmpty(data.AgentToken))
        {
            return null;
        }
        return new EnrollmentResult
        {
            DeviceId = data.DeviceId,
            AgentToken = data.AgentToken,
        };
    }
}

public sealed record EnrollmentRequest
{
    [JsonPropertyName("serialNumber")]
    public required string SerialNumber { get; init; }

    [JsonPropertyName("enrollmentSecret")]
    public required string EnrollmentSecret { get; init; }
}

public sealed record EnrollmentResult
{
    public required string DeviceId { get; init; }
    public required string AgentToken { get; init; }
}

internal sealed record EnrollmentEnvelope
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("data")]
    public EnrollmentData? Data { get; init; }
}

internal sealed record EnrollmentData
{
    [JsonPropertyName("deviceId")]
    public string? DeviceId { get; init; }

    [JsonPropertyName("agentToken")]
    public string? AgentToken { get; init; }

    [JsonPropertyName("issuedAt")]
    public string? IssuedAt { get; init; }
}
