using System.Globalization;
using System.Runtime.Versioning;
using CoGrowMDMAgent.Config;
using CoGrowMDMAgent.Reporting;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Geolocation;

/// <summary>
/// 採集設備地理位置並上報到 <see cref="GpsReporter"/>。
///
/// 雙頻策略：
///   - 平時：低精度（1000m，IP/WiFi 級），每 24h 採一次（daily inventory）
///   - Lost Mode：高精度（100m，觸發 GPS hw 若有），每 30s 採一次
///
/// Lost Mode 信箱：HKLM\Software\CoGrow\Agent\LostMode（沿用 BitLocker/Lock ADMX pattern）
///   Enabled (DWORD)           — 1=啟用高頻, 0=平時
///
/// 上次採集時間持久化於 HKLM\Software\CoGrow\Agent\State\GpsLastCapturedAt（REG_SZ, ISO 8601），
/// 重啟後不重複採集。
///
/// 冷啟動：service 起來先採一次（reboot 後 ABM/Geofence 需立即位置）。
///
/// 失敗處理：Geolocator 拋 → log warning，下次 tick 重試；GpsReporter 拋 → 已自行入隊。
/// </summary>
public sealed class GpsCollector : BackgroundService
{
    /// <summary>內部 tick 間隔。對齊 Lost Mode 高頻 30s；平時也 30s tick 但只在到期才採集。</summary>
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(30);

    /// <summary>平時模式採集間隔（24h）。</summary>
    private static readonly TimeSpan NormalInterval = TimeSpan.FromHours(24);

    /// <summary>Lost Mode 採集間隔（30s）— 與 TickInterval 對齊，每 tick 都採。</summary>
    private static readonly TimeSpan LostModeInterval = TimeSpan.FromSeconds(30);

    /// <summary>Geolocator 單次採集超時（不阻塞 service shutdown）。</summary>
    private static readonly TimeSpan SampleTimeout = TimeSpan.FromSeconds(30);

    private const string LostModeKeyPath = @"SOFTWARE\CoGrow\Agent\LostMode";
    private const string StateKeyPath = @"SOFTWARE\CoGrow\Agent\State";
    private const string LastCapturedValueName = "GpsLastCapturedAt";

    private const uint NormalAccuracyMeters = 1000;
    private const uint LostModeAccuracyMeters = 100;

    private readonly ILogger<GpsCollector> _logger;
    private readonly GpsReporter _reporter;
    private readonly DeviceFactsCollector _facts;

    /// <summary>記憶體中的最後採集時間，避免每 tick 都讀 Registry。Registry 是真相源（重啟恢復）。</summary>
    private DateTime _lastCapturedUtc = DateTime.MinValue;

    public GpsCollector(
        ILogger<GpsCollector> logger,
        GpsReporter reporter,
        DeviceFactsCollector facts)
    {
        _logger = logger;
        _reporter = reporter;
        _facts = facts;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("GpsCollector: 非 Windows 平台，停用");
            return;
        }

        _lastCapturedUtc = ReadLastCapturedUtc() ?? DateTime.MinValue;
        _logger.LogInformation(
            "GpsCollector 啟動：tick={Tick}s, normal={Normal}h, lost={Lost}s, lastCaptured={Last:o}",
            TickInterval.TotalSeconds, NormalInterval.TotalHours,
            LostModeInterval.TotalSeconds, _lastCapturedUtc);

        // 冷啟動先採一次（不阻塞 main loop tick 節奏）
        await CollectAndReportIfDueAsync(forceImmediate: true, stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TickInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            try
            {
                await CollectAndReportIfDueAsync(forceImmediate: false, stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "GpsCollector tick 失敗（不中斷循環）");
            }
        }

