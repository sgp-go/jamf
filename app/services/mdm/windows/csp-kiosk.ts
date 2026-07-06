/**
 * Kiosk Mode CSP — AssignedAccess Configuration
 *
 * CSP path: `./Vendor/MSFT/AssignedAccess/Configuration`
 * Verb: **Replace**（同 firewall / lost-mode 教訓：leaf 節點 Add 對 re-enroll
 * 設備會 418 Already Exists。統一 Replace 是 idempotent 的正確做法）。
 * Delete verb 移除整個 configuration → 恢復桌面。
 *
 * Windows AssignedAccess 兩種單 App 模式（**Win10/11 Pro / Enterprise / Edu 均支援**）：
 *   1. **UWP Kiosk**（2017/config schema）：
 *      `<KioskModeApp AppUserModelId="AUMID" />`
 *   2. **Chromium Edge / Win32 Kiosk**（2021/config schema，Win 11 21H2+）：
 *      `<KioskModeApp v4:ClassicAppPath="msedge.exe" v4:ClassicAppArguments="--kiosk URL --edge-kiosk-type=..." />`
 *
 * 2026-07-06 調研勘誤：早先誤以為 Chromium Edge Kiosk 需要 Enterprise SKU 走
 * Shell Launcher —— 錯。MS 官方 2025 更新後 AssignedAccess v4 schema 直接支援
 * ClassicAppPath 指到 msedge.exe 完整路徑 + kiosk args，Pro SKU 可用。
 * 見 [[windows-kiosk-mode-mvp-2026-07-06]] 詳細調研筆記。
 *
 * BreakoutSequence（v4 namespace，Win 11 21H2+）：可選按鍵組合，觸發後彈切換
 * 使用者對話框，需輸入 admin 密碼（走現有 LAPS 通道查 ITAdmin 密碼）。
 */
import type { SyncMLCommand } from "./syncml.ts";

const ASSIGNED_ACCESS_TARGET =
  "./Vendor/MSFT/AssignedAccess/Configuration";

/** Kiosk profile 固定 GUID（AssignedAccess XML 要求 Profile Id 是 UUID） */
const KIOSK_PROFILE_GUID = "{9A2A490F-10F6-4764-974A-43B19E722C23}";

const NS_ROOT = "http://schemas.microsoft.com/AssignedAccess/2017/config";
const NS_V4 = "http://schemas.microsoft.com/AssignedAccess/2021/config";

/** Chromium Edge Stable 安裝路徑（各 Windows 版本一致） */
const EDGE_STABLE_PATH =
  "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe";

export type KioskAppType = "edge_kiosk" | "uwp";
export type KioskEdgeVariant = "public_browsing" | "digital_signage";

export interface KioskConfigInput {
  appType: KioskAppType;
  /** edge_kiosk 必填：啟動 URL（如 https://exam.school.edu.tw） */
  edgeUrl?: string;
  /** edge_kiosk 必填：public_browsing=考試/公用（idle 重啟清 session）；digital_signage=展示 */
  edgeVariant?: KioskEdgeVariant;
  /**
   * edge_kiosk 選填：public_browsing 場景下多久 idle 重啟 session 清瀏覽資料（分鐘）。
   * 預設 2 分鐘。digital_signage 不用。
   */
  edgeIdleTimeoutMinutes?: number;
  /** uwp 必填：目標 AUMID（Get-StartApps 取得） */
  aumid?: string;
  /** AutoLogon 的本機帳號（PPKG 建的學生帳號） */
  autoLogonAccount: string;
  /** 應急退出組合鍵（如 "Ctrl+Alt+B"）；null 或 undefined = 禁 breakout */
  breakoutSequence?: string | null;
}

/**
 * 產生 AssignedAccess Configuration XML。
 * 內容作為 SyncML `<Data>` 傳送，syncml.ts 會做 xml-escape。
 */
export function buildAssignedAccessConfigXml(input: KioskConfigInput): string {
  const account = escapeAttr(input.autoLogonAccount);
  // BreakoutSequence 是 v4 namespace（不是 rs5，rs5 是 2018/config 用於 multi-app）
  const breakout = input.breakoutSequence
    ? `\n      <v4:BreakoutSequence Key="${escapeAttr(input.breakoutSequence)}" />`
    : "";

  let profileBody: string;
  if (input.appType === "uwp") {
    if (!input.aumid) {
      throw new Error("uwp kiosk requires aumid");
    }
    profileBody = `      <KioskModeApp AppUserModelId="${escapeAttr(input.aumid)}" />`;
  } else {
    if (!input.edgeUrl || !input.edgeVariant) {
      throw new Error("edge_kiosk requires edgeUrl and edgeVariant");
    }
    const kioskTypeArg = input.edgeVariant === "public_browsing"
      ? "public-browsing"
      : "fullscreen";
    const idleMinutes = input.edgeIdleTimeoutMinutes ?? 2;
    const argsParts = [
      "--kiosk",
      input.edgeUrl,
      `--edge-kiosk-type=${kioskTypeArg}`,
      "--no-first-run",
    ];
    if (input.edgeVariant === "public_browsing") {
      argsParts.push(`--kiosk-idle-timeout-minutes=${idleMinutes}`);
    }
    const args = argsParts.join(" ");
    profileBody = `      <KioskModeApp v4:ClassicAppPath="${
      escapeAttr(EDGE_STABLE_PATH)
    }" v4:ClassicAppArguments="${escapeAttr(args)}" />`;
  }

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<AssignedAccessConfiguration`,
    `    xmlns="${NS_ROOT}"`,
    `    xmlns:v4="${NS_V4}">`,
    `  <Profiles>`,
    `    <Profile Id="${KIOSK_PROFILE_GUID}">`,
    profileBody + breakout,
    `    </Profile>`,
    `  </Profiles>`,
    `  <Configs>`,
    `    <Config>`,
    `      <Account>${account}</Account>`,
    `      <DefaultProfile Id="${KIOSK_PROFILE_GUID}"/>`,
    `    </Config>`,
    `  </Configs>`,
    `</AssignedAccessConfiguration>`,
  ].join("\n");
}

/**
 * 派發 Kiosk configuration。
 * Replace verb 統一 idempotent（見 firewall_csp_replace_verb 教訓）。
 */
export function buildKioskApply(input: KioskConfigInput): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: ASSIGNED_ACCESS_TARGET,
    format: "chr",
    data: buildAssignedAccessConfigXml(input),
  };
}

/**
 * 移除 Kiosk configuration → 恢復桌面。
 * AssignedAccess 支援對 Configuration 節點下 Delete verb 清空整份配置。
 */
export function buildKioskRemove(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Delete",
    target: ASSIGNED_ACCESS_TARGET,
  };
}

/**
 * 查詢設備當前 Kiosk 配置（回應 XML 或空）。
 * 用於對帳 / 確認 Replace 是否已生效。
 */
export function buildKioskQuery(): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Get",
    target: ASSIGNED_ACCESS_TARGET,
  };
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
