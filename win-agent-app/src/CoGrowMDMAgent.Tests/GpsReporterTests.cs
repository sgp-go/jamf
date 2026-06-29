using System.Text.Json;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Geolocation;
using CoGrowMDMAgent.Queue;
using CoGrowMDMAgent.Reporting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace CoGrowMDMAgent.Tests;

/// <summary>
/// GpsReporter / GpsCollector payload & DI 契約測試。
///
/// 核心守恆：JSON 序列化字段名必須對得上後端 zod schema（app/routes/v1/agent.ts）
///   - camelCase（serialNumber / latitude / longitude / accuracyMeters / capturedAt）
///   - lat/lng 為 JSON number 不是 string
///   - accuracyMeters / capturedAt 可省略（WhenWritingNull）
/// 真實 HTTP 路徑與 UsageReporter 同模式，真機驗證即可。
/// </summary>
public class GpsReporterTests
{
    [Fact]
    public void GpsPayload_serialises_with_camelCase_and_number_types()
    {
        var payload = new GpsPayload
        {
            SerialNumber = "PF5XSMN1",
            Latitude = 25.0339,
            Longitude = 121.5645,
            AccuracyMeters = 30,
            CapturedAt = "2026-06-29T14:30:00Z",
        };

        var json = JsonSerializer.Serialize(payload, GpsReporter.JsonOptions);

        // 字段名 camelCase
        Assert.Contains("\"serialNumber\":\"PF5XSMN1\"", json);
        Assert.Contains("\"latitude\":25.0339", json);
        Assert.Contains("\"longitude\":121.5645", json);
        Assert.Contains("\"accuracyMeters\":30", json);
        Assert.Contains("\"capturedAt\":\"2026-06-29T14:30:00Z\"", json);

        // lat/lng 不能變字串（後端 zod 用 z.number()）
        Assert.DoesNotContain("\"latitude\":\"", json);
        Assert.DoesNotContain("\"longitude\":\"", json);
    }

    [Fact]
    public void GpsPayload_omits_nullable_fields_when_null()
    {
        var payload = new GpsPayload
        {
            SerialNumber = "PF5XSMN1",
            Latitude = 25.0339,
            Longitude = 121.5645,
            AccuracyMeters = null,
            CapturedAt = null,
        };

        var json = JsonSerializer.Serialize(payload, GpsReporter.JsonOptions);

        // 後端 zod schema 中這兩個是 .nullable().optional()，缺欄位由後端用 now() 兜底
        Assert.DoesNotContain("accuracyMeters", json);
        Assert.DoesNotContain("capturedAt", json);
        // 必填欄位仍在
        Assert.Contains("\"serialNumber\":\"PF5XSMN1\"", json);
    }

    [Fact]
    public void GpsReporter_resolves_via_DI()
    {
        // DI 鏡像 Program.cs 關鍵註冊：reporter 依賴 HttpClient / AgentConfigProvider / IReportQueue
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<AgentConfigProvider>(sp =>
            new AgentConfigProvider(
                () => new AgentConfig
                {
                    DeviceId = "gps-di-test",
                    AgentToken = "tok",
                    ApiEndpoint = "https://example.com",
                    TenantId = "tenant-1",
                },
                sp.GetRequiredService<ILogger<AgentConfigProvider>>()));
        services.AddSingleton<IReportQueue>(
            new SqliteReportQueue(
                Path.Combine(Path.GetTempPath(), $"gps-di-{Guid.NewGuid():N}.db"),
                NullLogger<SqliteReportQueue>.Instance));
        services.AddHttpClient<GpsReporter>();

        using var provider = services.BuildServiceProvider();
        var reporter = provider.GetRequiredService<GpsReporter>();
        Assert.NotNull(reporter);
    }

    [Fact]
    public void GpsCollector_resolves_as_hosted_service()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<AgentConfigProvider>(sp =>
            new AgentConfigProvider(
                () => new AgentConfig
                {
                    DeviceId = "gps-hosted-test",
                    AgentToken = "tok",
                    ApiEndpoint = "https://example.com",
                    TenantId = "tenant-1",
                },
                sp.GetRequiredService<ILogger<AgentConfigProvider>>()));
        services.AddSingleton<IReportQueue>(
            new SqliteReportQueue(
                Path.Combine(Path.GetTempPath(), $"gps-hosted-{Guid.NewGuid():N}.db"),
                NullLogger<SqliteReportQueue>.Instance));
        services.AddSingleton<DeviceFactsCollector>();
        services.AddHttpClient<GpsReporter>();
        services.AddHostedService<GpsCollector>();

        using var provider = services.BuildServiceProvider();
        var hosted = provider.GetServices<IHostedService>();
        Assert.Contains(hosted, h => h is GpsCollector);
    }

    [Fact]
    public void ReportType_GpsReport_constant_matches_backend_discriminator()
    {
        // 守恆：drain switch 用此常數路由 GpsReporter.RetryAsync；
        // 字面值變更會讓佇列中既有 row 找不到 handler 變 dead-letter，需配套 migration。
        Assert.Equal("gps_report", ReportType.GpsReport);
    }
}
