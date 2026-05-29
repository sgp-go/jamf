using System.Runtime.Versioning;

namespace CoGrowMDMAgent.LockUI;

/// <summary>
/// 鎖定窗 helper 進程入口。由 CoGrowMDMAgent 服務在使用者 session 拉起。
/// 啟動先確認確實處於鎖定態（避免競態下殘留進程彈窗）；解鎖由 LockForm 輪詢
/// Registry Enabled=0 後 Application.Exit 自關。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // 競態保護：服務拉起到本進程啟動之間若已解鎖，直接退出不彈窗
        if (!LockState.IsEnabled())
        {
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new LockForm());
    }
}
