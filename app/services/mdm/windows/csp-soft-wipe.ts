/**
 * Soft Wipe CSP — ADMX 信箱模式
 *
 * 「學生畢業換人」場景的零 IT 介入清理方案：Agent SYSTEM 權限清乾淨所有
 * 學生痕跡（user profile / 用戶安裝 App / 瀏覽器數據 / Recycle Bin / Temp），
 * **保留** Windows 系統 + CoGrow Agent + MDM 派發的 App + MDM enrollment。
 *
 * Registry 信箱：`HKLM\Software\CoGrow\Agent\SoftWipe`
 *   Trigger (DWORD)          — 1=觸發清理，Agent 完成後清為 0
 *   WhitelistJson (REG_SZ)   — JSON 白名單：{msiProductCodes: [], uwpPfns: [], wingetIds: []}
 *                              Agent 依此決定「哪些不能刪」
 *   WipeId (REG_SZ)          — 唯一 ID（防重放 + 對帳上報）
 *
 * Agent 端流程（詳見 SoftWipeWatcher C#）：
 *   1. 卸載所有非白名單 MSI（msiexec /x {GUID} /qn /norestart）
 *   2. 卸載所有非白名單 UWP（Get-AppxPackage | ? Name -notin whitelist | Remove-AppxPackage）
 *   3. 刪除所有非 admin user profile（net user /delete + Remove-Item C:\Users\<>）
 *   4. 清當前 admin user 的 Desktop / Documents / Downloads / Pictures / Videos
 *   5. 清瀏覽器數據（Edge / Chrome cache / cookies / history / downloads）
 *   6. 清 Recycle Bin + Temp 目錄
 *   7. 上報 POST /agent/soft-wipe-result → 後端發 webhook device.soft_wiped
 *
 * 對比 Windows RemoteWipe/doWipe：
 *   - doWipe：系統層完全重置，需 IT 現場重跑 PPKG 才能回管
 *   - SoftWipe：不動 Windows 系統，Agent 保留，MDM enrollment 保留，秒級完成
 */
import type { SyncMLCommand } from "./syncml.ts";

const ADMX_APP = "CoGrowMDM";
const SOFT_WIPE_ADMX_ID = "SoftWipePolicy";
const SOFT_WIPE_POLICY_AREA = `${ADMX_APP}~Policy~CoGrowSoftWipe`;
const SOFT_WIPE_POLICY_NAME = "SoftWipeState";
const SOFT_WIPE_POLICY_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${SOFT_WIPE_POLICY_AREA}/${SOFT_WIPE_POLICY_NAME}`;

export const AGENT_SOFT_WIPE_REG_PATH = "SOFTWARE/CoGrow/Agent/SoftWipe";

const SOFT_WIPE_ADMX_XML = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="cogrowsoftwipe" namespace="CoGrow.MDM.SoftWipePolicies" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="CoGrowSoftWipe" displayName="CoGrow Soft Wipe" />
  </categories>
  <policies>
    <policy name="SoftWipeState" class="Machine" displayName="Soft Wipe State" explainText="CoGrow deep soft wipe (清乾淨學生痕跡但保 Agent + MDM)" key="Software\\CoGrow\\Agent\\SoftWipe" valueName="Trigger">
      <parentCategory ref="CoGrowSoftWipe" />
      <enabledValue><decimal value="1" /></enabledValue>
      <disabledValue><decimal value="0" /></disabledValue>
      <elements>
        <text id="WhitelistJson" valueName="WhitelistJson" />
        <text id="WipeId" valueName="WipeId" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>`;

export interface SoftWipeWhitelist {
  /** MSI ProductCode GUID 列表（含 `{}`），例：`{12345678-...}`。Agent 卸載 MSI 時跳過這些 */
  msiProductCodes: string[];
  /** UWP PackageFamilyName 列表，例：`Microsoft.WindowsCalculator_8wekyb3d8bbwe`。Agent 卸載 UWP 時跳過 */
  uwpPfns: string[];
  /** winget package ID 列表，例：`7zip.7zip`。Agent 側對照 tracking DB 跳過 */
  wingetIds: string[];
}

export interface SoftWipeEnableInput {
  whitelist: SoftWipeWhitelist;
  /** 唯一 ID（uuid，供 Agent 上報時回帶對帳） */
  wipeId: string;
}

/** ADMX ingest（idempotent Replace） */
export function buildSoftWipeAdmxInstall(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${ADMX_APP}/Policy/${SOFT_WIPE_ADMX_ID}`,
    format: "chr",
    data: SOFT_WIPE_ADMX_XML,
  };
}

/**
 * 觸發 SoftWipe：Trigger=1 + whitelist JSON + wipeId 一起下發。
 * Agent 監聽 Trigger 開始執行，完成後上報並清 Trigger。
 */
export function buildSoftWipeTrigger(input: SoftWipeEnableInput): SyncMLCommand {
  const whitelistJson = JSON.stringify(input.whitelist);
  const admxData = `<enabled/>` +
    `<data id="WhitelistJson" value="${escapeAttr(whitelistJson)}"/>` +
    `<data id="WipeId" value="${escapeAttr(input.wipeId)}"/>`;
  return {
    cmdId: "0",
    verb: "Replace",
    target: SOFT_WIPE_POLICY_TARGET,
    format: "chr",
    data: admxData,
  };
}

/**
 * 取消/清除 SoftWipe 觸發（不會回滾已刪的數據，僅避免 Agent 再次執行）。
 * 通常 Agent 完成後自己清 Trigger，這個 helper 給緊急撤銷場景。
 */
export function buildSoftWipeReset(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: SOFT_WIPE_POLICY_TARGET,
    format: "chr",
    data: `<disabled/>`,
  };
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
