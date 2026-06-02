using System.Diagnostics;
using System.Runtime.Versioning;
using CoGrowMDMAgent.Locking;

namespace CoGrowMDMAgent.Reporting.Usage;

/// <summary>
/// 判定 active console session 當前是否「在用」＝已有使用者登入物理控制台
/// 且未鎖屏。口徑見 [[windows-lock-design]]（螢幕在用時長）。
///
/// <para>實作走純輪詢，不依賴訊息泵 —— session 0 service 可直接每分鐘呼叫：</para>
/// <list type="number">
/// <item>無 active console session（未登入 / 已登出）→ 不在用。</item>
/// <item>鎖屏 / 登入畫面時 <c>LogonUI.exe</c> 在 active session 執行 → 不在用。</item>
/// </list>
///
/// <para>⚠️ LogonUI 啟發式是已知近似：UAC consent 提示、快速使用者切換等邊界場景
/// 可能短暫誤判。真機校準（沿用 [[ps5-sc-locale-binary-parse]] 教訓：verify 信號
/// 避開本地化文字，這裡用進程存在性＋WTS 數值，不解析任何在地化輸出）。</para>
/// </summary>
internal static class SessionProbe
{
    public static bool IsUserActive()
    {
        if (!OperatingSystem.IsWindows()) return false;
        return IsUserActiveWindows();
    }

    [SupportedOSPlatform("windows")]
    private static bool IsUserActiveWindows()
    {
        var sessionId = NativeMethods.WTSGetActiveConsoleSessionId();
        // 0xFFFFFFFF：當前無 session 連到 console；0：無人登入物理控制台。
        if (sessionId == NativeMethods.INVALID_SESSION || sessionId == 0)
            return false;

        try
        {
            // 鎖屏 / 登入畫面 → LogonUI.exe 存在。
            return Process.GetProcessesByName("LogonUI").Length == 0;
        }
        catch
        {
            // 探測失敗時保守判定為在用，避免漏記真實使用時長。
            return true;
        }
    }
}