        _logger.LogInformation("GpsCollector 已停止");
    }

    private async Task CollectAndReportIfDueAsync(bool forceImmediate, CancellationToken ct)
    {
        var lostMode = IsLostModeEnabled();
        var interval = lostMode ? LostModeInterval : NormalInterval;
        var now = DateTime.UtcNow;
        var elapsed = now - _lastCapturedUtc;

        if (!forceImmediate && elapsed < interval)
        {
            return;
        }

        var sample = await TrySampleAsync(
            lostMode ? LostModeAccuracyMeters : NormalAccuracyMeters, ct);
        if (sample is null) return;

        var serial = _facts.CollectSerialNumber();
        var payload = new GpsPayload
        {
            SerialNumber = serial,
            Latitude = sample.Value.Latitude,
            Longitude = sample.Value.Longitude,
            AccuracyMeters = sample.Value.AccuracyMeters,
            CapturedAt = sample.Value.CapturedAtUtc.ToString("o", CultureInfo.InvariantCulture),
        };

        try
        {
            await _reporter.ReportAsync(payload, ct);
            _lastCapturedUtc = sample.Value.CapturedAtUtc;
            WriteLastCapturedUtc(_lastCapturedUtc);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // Reporter 已入隊，drain loop 會重試；不更新 _lastCapturedUtc 也安全（
            // 下次 tick 仍然到期）。不過為避免高頻打後端，保守記下 last 嘗試時間。
            _lastCapturedUtc = now;
            _logger.LogWarning(
                ex, "GPS upload failed but enqueued; deferring next attempt by interval");
        }
    }

    [SupportedOSPlatform("windows")]
    private bool IsLostModeEnabled()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(LostModeKeyPath);
            if (key == null) return false;
            var enabled = key.GetValue("Enabled");
            return enabled is int i && i == 1;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "讀 LostMode registry 失敗（視為關閉）");
            return false;
        }
    }

    [SupportedOSPlatform("windows")]
    private DateTime? ReadLastCapturedUtc()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(StateKeyPath);
            var raw = key?.GetValue(LastCapturedValueName) as string;
            if (string.IsNullOrEmpty(raw)) return null;
            if (DateTime.TryParse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind | DateTimeStyles.AssumeUniversal,
                out var dt))
            {
                return dt.ToUniversalTime();
            }
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "讀 GpsLastCapturedAt 失敗");
            return null;
        }
    }

    [SupportedOSPlatform("windows")]
    private void WriteLastCapturedUtc(DateTime utc)
    {
        try
        {
            using var key = Registry.LocalMachine.CreateSubKey(StateKeyPath, writable: true);
            key?.SetValue(
                LastCapturedValueName,
                utc.ToString("o", CultureInfo.InvariantCulture),
                RegistryValueKind.String);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "寫 GpsLastCapturedAt 失敗（不致命）");
        }
    }

    /// <summary>
    /// 用 <see cref="Windows.Devices.Geolocation.Geolocator"/> 採位置；任何失敗回 null（log warning）。
    /// 加 SampleTimeout 防 hardware 無回應卡死 service shutdown。
    /// </summary>
    [SupportedOSPlatform("windows10.0.17763.0")]
    private async Task<GpsSample?> TrySampleAsync(uint desiredAccuracyMeters, CancellationToken ct)
    {
        try
        {
            var access = await Windows.Devices.Geolocation.Geolocator
                .RequestAccessAsync().AsTask(ct).ConfigureAwait(false);
            if (access != Windows.Devices.Geolocation.GeolocationAccessStatus.Allowed)
            {
                _logger.LogWarning(
                    "Geolocator access denied (status={Status}); 設備位置存取未開啟",
                    access);
                return null;
            }

            var locator = new Windows.Devices.Geolocation.Geolocator
            {
                DesiredAccuracyInMeters = desiredAccuracyMeters,
            };

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(SampleTimeout);

            var pos = await locator.GetGeopositionAsync()
                .AsTask(timeoutCts.Token).ConfigureAwait(false);

            var coord = pos.Coordinate;
            // pos.Coordinate.Accuracy 是 double（米），轉 int 截斷小數
            var accuracy = (int)Math.Round(coord.Accuracy);

            return new GpsSample
            {
                Latitude = coord.Point.Position.Latitude,
                Longitude = coord.Point.Position.Longitude,
                AccuracyMeters = accuracy,
                CapturedAtUtc = coord.Timestamp.UtcDateTime,
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex, "Geolocator 採集失敗（desiredAccuracy={Acc}m）",
                desiredAccuracyMeters);
            return null;
        }
    }

    private readonly struct GpsSample
    {
        public required double Latitude { get; init; }
        public required double Longitude { get; init; }
        public required int AccuracyMeters { get; init; }
        public required DateTime CapturedAtUtc { get; init; }
    }
}
