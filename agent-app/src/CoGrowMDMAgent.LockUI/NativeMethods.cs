using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace CoGrowMDMAgent.LockUI;

/// <summary>
/// 前台激活 Win32 P/Invoke。LockUI 由 session 0 服務拉起，不具前台激活權，
/// 須用 AttachThreadInput + keybd_event(Alt) + SetForegroundWindow 組合搶前台。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class NativeMethods
{
    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    internal static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    internal static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    internal static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    internal static readonly IntPtr HWND_TOPMOST = new(-1);
    internal const uint SWP_NOMOVE = 0x0002;
    internal const uint SWP_NOSIZE = 0x0001;
    internal const uint SWP_SHOWWINDOW = 0x0040;
    internal const byte VK_MENU = 0x12; // Alt
    internal const uint KEYEVENTF_KEYUP = 0x0002;
    internal const int SW_SHOW = 5;
}
