/**
 * Experience Policy CSP — 防脫離（教育場景）
 *
 * 禁止使用者在「設定 → 存取公司或學校資源」手動斷開 MDM 納管。
 *
 * 路徑：./Device/Vendor/MSFT/Policy/Config/Experience/AllowManualMDMUnenrollment
 *   - 0 = 禁止手動注銷（GUI「斷開連接」按鈕灰掉 / 消失）
 *   - 1 = 允許（Windows 預設）
 *
 * ⚠️ 邊界：這條策略**只擋 GUI 主動注銷**，擋不住有本機管理員權限的使用者
 * 「重置此電腦」或用 USB 重裝系統脫離。完整防脫離是縱深防禦：
 *   標準帳號（無管理員）+ BIOS 鎖禁 USB 引導 + BitLocker + 本策略 + 失聯告警。
 * 「抹機後強制自動回歸」需 Windows Autopilot（Intune/Azure），自建 MDM 做不到。
 * 詳見 brain：projects/jamf-explore/wiki/windows-mdm-anti-unenroll.md。
 *
 * MS 文件依據：policy-csp-experience（AllowManualMDMUnenrollment）
 */
import type { SyncMLCommand } from "./syncml.ts";

const ALLOW_MANUAL_UNENROLL_TARGET =
  "./Device/Vendor/MSFT/Policy/Config/Experience/AllowManualMDMUnenrollment";

/**
 * 設定是否允許使用者手動注銷 MDM。
 *
 * @param allow false=禁止（教育場景，鎖定納管）；true=恢復 Windows 預設允許
 */
export function buildSetManualUnenroll(allow: boolean): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: ALLOW_MANUAL_UNENROLL_TARGET,
    format: "int",
    data: allow ? "1" : "0",
  };
}

/**
 * 隱藏「重設此電腦」入口（設定 → 系統 → 復原頁面整頁隱藏）。
 *
 * 路徑：./Device/Vendor/MSFT/Policy/Config/Settings/PageVisibilityList
 * 值：`hide:recovery`（隱藏 ms-settings:recovery 頁面）
 *
 * ⚠️ 這是 UI 層隱藏，不是系統層禁用。搭配標準帳戶 + LAPS 已足夠。
 */
const PAGE_VISIBILITY_TARGET =
  "./Device/Vendor/MSFT/Policy/Config/Settings/PageVisibilityList";

export function buildSetAllowRestore(allow: boolean): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: PAGE_VISIBILITY_TARGET,
    format: "chr",
    data: allow ? "showonly:" : "hide:recovery",
  };
}
