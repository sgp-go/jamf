using System.Runtime.Versioning;
using Microsoft.Win32;

namespace CoGrowMDMAgent.LockUI;

/// <summary>
/// 讀取服務端透過 Registry CSP 寫入的鎖定狀態（HKLM\SOFTWARE\CoGrow\Agent\Lock）。
/// 對應服務端 csp.ts buildLockState：Enabled(REG_DWORD) / Message(REG_SZ) / Phone(REG_SZ)。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class LockState
{
    public const string KeyPath = @"SOFTWARE\CoGrow\Agent\Lock";

    /// <summary>Enabled=1 → 鎖定中。key 不存在 / 值缺失 → 視為未鎖。</summary>
    public static bool IsEnabled()
    {
        using var key = Registry.LocalMachine.OpenSubKey(KeyPath);
        // REG_DWORD 在 .NET 讀出為 int
        return key?.GetValue("Enabled") is int v && v == 1;
    }

    /// <summary>鎖定窗顯示內容；缺失回空字串。</summary>
    public static (string Message, string Phone) ReadContent()
    {
        using var key = Registry.LocalMachine.OpenSubKey(KeyPath);
        var message = key?.GetValue("Message") as string ?? "";
        var phone = key?.GetValue("Phone") as string ?? "";
        return (message, phone);
    }
}
