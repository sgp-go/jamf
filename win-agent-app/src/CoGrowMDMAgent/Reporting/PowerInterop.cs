using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace CoGrowMDMAgent.Reporting;

/// <summary>
/// Win32 <c>GetSystemPowerStatus</c> 取電池電量。對齊 iOS 端 report payload 的
/// <c>batteryLevel</c> 欄位。桌機（無電池）或未知狀態回 null —— 不偽造數值
/// （與 <see cref="DeviceFactsCollector"/> 對其他探測的處理一致）。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class PowerInterop
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SYSTEM_POWER_STATUS
    {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent; // 0-100；255＝未知
        public byte SystemStatusFlag;
        public int BatteryLifeTime;
        public int BatteryFullLifeTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS lpSystemPowerStatus);

    /// <summary>回傳電池百分比（0-100）；無電池 / 未知回 null。</summary>
    public static int? GetBatteryPercent()
    {
        if (!GetSystemPowerStatus(out var status)) return null;

        const byte NoSystemBattery = 128; // BatteryFlag bit：無系統電池（桌機）
        if ((status.BatteryFlag & NoSystemBattery) != 0) return null;
        if (status.BatteryLifePercent == 255) return null; // unknown

        return status.BatteryLifePercent;
    }
}
