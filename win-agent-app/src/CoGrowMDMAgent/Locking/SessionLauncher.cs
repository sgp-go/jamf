using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using static CoGrowMDMAgent.Locking.NativeMethods;

namespace CoGrowMDMAgent.Locking;

/// <summary>
/// 從 LocalSystem 服務（session 0）在「active console 使用者 session」拉起一個進程。
/// 標準流程：WTSGetActiveConsoleSessionId → WTSQueryUserToken → DuplicateTokenEx
/// → CreateEnvironmentBlock → CreateProcessAsUser(lpDesktop="winsta0\\default")。
///
/// ⚠️ 需在 Windows 真機驗證（權限/desktop/token 細節）。服務必須以 LocalSystem 執行
/// （具 SeTcbPrivilege）WTSQueryUserToken 才會成功。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class SessionLauncher
{
    /// <summary>
    /// 在 active console session 啟動 exePath。成功回傳 PID；無人登入 / 失敗回 null。
    /// </summary>
    public static int? LaunchInActiveSession(string exePath, string workingDir)
    {
        uint sessionId = WTSGetActiveConsoleSessionId();
        if (sessionId == INVALID_SESSION)
        {
            // 無 active console session（沒人登入 / 切換中）
            return null;
        }

        IntPtr userToken = IntPtr.Zero;
        IntPtr primaryToken = IntPtr.Zero;
        IntPtr envBlock = IntPtr.Zero;

        try
        {
            if (!WTSQueryUserToken(sessionId, out userToken))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "WTSQueryUserToken failed（服務需 LocalSystem，且該 session 須有互動使用者）");
            }

            if (!DuplicateTokenEx(userToken, MAXIMUM_ALLOWED, IntPtr.Zero,
                    SecurityImpersonation, TokenPrimary, out primaryToken))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed");
            }

            if (!CreateEnvironmentBlock(out envBlock, primaryToken, false))
            {
                // 環境塊非致命，可降級用 null env
                envBlock = IntPtr.Zero;
            }

            var si = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                lpDesktop = @"winsta0\default", // 互動桌面
            };

            uint flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE;

            bool ok = CreateProcessAsUser(
                primaryToken,
                exePath,
                null,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                flags,
                envBlock,
                workingDir,
                ref si,
                out PROCESS_INFORMATION pi);

            if (!ok)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser failed");
            }

            int pid = pi.dwProcessId;
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return pid;
        }
        finally
        {
            if (envBlock != IntPtr.Zero) DestroyEnvironmentBlock(envBlock);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
            if (userToken != IntPtr.Zero) CloseHandle(userToken);
        }
    }
}
