using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Win32;

namespace CoGrowMDMAgent.Laps;

/// <summary>
/// 監控 LAPS Registry 信箱，偵測到 Pending=1 後執行本機帳號密碼變更。
///
/// ADMX Policy CSP 落點：HKLM\Software\CoGrow\Agent\Laps
///   Pending (DWORD)     — 1=待執行, 0=已完成
///   NewPassword (REG_SZ) — 新密碼明文（Agent 讀後立即清除）
///   AdminAccount (REG_SZ) — 受管帳號名稱
///   RotationId (REG_SZ)  — 唯一輪換 ID（回報用，防重放）
///   RequireChange (REG_SZ) — "1" = 改密後額外跑 net user /logonpasswordchg:yes
///                             強制帳號下次登入必須改密（教育場景學生自訂密碼）
///                             "0" 或缺失 = 不強制改密
///
/// 通道原本只為 admin 自動輪換設計，2026-07-03 擴展支援 student 手動重設：
///   - 同一 registry 信箱、同一 watcher；靠 AdminAccount 值決定 net user 目標
///   - RequireChange=1 是 student 場景常用（發臨時密碼給學生 → 首登被迫自設）
///
/// 模式同 LockWatcher：2s 輪詢 + 即時動作。非 Windows 平台 no-op。
/// </summary>
public sealed class LapsWatcher : BackgroundService
{
    private const string LapsKeyPath = @"SOFTWARE\CoGrow\Agent\Laps";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

    private readonly ILogger<LapsWatcher> _logger;

    public LapsWatcher(ILogger<LapsWatcher> logger) => _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("LapsWatcher: 非 Windows 平台，停用（dev no-op）");
            return;
        }

        _logger.LogInformation("LapsWatcher 啟動，輪詢間隔 {Seconds}s", PollInterval.TotalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                TickWindows();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "LapsWatcher tick 失敗（不中斷循環）");
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

        _logger.LogInformation("LapsWatcher 已停止");
    }

    [SupportedOSPlatform("windows")]
    private void TickWindows()
    {
        using var key = Registry.LocalMachine.OpenSubKey(LapsKeyPath, writable: true);
        if (key == null) return;

        var pendingObj = key.GetValue("Pending");
        if (pendingObj is not int pending || pending != 1) return;

        var password = key.GetValue("NewPassword") as string;
        var account = key.GetValue("AdminAccount") as string;
        var rotationId = key.GetValue("RotationId") as string;
        var requireChangeStr = key.GetValue("RequireChange") as string;
        var requireChange = requireChangeStr == "1";

        if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(account)
            || string.IsNullOrEmpty(rotationId))
        {
            _logger.LogWarning("LAPS Pending=1 但缺少 NewPassword/AdminAccount/RotationId，跳過");
            return;
        }

        _logger.LogInformation(
            "LAPS 偵測到密碼重設請求: account={Account} rotation={RotationId} requireChange={RequireChange}",
            account, rotationId, requireChange);

        var success = ChangeLocalPassword(account, password);

        // 無論成功與否，立即清除明文密碼
        key.DeleteValue("NewPassword", throwOnMissingValue: false);
        key.SetValue("Pending", 0, RegistryValueKind.DWord);

        // 密碼改成功且需要強制首登改密 → 額外跑 net user /logonpasswordchg:yes
        // 失敗只警告不當作整體失敗（改密本身已完成，強制標記次要）
        if (success && requireChange)
        {
            var flagSuccess = SetLogonPasswordChangeFlag(account);
            if (!flagSuccess)
            {
                _logger.LogWarning(
                    "LAPS: 密碼已改但 /logonpasswordchg:yes 標記失敗 account={Account}",
                    account);
            }
        }

        if (success)
        {
            _logger.LogInformation("LAPS 密碼已變更: account={Account}", account);
            StoreConfirmation(rotationId);
        }
        else
        {
            _logger.LogError("LAPS 密碼變更失敗: account={Account}", account);
            StoreFailure(rotationId);
        }
    }

    [SupportedOSPlatform("windows")]
    private bool SetLogonPasswordChangeFlag(string account)
    {
        try
        {
            var psi = new ProcessStartInfo("net", $"user \"{account}\" /logonpasswordchg:yes")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return false;
            var stderr = proc.StandardError.ReadToEnd();
            if (!proc.WaitForExit(10_000))
            {
                proc.Kill();
                return false;
            }
            if (proc.ExitCode != 0)
            {
                _logger.LogWarning(
                    "LAPS: /logonpasswordchg:yes 失敗 exit={ExitCode} stderr={Stderr}",
                    proc.ExitCode, stderr);
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "LAPS: /logonpasswordchg:yes 異常");
            return false;
        }
    }

    [SupportedOSPlatform("windows")]
    private bool ChangeLocalPassword(string account, string password)
    {
        try
        {
            var psi = new ProcessStartInfo("net", $"user \"{account}\" \"{password}\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null)
            {
                _logger.LogError("LAPS: 無法啟動 net user 進程");
                return false;
            }
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            if (!proc.WaitForExit(10_000))
            {
                proc.Kill();
                _logger.LogError("LAPS: net user 超時");
                return false;
            }
            if (proc.ExitCode != 0)
            {
                _logger.LogError("LAPS: net user 失敗 exit={ExitCode} stderr={Stderr}",
                    proc.ExitCode, stderr);
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LAPS: net user 異常");
            return false;
        }
    }

    private void StoreConfirmation(string rotationId)
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CoGrow", "MDM Agent");
            Directory.CreateDirectory(dir);
            var payload = new LapsConfirmation
            {
                RotationId = rotationId,
                ConfirmedAt = DateTime.UtcNow.ToString("o"),
                Success = true,
            };
            File.WriteAllText(
                Path.Combine(dir, "laps-confirmation.json"),
                JsonSerializer.Serialize(payload));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LAPS: 無法寫入確認檔");
        }
    }

    private void StoreFailure(string rotationId)
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CoGrow", "MDM Agent");
            Directory.CreateDirectory(dir);
            var payload = new LapsConfirmation
            {
                RotationId = rotationId,
                ConfirmedAt = DateTime.UtcNow.ToString("o"),
                Success = false,
            };
            File.WriteAllText(
                Path.Combine(dir, "laps-confirmation.json"),
                JsonSerializer.Serialize(payload));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LAPS: 無法寫入失敗檔");
        }
    }
}

internal sealed record LapsConfirmation
{
    [System.Text.Json.Serialization.JsonPropertyName("rotation_id")]
    public required string RotationId { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("confirmed_at")]
    public required string ConfirmedAt { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("success")]
    public required bool Success { get; init; }
}
