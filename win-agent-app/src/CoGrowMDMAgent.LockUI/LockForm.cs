using System.Drawing;
using System.Runtime.Versioning;
using System.Windows.Forms;

namespace CoGrowMDMAgent.LockUI;

/// <summary>
/// 全螢幕鎖定窗：覆蓋所有螢幕、topmost、無法最小化/關閉，顯示聯絡訊息。
///
/// 強度（見 [[windows-lock-design]] §2）：
///   - 攔 Alt+F4 / 最小化 / 失焦自動置頂搶回
///   - Ctrl+Alt+Del / Win+L 是 OS 級攔不住 → 由服務端 DisableTaskMgr 策略 + 服務看門狗
///     （殺進程後 <1s 重啟）+ 鎖定態持久（Enabled=1 開機恢復）共同兜底
///   - 解鎖：輪詢 Registry Enabled，=0 即 Application.Exit 自關
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class LockForm : Form
{
    private const int PollIntervalMs = 1000;
    private readonly System.Windows.Forms.Timer _poll;

    public LockForm()
    {
        var (message, phone) = LockState.ReadContent();

        // —— 窗口外觀：無邊框、覆蓋整個虛擬桌面（所有螢幕）、topmost、不進工作列 ——
        FormBorderStyle = FormBorderStyle.None;
        ControlBox = false;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Bounds = SystemInformation.VirtualScreen; // 跨所有螢幕
        BackColor = Color.FromArgb(15, 23, 42); // 深藍灰
        Cursor = Cursors.Default;
        KeyPreview = true;

        BuildContent(message, phone);

        // —— 解鎖輪詢 + 置頂維持 ——
        _poll = new System.Windows.Forms.Timer { Interval = PollIntervalMs };
        _poll.Tick += OnPollTick;
        _poll.Start();

        Load += (_, _) => ForceForeground();
        Deactivate += (_, _) => BeginInvoke(ForceForeground); // 被切走立即搶回
    }

    private void BuildContent(string message, string phone)
    {
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.Transparent,
            ColumnCount = 1,
            RowCount = 3,
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 0));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 60));

        var title = new Label
        {
            Text = "🔒  此設備已被管理員鎖定",
            ForeColor = Color.White,
            Font = new Font("Microsoft JhengHei UI", 28F, FontStyle.Bold),
            AutoSize = false,
            Dock = DockStyle.Bottom,
            TextAlign = ContentAlignment.MiddleCenter,
            Height = 80,
        };

        var bodyText = string.IsNullOrWhiteSpace(message)
            ? "請聯絡學校管理員以解除鎖定。"
            : message;
        if (!string.IsNullOrWhiteSpace(phone))
        {
            bodyText += $"\n\n聯絡電話：{phone}";
        }

        var body = new Label
        {
            Text = bodyText,
            ForeColor = Color.FromArgb(203, 213, 225),
            Font = new Font("Microsoft JhengHei UI", 16F, FontStyle.Regular),
            AutoSize = false,
            Dock = DockStyle.Top,
            TextAlign = ContentAlignment.TopCenter,
            Height = 200,
        };

        panel.Controls.Add(title, 0, 0);
        panel.Controls.Add(body, 0, 2);
        Controls.Add(panel);
    }

    private void OnPollTick(object? sender, EventArgs e)
    {
        if (!LockState.IsEnabled())
        {
            _poll.Stop();
            Application.Exit(); // 解鎖 → 自關
            return;
        }
        ForceForeground(); // 維持置頂
    }

    /// <summary>
    /// 強制搶前台。LockUI 由 session 0 服務拉起，Windows 不授予前台激活權，
    /// 純 WinForms TopMost/Activate/BringToFront 無法蓋過使用者正在操作的窗口。
    /// 組合拳：① 模擬 Alt 鍵騙取激活權 → ② AttachThreadInput 掛到前台線程 →
    /// ③ SetWindowPos HWND_TOPMOST → ④ SetForegroundWindow → ⑤ WinForms 兜底。
    /// </summary>
    private void ForceForeground()
    {
        if (IsDisposed) return;
        var handle = Handle;

        // ① 模擬 Alt 鍵按放：Windows 認為有使用者輸入 → 解鎖前台激活限制
        NativeMethods.keybd_event(NativeMethods.VK_MENU, 0, 0, UIntPtr.Zero);
        NativeMethods.keybd_event(NativeMethods.VK_MENU, 0, NativeMethods.KEYEVENTF_KEYUP, UIntPtr.Zero);

        // ② AttachThreadInput：掛到當前前台窗口的線程，暫時共享輸入隊列
        var foregroundWnd = NativeMethods.GetForegroundWindow();
        var foregroundThread = NativeMethods.GetWindowThreadProcessId(foregroundWnd, out _);
        var currentThread = NativeMethods.GetCurrentThreadId();

        bool attached = false;
        if (foregroundThread != currentThread && foregroundThread != 0)
        {
            attached = NativeMethods.AttachThreadInput(currentThread, foregroundThread, true);
        }

        try
        {
            // ③ Win32 SetWindowPos HWND_TOPMOST（比 WinForms TopMost 屬性更可靠）
            NativeMethods.SetWindowPos(handle, NativeMethods.HWND_TOPMOST, 0, 0, 0, 0,
                NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_SHOWWINDOW);

            // ④ 搶前台焦點
            NativeMethods.ShowWindow(handle, NativeMethods.SW_SHOW);
            NativeMethods.SetForegroundWindow(handle);
        }
        finally
        {
            if (attached)
            {
                NativeMethods.AttachThreadInput(currentThread, foregroundThread, false);
            }
        }

        // ⑤ WinForms 層兜底
        TopMost = true;
        Activate();
        BringToFront();
    }

    // 鎖定態下攔截使用者主動關閉（Alt+F4 等）
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing && LockState.IsEnabled())
        {
            e.Cancel = true;
            return;
        }
        base.OnFormClosing(e);
    }

    // 攔常見鍵序列（盡力；Ctrl+Alt+Del / Win+L 為 OS 級無法在此攔）
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        switch (keyData)
        {
            case Keys.Alt | Keys.F4:
            case Keys.Alt | Keys.Tab:
            case Keys.LWin:
            case Keys.RWin:
            case Keys.Control | Keys.Escape:
                return true; // 吞掉
            default:
                return base.ProcessCmdKey(ref msg, keyData);
        }
    }
}
