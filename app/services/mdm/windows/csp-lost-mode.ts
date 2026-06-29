/**
 * Lost Mode CSP — ADMX 信箱模式
 *
 * Windows 沒有原生 Lost Mode 命令（不像 iOS Apple MDM 的 LostMode/PlayLostModeSound）。
 * 用 ADMX Policy CSP 推 Registry 信箱 → Agent GpsCollector 監聽 Enabled 切換 GPS 採集頻率
 *（平時 24h / Lost Mode 30s），LockUI（既有）顯示找回訊息與聯絡電話。
 *
 * Registry 信箱：HKLM\Software\CoGrow\Agent\LostMode
 *   Enabled (DWORD)           — 1=啟用, 0=關閉
 *   Message (REG_SZ)          — 鎖屏顯示找回訊息（例如「請聯絡光復國小資訊組」）
 *   Phone (REG_SZ)            — 鎖屏顯示聯絡電話
 *   Footnote (REG_SZ)         — 鎖屏顯示輔助訊息（選填）
 *   LostModeId (REG_SZ)       — 唯一 ID（防重放 + 回報對帳）
 *
 * Agent 端：
 *   - GpsCollector 30s tick 內讀 Enabled，切換採集頻率
 *   - LockUI 沿用 Lock pattern 顯示 Message/Phone/Footnote（後續 UI 改造）
 *
 * **同步推送 LegalNoticeText/Caption**（登入前找回信息）：Windows 沒有原生 Lost Mode 鎖屏命令，
 * 但 `LocalPoliciesSecurityOptions/InteractiveLogon_MessageText*` 可以強制讓使用者 Ctrl+Alt+Del
 * 進入登入畫面前看到找回訊息，**不依賴 Agent**。disable 時清空（傳空字串）。
 *
 * iOS Lost Mode 走 Apple MDM 命令（既有 app/services/devices.ts），與此模組無關。
 */
import type { SyncMLCommand } from "./syncml.ts";

const ADMX_APP = "CoGrowMDM";
const LOST_MODE_ADMX_ID = "LostModePolicy";
const LOST_MODE_POLICY_AREA = `${ADMX_APP}~Policy~CoGrowLostMode`;
const LOST_MODE_POLICY_NAME = "LostModeState";
const LOST_MODE_POLICY_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${LOST_MODE_POLICY_AREA}/${LOST_MODE_POLICY_NAME}`;

/** 登入前找回訊息（原生 Policy CSP，無需 ADMX）— Lost Mode 同步推送 */
const LEGAL_NOTICE_TEXT_TARGET =
  "./Device/Vendor/MSFT/Policy/Config/LocalPoliciesSecurityOptions/InteractiveLogon_MessageTextForUsersAttemptingToLogOn";
const LEGAL_NOTICE_CAPTION_TARGET =
  "./Device/Vendor/MSFT/Policy/Config/LocalPoliciesSecurityOptions/InteractiveLogon_MessageTitleForUsersAttemptingToLogOn";

export const AGENT_LOST_MODE_REG_PATH = "SOFTWARE/CoGrow/Agent/LostMode";

const LOST_MODE_ADMX_XML = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="cogrowlostmode" namespace="CoGrow.MDM.LostModePolicies" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="CoGrowLostMode" displayName="CoGrow Lost Mode" />
  </categories>
  <policies>
    <policy name="LostModeState" class="Machine" displayName="Lost Mode State" explainText="CoGrow remote lost mode" key="Software\\CoGrow\\Agent\\LostMode" valueName="Enabled">
      <parentCategory ref="CoGrowLostMode" />
      <enabledValue><decimal value="1" /></enabledValue>
      <disabledValue><decimal value="0" /></disabledValue>
      <elements>
        <text id="Message" valueName="Message" />
        <text id="Phone" valueName="Phone" />
        <text id="Footnote" valueName="Footnote" />
        <text id="LostModeId" valueName="LostModeId" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>`;

/**
 * Lost Mode ADMX ingest。用 Replace 統一 idempotent — 見 csp.ts buildLockAdmxInstall
 * 註解（6/25 真機驗證 Add verb 對 re-enroll 設備永遠 418）。
 */
export function buildLostModeAdmxInstall(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${ADMX_APP}/Policy/${LOST_MODE_ADMX_ID}`,
    format: "chr",
    data: LOST_MODE_ADMX_XML,
  };
}

export interface LostModeEnableInput {
  /** 鎖屏顯示找回訊息 */
  message: string;
  /** 鎖屏顯示聯絡電話 */
  phone: string;
  /** 鎖屏顯示輔助訊息（**【選填】**） */
  footnote?: string;
  /** 唯一 ID（用 nanoid / uuid，便於回報對帳） */
  lostModeId: string;
}

/**
 * 下發 Lost Mode 啟用：
 *   1. ADMX state Replace → 設備 Registry 落 Enabled=1 + 找回訊息（Agent GpsCollector 用）
 *   2. LegalNoticeText/Caption → 登入前找回訊息（OS 原生顯示，無需 Agent UI 改造）
 *
 * 兩條獨立路徑同時推：即使 Agent 服務未跑，使用者按 Ctrl+Alt+Del 仍看到找回訊息。
 *
 * LegalNoticeText 內容組裝：`{message}\n\n聯絡電話：{phone}\n\n{footnote}`，分行顯示更易讀。
 */
export function buildLostModeEnable(input: LostModeEnableInput): SyncMLCommand[] {
  const msg = escapeAttr(input.message);
  const phone = escapeAttr(input.phone);
  const footnote = escapeAttr(input.footnote ?? "");
  const id = escapeAttr(input.lostModeId);
  const admxData = `<enabled/>` +
    `<data id="Message" value="${msg}"/>` +
    `<data id="Phone" value="${phone}"/>` +
    `<data id="Footnote" value="${footnote}"/>` +
    `<data id="LostModeId" value="${id}"/>`;

  // LegalNoticeText raw text（syncml.ts 自動 escapeXml，這裡不再 escape）
  const noticeText = [
    input.message,
    `聯絡電話：${input.phone}`,
    input.footnote ?? "",
  ].filter((s) => s.length > 0).join("\n\n");

  return [
    {
      cmdId: "0",
      verb: "Replace",
      target: LOST_MODE_POLICY_TARGET,
      format: "chr",
      data: admxData,
    },
    {
      cmdId: "0",
      verb: "Replace",
      target: LEGAL_NOTICE_CAPTION_TARGET,
      format: "chr",
      data: "設備已啟用遺失模式",
    },
    {
      cmdId: "0",
      verb: "Replace",
      target: LEGAL_NOTICE_TEXT_TARGET,
      format: "chr",
      data: noticeText,
    },
  ];
}

/**
 * 關閉 Lost Mode：
 *   1. ADMX state Replace disabled → Enabled=0，Agent 切回平時 24h
 *   2. LegalNoticeText/Caption 清空（推空字串覆蓋）
 */
export function buildLostModeDisable(): SyncMLCommand[] {
  return [
    {
      cmdId: "0",
      verb: "Replace",
      target: LOST_MODE_POLICY_TARGET,
      format: "chr",
      data: `<disabled/>`,
    },
    {
      cmdId: "0",
      verb: "Replace",
      target: LEGAL_NOTICE_CAPTION_TARGET,
      format: "chr",
      data: "",
    },
    {
      cmdId: "0",
      verb: "Replace",
      target: LEGAL_NOTICE_TEXT_TARGET,
      format: "chr",
      data: "",
    },
  ];
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
