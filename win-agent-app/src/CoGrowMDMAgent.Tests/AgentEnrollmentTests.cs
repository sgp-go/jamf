using System.Net;
using System.Text;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Enrollment;
using Microsoft.Extensions.Logging.Abstractions;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// 序列化所有會改 COGROW_* 進程環境變數的測試類（env 是進程全域，並行會互踩）。
/// </summary>
[CollectionDefinition("CogrowEnv", DisableParallelization = true)]
public sealed class CogrowEnvCollection { }

/// <summary>
/// <see cref="AgentEnrollmentClient.EnrollAsync"/> 純 HTTP 行為（不碰 env，可並行）。
/// </summary>
public class AgentEnrollmentClientTests
{
    private const string EnrollUrl =
        "https://api.example.com/api/v1/tenants/t1/agent/enroll";

    [Fact]
    public async Task EnrollAsync_Success_ReturnsResult_AndSendsSerialAndSecret()
    {
        var handler = new StubHandler(
            HttpStatusCode.OK,
            """{"ok":true,"data":{"deviceId":"dev-123","agentToken":"tok-abc","issuedAt":"2026-07-13T00:00:00Z"}}""");
        using var http = new HttpClient(handler);

        var result = await AgentEnrollmentClient.EnrollAsync(
            http, EnrollUrl, "SERIAL1", "secret1", CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal("dev-123", result!.DeviceId);
        Assert.Equal("tok-abc", result.AgentToken);
        // 請求正確落到 enroll URL，body 帶序號 + 共享密鑰。
        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal(EnrollUrl, handler.LastRequest.RequestUri!.ToString());
        Assert.Contains("\"serialNumber\":\"SERIAL1\"", handler.LastBody);
        Assert.Contains("\"enrollmentSecret\":\"secret1\"", handler.LastBody);
    }

    [Fact]
    public async Task EnrollAsync_NonSuccessStatus_ReturnsNull()
    {
        var handler = new StubHandler(
            HttpStatusCode.Unauthorized,
            """{"ok":false,"error":{"code":"enrollment_secret_invalid"}}""");
        using var http = new HttpClient(handler);

        var result = await AgentEnrollmentClient.EnrollAsync(
            http, EnrollUrl, "S", "bad-secret", CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task EnrollAsync_MissingAgentTokenInBody_ReturnsNull()
    {
        // 2xx 但信封缺 agentToken → 視為殘缺，回 null（呼叫方重試）。
        var handler = new StubHandler(
            HttpStatusCode.OK,
            """{"ok":true,"data":{"deviceId":"dev-123"}}""");
        using var http = new HttpClient(handler);

        var result = await AgentEnrollmentClient.EnrollAsync(
            http, EnrollUrl, "S", "sec", CancellationToken.None);

        Assert.Null(result);
    }
}

/// <summary>
/// <see cref="AgentEnrollment.EnsureEnrolledAsync"/> 分支決策。非 Windows 走 env bootstrap，
/// PersistEnrolledIdentity / ClearEnrollmentSecret 為 no-op，故只驗 outcome。
/// </summary>
[Collection("CogrowEnv")]
public class AgentEnrollmentOrchestrationTests
{
    private const string DeviceIdVar = "COGROW_DEVICE_ID";
    private const string TokenVar = "COGROW_AGENT_TOKEN";
    private const string EndpointVar = "COGROW_API_ENDPOINT";
    private const string TenantVar = "COGROW_TENANT_ID";
    private const string SecretVar = "COGROW_ENROLLMENT_SECRET";

    [Fact]
    public async Task EnsureEnrolled_WithExistingToken_ReturnsAlreadyEnrolled()
    {
        if (OperatingSystem.IsWindows()) return;

        var prev = SnapshotEnv();
        try
        {
            SetEnv(endpoint: "https://x/api/v1", tenant: "t1", token: "existing-token", secret: null);
            // stub 設 500：若邏輯誤發請求，會失敗暴露 —— 有 token 時不該打網路。
            using var http = new HttpClient(new StubHandler(HttpStatusCode.InternalServerError, "{}"));

            var outcome = await AgentEnrollment.EnsureEnrolledAsync(
                new RegistryConfig(), http, () => "SERIAL", NullLogger.Instance, CancellationToken.None);

            Assert.Equal(EnrollmentOutcome.AlreadyEnrolled, outcome);
        }
        finally
        {
            RestoreEnv(prev);
        }
    }

    [Fact]
    public async Task EnsureEnrolled_NoTokenNoSecret_ReturnsNotConfigured()
    {
        if (OperatingSystem.IsWindows()) return;

        var prev = SnapshotEnv();
        try
        {
            SetEnv(endpoint: "https://x/api/v1", tenant: "t1", token: null, secret: null);
            using var http = new HttpClient(new StubHandler(HttpStatusCode.InternalServerError, "{}"));

            var outcome = await AgentEnrollment.EnsureEnrolledAsync(
                new RegistryConfig(), http, () => "SERIAL", NullLogger.Instance, CancellationToken.None);

            Assert.Equal(EnrollmentOutcome.NotConfigured, outcome);
        }
        finally
        {
            RestoreEnv(prev);
        }
    }

    [Fact]
    public async Task EnsureEnrolled_WithSecret_PostsAndReturnsEnrolled()
    {
        if (OperatingSystem.IsWindows()) return;

        var prev = SnapshotEnv();
        try
        {
            SetEnv(endpoint: "https://x/api/v1", tenant: "t1", token: null, secret: "shared-secret");
            var handler = new StubHandler(
                HttpStatusCode.OK,
                """{"ok":true,"data":{"deviceId":"dev-9","agentToken":"tok-9","issuedAt":"2026-07-13T00:00:00Z"}}""");
            using var http = new HttpClient(handler);

            var outcome = await AgentEnrollment.EnsureEnrolledAsync(
                new RegistryConfig(), http, () => "SERIAL9", NullLogger.Instance, CancellationToken.None);

            Assert.Equal(EnrollmentOutcome.Enrolled, outcome);
            Assert.Equal("https://x/api/v1/tenants/t1/agent/enroll",
                handler.LastRequest!.RequestUri!.ToString());
            Assert.Contains("\"serialNumber\":\"SERIAL9\"", handler.LastBody);
        }
        finally
        {
            RestoreEnv(prev);
        }
    }

    [Fact]
    public async Task EnsureEnrolled_EnrollRequestFails_ReturnsFailed()
    {
        if (OperatingSystem.IsWindows()) return;

        var prev = SnapshotEnv();
        try
        {
            SetEnv(endpoint: "https://x/api/v1", tenant: "t1", token: null, secret: "shared-secret");
            using var http = new HttpClient(new StubHandler(HttpStatusCode.InternalServerError, "{}"));

            var outcome = await AgentEnrollment.EnsureEnrolledAsync(
                new RegistryConfig(), http, () => "SERIAL", NullLogger.Instance, CancellationToken.None);

            Assert.Equal(EnrollmentOutcome.Failed, outcome);
        }
        finally
        {
            RestoreEnv(prev);
        }
    }

    private static void SetEnv(string? endpoint, string? tenant, string? token, string? secret)
    {
        Environment.SetEnvironmentVariable(DeviceIdVar, null);
        Environment.SetEnvironmentVariable(TokenVar, token);
        Environment.SetEnvironmentVariable(EndpointVar, endpoint);
        Environment.SetEnvironmentVariable(TenantVar, tenant);
        Environment.SetEnvironmentVariable(SecretVar, secret);
    }

    private static Dictionary<string, string?> SnapshotEnv() => new()
    {
        [DeviceIdVar] = Environment.GetEnvironmentVariable(DeviceIdVar),
        [TokenVar] = Environment.GetEnvironmentVariable(TokenVar),
        [EndpointVar] = Environment.GetEnvironmentVariable(EndpointVar),
        [TenantVar] = Environment.GetEnvironmentVariable(TenantVar),
        [SecretVar] = Environment.GetEnvironmentVariable(SecretVar),
    };

    private static void RestoreEnv(Dictionary<string, string?> prev)
    {
        foreach (var (key, value) in prev)
        {
            Environment.SetEnvironmentVariable(key, value);
        }
    }
}

/// <summary>可控狀態碼 + body 的 HttpMessageHandler，捕獲最後一次請求供斷言。</summary>
internal sealed class StubHandler : HttpMessageHandler
{
    private readonly HttpStatusCode _status;
    private readonly string _body;

    public HttpRequestMessage? LastRequest { get; private set; }
    public string? LastBody { get; private set; }

    public StubHandler(HttpStatusCode status, string body)
    {
        _status = status;
        _body = body;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        LastRequest = request;
        LastBody = request.Content is null
            ? null
            : await request.Content.ReadAsStringAsync(cancellationToken);
        return new HttpResponseMessage(_status)
        {
            Content = new StringContent(_body, Encoding.UTF8, "application/json"),
        };
    }
}
