using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace CoGrowMDMAgent.BitLocker;

/// <summary>
/// 監控 BitLocker Registry 信箱，偵測到 Pending=1 後執行靜默加密。
///
/// ADMX Policy CSP 落點：HKLM\Software\CoGrow\Agent\BitLocker
///   Pending (DWORD)           — 1=待執行, 0=已完成
///   EncryptionId (REG_SZ)     — 唯一 ID（回報用，防重放）
///   EncryptionMethod (REG_SZ) — 加密演算法（XtsAes256 等）
///
/// 流程：
///   1. Enable-BitLocker -MountPoint C: -TpmProtector（靜默、無彈窗）
///   2. Add-BitLockerKeyProtector -RecoveryPasswordProtector（生成恢復密碼）
///   3. 捕獲 RecoveryPassword 寫入確認檔
///   4. 下次 report 帶回後端存儲
/// </summary>
public sealed class BitLockerWatcher : BackgroundService
{
    private const string BitLockerKeyPath = @"SOFTWARE\CoGrow\Agent\BitLocker";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

    private readonly ILogger<BitLockerWatcher> _logger;

    public BitLockerWatcher(ILogger<BitLockerWatcher> logger) => _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("BitLockerWatcher: 非 Windows 平台，停用");
            return;
        }

        _logger.LogInformation("BitLockerWatcher 啟動，輪詢間隔 {Seconds}s", PollInterval.TotalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                TickWindows();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "BitLockerWatcher tick 失敗（不中斷循環）");
            }

            try
            {
                await Task.Delay(PollInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        _logger.LogInformation("BitLockerWatcher 已停止");
    }

    [SupportedOSPlatform("windows")]
    private void TickWindows()
    {
        using var key = Registry.LocalMachine.OpenSubKey(BitLockerKeyPath, writable: true);
        if (key == null) return;

        var pendingObj = key.GetValue("Pending");
        if (pendingObj is not int pending || pending != 1) return;

        var encryptionId = key.GetValue("EncryptionId") as string;
        var encryptionMethod = key.GetValue("EncryptionMethod") as string ?? "XtsAes256";

        if (string.IsNullOrEmpty(encryptionId))
        {
            _logger.LogWarning("BitLocker Pending=1 但缺少 EncryptionId，跳過");
            return;
        }

        _logger.LogInformation("BitLocker 偵測到加密請求: encryptionId={EncryptionId} method={Method}",
            encryptionId, encryptionMethod);

        var result = EnableBitLocker(encryptionMethod);

        key.SetValue("Pending", 0, RegistryValueKind.DWord);

        if (result.Success)
        {
            _logger.LogInformation("BitLocker 加密已啟動: recoveryPassword={HasPassword}",
                !string.IsNullOrEmpty(result.RecoveryPassword));
            StoreConfirmation(encryptionId, result.RecoveryPassword);
        }
        else
        {
            _logger.LogError("BitLocker 加密啟動失敗: {Error}", result.Error);
            StoreFailure(encryptionId, result.Error);
        }
    }

    [SupportedOSPlatform("windows")]
    private BitLockerResult EnableBitLocker(string encryptionMethod)
    {
        try
        {
            // 冪等：已加密 / 加密中的卷跳過 Enable-BitLocker（否則重加 TPM 保護器 →
            // 「該驅動器只允許這種類型的一個密鑰保護器」錯，ADMX policy 週期 refresh 反覆刷 log）；
            // RecoveryPassword 保護器僅在缺失時才加（避免每輪累積新恢復密碼）；末尾輸出恢復密碼供回報。
            // -WarningAction SilentlyContinue 抑制 Windows 的恢復密碼警告文本。
            var enableScript =
                "$WarningPreference='SilentlyContinue'; " +
                "$v = Get-BitLockerVolume -MountPoint 'C:'; " +
                "if ($v.ProtectionStatus -ne 'On' -and $v.VolumeStatus -eq 'FullyDecrypted') { " +
                $"Enable-BitLocker -MountPoint 'C:' -EncryptionMethod {encryptionMethod} " +
                "-TpmProtector -SkipHardwareTest -WarningAction SilentlyContinue -ErrorAction Stop | Out-Null }; " +
                "$rp = (Get-BitLockerVolume -MountPoint 'C:').KeyProtector | " +
                "Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' } | Select-Object -Last 1; " +
                "if (-not $rp) { $kp = Add-BitLockerKeyProtector -MountPoint 'C:' -RecoveryPasswordProtector " +
                "-WarningAction SilentlyContinue -ErrorAction Stop; " +
                "$rp = $kp.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' } | Select-Object -Last 1 }; " +
                "$rp.RecoveryPassword";

            var psi = new ProcessStartInfo("powershell", $"-NoProfile -NonInteractive -Command \"{enableScript}\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            using var proc = Process.Start(psi);
            if (proc is null)
            {
                return new BitLockerResult { Success = false, Error = "無法啟動 PowerShell" };
            }

            var stdout = proc.StandardOutput.ReadToEnd().Trim();
            var stderr = proc.StandardError.ReadToEnd().Trim();

            if (!proc.WaitForExit(120_000))
            {
                proc.Kill();
                return new BitLockerResult { Success = false, Error = "PowerShell 超時 (120s)" };
            }

            if (proc.ExitCode != 0)
            {
                _logger.LogError("BitLocker PowerShell 失敗: exit={ExitCode} stderr={Stderr}",
                    proc.ExitCode, stderr);
                return new BitLockerResult { Success = false, Error = stderr };
            }

            // 從輸出中提取純 Recovery Password（8 組 6 位數字，防 Windows 警告文本混入）
            var recoveryPassword = ExtractRecoveryPassword(stdout);

            return new BitLockerResult
            {
                Success = true,
                RecoveryPassword = recoveryPassword ?? stdout,
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "BitLocker EnableBitLocker 異常");
            return new BitLockerResult { Success = false, Error = ex.Message };
        }
    }

    private static readonly Regex RecoveryPasswordPattern = new(
        @"\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}",
        RegexOptions.Compiled);

    private static string? ExtractRecoveryPassword(string output)
    {
        var match = RecoveryPasswordPattern.Match(output);
        return match.Success ? match.Value : null;
    }

    private void StoreConfirmation(string encryptionId, string? recoveryPassword)
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CoGrow", "MDM Agent");
            Directory.CreateDirectory(dir);
            var payload = new BitLockerConfirmation
            {
                EncryptionId = encryptionId,
                RecoveryPassword = recoveryPassword,
                ConfirmedAt = DateTime.UtcNow.ToString("o"),
                Success = true,
            };
            File.WriteAllText(
                Path.Combine(dir, "bitlocker-confirmation.json"),
                JsonSerializer.Serialize(payload));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "BitLocker: 無法寫入確認檔");
        }
    }

    private void StoreFailure(string encryptionId, string? error)
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CoGrow", "MDM Agent");
            Directory.CreateDirectory(dir);
            var payload = new BitLockerConfirmation
            {
                EncryptionId = encryptionId,
                RecoveryPassword = null,
                ConfirmedAt = DateTime.UtcNow.ToString("o"),
                Success = false,
                Error = error,
            };
            File.WriteAllText(
                Path.Combine(dir, "bitlocker-confirmation.json"),
                JsonSerializer.Serialize(payload));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "BitLocker: 無法寫入失敗檔");
        }
    }
}

internal sealed record BitLockerResult
{
    public bool Success { get; init; }
    public string? RecoveryPassword { get; init; }
    public string? Error { get; init; }
}

internal sealed record BitLockerConfirmation
{
    [System.Text.Json.Serialization.JsonPropertyName("encryption_id")]
    public required string EncryptionId { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("recovery_password")]
    public string? RecoveryPassword { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("confirmed_at")]
    public required string ConfirmedAt { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("success")]
    public required bool Success { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("error")]
    public string? Error { get; init; }
}
