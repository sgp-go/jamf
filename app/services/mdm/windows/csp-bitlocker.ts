/**
 * BitLocker CSP — ADMX 信箱模式
 *
 * 非 AAD 設備上 BitLocker CSP 的 RequireDeviceEncryption 無法靜默加密
 * （Win10 會彈確認框）。改用 ADMX Policy CSP → Registry 信箱 → Agent 本地
 * 執行 Enable-BitLocker 的模式（與 LAPS 完全一致）。
 *
 * Registry 信箱：HKLM\Software\CoGrow\Agent\BitLocker
 *   Pending (DWORD)        — 1=待執行
 *   EncryptionId (REG_SZ)  — 唯一 ID（防重放 + 回報對帳）
 *   EncryptionMethod (REG_SZ) — 加密演算法（XtsAes256 等）
 *
 * Agent BitLockerWatcher 偵測 Pending=1 後：
 *   1. Enable-BitLocker -MountPoint C: -TpmProtector
 *   2. Add-BitLockerKeyProtector -MountPoint C: -RecoveryPasswordProtector
 *   3. 捕獲 RecoveryPassword 寫入確認檔
 *   4. 下次 report 帶回 → 後端存儲
 */
import type { SyncMLCommand } from "./syncml.ts";

const ADMX_APP = "CoGrowMDM";
const BITLOCKER_ADMX_ID = "BitLockerPolicy";
const BITLOCKER_POLICY_AREA = `${ADMX_APP}~Policy~CoGrowBitLocker`;
const BITLOCKER_POLICY_NAME = "BitLockerEnable";
const BITLOCKER_POLICY_TARGET =
  `./Device/Vendor/MSFT/Policy/Config/${BITLOCKER_POLICY_AREA}/${BITLOCKER_POLICY_NAME}`;

export const AGENT_BITLOCKER_REG_PATH = "SOFTWARE/CoGrow/Agent/BitLocker";

const BITLOCKER_ADMX_XML = `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="cogrowbitlocker" namespace="CoGrow.MDM.BitLockerPolicies" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="CoGrowBitLocker" displayName="CoGrow BitLocker" />
  </categories>
  <policies>
    <policy name="BitLockerEnable" class="Machine" displayName="BitLocker Enable" explainText="CoGrow BitLocker silent encryption" key="Software\\CoGrow\\Agent\\BitLocker" valueName="Pending">
      <parentCategory ref="CoGrowBitLocker" />
      <enabledValue><decimal value="1" /></enabledValue>
      <disabledValue><decimal value="0" /></disabledValue>
      <elements>
        <text id="EncryptionId" valueName="EncryptionId" />
        <text id="EncryptionMethod" valueName="EncryptionMethod" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>`;

/**
 * BitLocker ADMX ingest。用 Replace 統一 idempotent — 見 csp.ts buildLockAdmxInstall
 * 註解（6/25 真機驗證 Add verb 對 re-enroll 設備永遠 418 → PolicyManager state 不一致）。
 */
export function buildBitLockerAdmxInstall(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target:
      `./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/${ADMX_APP}/Policy/${BITLOCKER_ADMX_ID}`,
    format: "chr",
    data: BITLOCKER_ADMX_XML,
  };
}

export interface BitLockerEnableInput {
  encryptionId: string;
  encryptionMethod?: string;
}

/**
 * 下發 BitLocker 加密指令：啟用策略，Agent 讀到 Pending=1 後執行 Enable-BitLocker。
 */
export function buildBitLockerEnable(input: BitLockerEnableInput): SyncMLCommand[] {
  const id = escapeAttr(input.encryptionId);
  const method = escapeAttr(input.encryptionMethod ?? "XtsAes256");
  const data = `<enabled/>` +
    `<data id="EncryptionId" value="${id}"/>` +
    `<data id="EncryptionMethod" value="${method}"/>`;
  return [{
    cmdId: "0",
    verb: "Replace",
    target: BITLOCKER_POLICY_TARGET,
    format: "chr",
    data,
  }];
}

/**
 * 清除 BitLocker 策略（disabled）：Agent 確認加密後由後端下發。
 */
export function buildBitLockerClear(): SyncMLCommand[] {
  return [{
    cmdId: "0",
    verb: "Replace",
    target: BITLOCKER_POLICY_TARGET,
    format: "chr",
    data: `<disabled/>`,
  }];
}

/**
 * BitLocker 可查詢狀態節點（直接 CSP Get）。
 */
export type BitLockerStatusNode =
  | "RequireDeviceEncryption"
  | "Status";

export function buildBitLockerStatusQuery(
  nodes: BitLockerStatusNode[] = ["Status"],
): SyncMLCommand[] {
  if (nodes.length === 0) {
    throw new Error("buildBitLockerStatusQuery: nodes 不可為空");
  }
  return nodes.map((node) => ({
    cmdId: "0",
    verb: "Get" as const,
    target: `./Device/Vendor/MSFT/BitLocker/${node}`,
  }));
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
