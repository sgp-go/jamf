/**
 * DeviceInstallation Policy CSP（W5 spec §1.2A / PRD §5.4 進階 USB 管控）
 *
 * 比 Storage CSP（Storage/RemovableDisk*）更徹底的設備類別 / 設備 ID 全黑
 * 名單，例如：
 *   - 一刀切禁 USB Class {36fc9e60-c465-11cf-8056-444553540000}（U 盤 + 讀卡機）
 *   - 特定 vendor 的 USB 相機 HardwareID 禁用
 *   - 藍牙 Class {e0cbf06c-cd8b-4647-bb8a-263b43f0f974}
 *
 * MS docs 明確：DeviceInstallation CSP 為原生（**無需 ADMX ingest**），但格式
 * 沿用 ADMX list encoding（`<enabled/>` + `<data id="..._List" value="1${SEP}g1${SEP}2${SEP}g2"/>`
 * 加上 `_Retroactive` 決定是否影響已安裝設備）。
 *
 * 常用 Setup Class GUID（供 admin 快速選）：
 *   {36fc9e60-c465-11cf-8056-444553540000}  USB
 *   {6bdd1fc6-810f-11d0-bec7-08002be2092f}  Image Class（相機 / 掃描器）
 *   {e0cbf06c-cd8b-4647-bb8a-263b43f0f974}  Bluetooth
 *   {ca3e7ab9-b4c3-4ae6-8251-579ef933890f}  Camera
 *
 * Ref: https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-deviceinstallation
 */
import type { SyncMLCommand } from "./syncml.ts";

const PREFIX = "./Device/Vendor/MSFT/Policy/Config/DeviceInstallation";
const CLASSES_TARGET = `${PREFIX}/PreventInstallationOfMatchingDeviceSetupClasses`;
const IDS_TARGET = `${PREFIX}/PreventInstallationOfMatchingDeviceIDs`;
const REMOVABLE_TARGET = `${PREFIX}/PreventInstallationOfRemovableDevices`;
const SEP = "";

export interface DeviceInstallPolicyInput {
  /**
   * Setup Class GUID 黑名單（如 USB 存儲類 `{36fc9e60-...}`）。
   * 必須包含花括號 `{}`；若沒帶會自動包上。
   */
  blockedClasses?: string[];
  /**
   * Hardware ID 黑名單（如 `USB\Composite`、`USB\Class_FF`）。
   */
  blockedHardwareIds?: string[];
  /**
   * 一刀切禁所有 removable device（U 盤 / 外接硬碟 / SD 卡等所有標記為 removable 的類別）。
   * 對已安裝 removable 也失效（Windows 保守處理，不會回退已裝的驅動；只擋新裝）。
   */
  blockRemovableDevices?: boolean;
  /**
   * 對「已安裝」設備也套用政策（強制卸載匹配的已裝驅動）。
   * 預設 false — 只擋新插入設備，不動已裝的（避免 wipe 掉學生正在用的外設）。
   */
  applyRetroactive?: boolean;
}

/**
 * 依輸入產生 DeviceInstallation Policy 命令清單。
 *
 * 各 policy 獨立成一條 Replace（不需要同 transaction batch，Windows 逐條處理），
 * 但 caller 側 `enqueueWindowsCommandsBatch` 仍會統一 batch 送。
 *
 * 空輸入回空陣列（caller 側檢查 length 決定是否拋 empty_input）。
 */
export function buildDeviceInstallPolicy(
  input: DeviceInstallPolicyInput,
): SyncMLCommand[] {
  const cmds: SyncMLCommand[] = [];
  const retro = input.applyRetroactive === true;

  if (input.blockedClasses && input.blockedClasses.length > 0) {
    cmds.push(buildListPolicy(
      CLASSES_TARGET,
      "DeviceInstall_Classes_Deny",
      input.blockedClasses.map(ensureBraces),
      retro,
    ));
  }
  if (input.blockedHardwareIds && input.blockedHardwareIds.length > 0) {
    cmds.push(buildListPolicy(
      IDS_TARGET,
      "DeviceInstall_IDs_Deny",
      input.blockedHardwareIds,
      retro,
    ));
  }
  if (input.blockRemovableDevices === true) {
    cmds.push({
      cmdId: "0",
      verb: "Replace",
      target: REMOVABLE_TARGET,
      format: "chr",
      data: `<enabled/>`,
    });
  }

  return cmds;
}

/**
 * 清除所有 DeviceInstallation policy（三個 target 都送 `<disabled/>`）。
 * 逐條送，caller 可挑要清哪些；helper 一次全清最省事。
 */
export function buildDeviceInstallPolicyClear(): SyncMLCommand[] {
  return [CLASSES_TARGET, IDS_TARGET, REMOVABLE_TARGET].map((t) => ({
    cmdId: "0",
    verb: "Replace",
    target: t,
    format: "chr",
    data: `<disabled/>`,
  }));
}

// ── helpers ──

function ensureBraces(guid: string): string {
  const t = guid.trim();
  if (t.startsWith("{") && t.endsWith("}")) return t;
  if (t.startsWith("{") || t.endsWith("}")) {
    throw new Error(`buildDeviceInstallPolicy: GUID 不完整 (${guid})`);
  }
  return `{${t}}`;
}

function escapeAdmxValue(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function buildListPolicy(
  target: string,
  baseId: string,
  items: string[],
  retroactive: boolean,
): SyncMLCommand {
  for (const it of items) {
    if (it.includes(SEP)) {
      throw new Error(`buildDeviceInstallPolicy: 值含 U+F000 分隔字元 (${it})`);
    }
  }
  const pairs: string[] = [];
  items.forEach((v, i) => {
    pairs.push(String(i + 1));
    pairs.push(escapeAdmxValue(v));
  });
  const listValue = pairs.join(SEP);

  // ⭐ 真機驗證（2026-07-03 PF5XSMN1）：ADMX schema 要求 `_Retroactive` 元素
  // **必須存在**（即使 false），否則 policy engine 回 856「找不到 ADMX 元素」+
  // SyncML 500。所以無論 retroactive 是 true / false 都要送這個 data。
  const parts: string[] = [
    `<enabled/>`,
    `<data id="${baseId}_Retroactive" value="${retroactive ? "true" : "false"}"/>`,
    `<data id="${baseId}_List" value="${listValue}"/>`,
  ];

  return {
    cmdId: "0",
    verb: "Replace",
    target,
    format: "chr",
    data: parts.join(""),
  };
}

/** 常用 Setup Class GUID（供 admin UI 選單 / 文件參考） */
export const COMMON_DEVICE_CLASSES = {
  USB: "{36fc9e60-c465-11cf-8056-444553540000}",
  IMAGE: "{6bdd1fc6-810f-11d0-bec7-08002be2092f}",
  BLUETOOTH: "{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}",
  CAMERA: "{ca3e7ab9-b4c3-4ae6-8251-579ef933890f}",
} as const;
