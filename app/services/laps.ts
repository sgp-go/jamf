/**
 * LAPS-like 密碼託管服務。
 *
 * 納管後 Agent 上線時自動觸發管理員密碼輪換：
 *   後端生成隨機密碼 → 加密存 DB → 透過 ADMX Policy CSP 信箱下發 →
 *   Agent 讀取後執行 net user 改密 → 上報確認 → 後端標記 confirmed。
 */

import { randomBytes } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices, mdmWindowsLaps, selfMdmConfigs } from "~/db/schema/index.ts";
import { encryptSecret, decryptSecret } from "~/lib/secrets.ts";
import {
  buildLapsClear,
  buildLapsRotation,
} from "~/services/mdm/windows/csp.ts";
import { enqueueWindowsCommand } from "~/services/mdm/windows/command.ts";

/**
 * LAPS 未指定目標帳號時的兜底值。優先讀 tenant self_mdm_configs.admin_account_name
 * （PPKG 通常建 ITAdmin，Win11 內建 Administrator 預設禁用）。此常數僅在 tenant
 * 配置查不到時的最後 fallback。
 */
const FALLBACK_ADMIN_ACCOUNT = "ITAdmin";
export type AccountType = "admin" | "student" | "other";
const DEFAULT_PASSWORD_LENGTH = 20;
const STALE_PENDING_HOURS = 24;

// 密碼字元集：避開 shell 問題字元（"、'、`、\）
const CHARSET_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHARSET_LOWER = "abcdefghijklmnopqrstuvwxyz";
const CHARSET_DIGIT = "0123456789";
const CHARSET_SYMBOL = "!@#$%^&*()-_=+[]{}|;:,.<>?/~";
const CHARSET_ALL = CHARSET_UPPER + CHARSET_LOWER + CHARSET_DIGIT + CHARSET_SYMBOL;

/**
 * 生成密碼：每個字元類別至少出現一次，其餘隨機填充。
 * 使用 crypto.randomBytes 確保密碼學安全隨機。
 */
export function generateLapsPassword(length = DEFAULT_PASSWORD_LENGTH): string {
  if (length < 4) throw new RangeError("密碼長度至少 4（每類別至少一個字元）");

  const pick = (charset: string): string => {
    const bytes = randomBytes(1);
    return charset[bytes[0] % charset.length];
  };

  const mandatory = [
    pick(CHARSET_UPPER),
    pick(CHARSET_LOWER),
    pick(CHARSET_DIGIT),
    pick(CHARSET_SYMBOL),
  ];

  const rest: string[] = [];
  for (let i = 0; i < length - 4; i++) {
    rest.push(pick(CHARSET_ALL));
  }

  const chars = [...mandatory, ...rest];
  // Fisher-Yates shuffle
  const shuffleBytes = randomBytes(chars.length);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ── 輪換 ────────────────────────────────────────────────────────────────────

export interface RotateLapsInput {
  tenantId: string;
  deviceId: string;
  /** 目標帳號名；省略 → 從 tenant self_mdm_configs.admin_account_name 讀 */
  adminAccount?: string;
  triggeredBy?: "auto" | "manual";
}

export interface RotateLapsResult {
  rotationId: string;
  commandUuid: string;
}

/**
 * 讀 tenant self_mdm_configs.admin_account_name（自動輪換用）。若未設或空 → fallback "ITAdmin"。
 */
async function resolveTenantAdminAccount(tenantId: string): Promise<string> {
  const cfg = await db.query.selfMdmConfigs.findFirst({
    where: eq(selfMdmConfigs.tenantId, tenantId),
    columns: { adminAccountName: true },
  });
  const name = cfg?.adminAccountName?.trim();
  return name && name.length > 0 ? name : FALLBACK_ADMIN_ACCOUNT;
}

/**
 * 為指定設備觸發一次 admin 密碼輪換（LAPS 語意）：生成密碼 → 加密存 DB → 排 CSP 命令。
 * 目標帳號從 tenant 配置讀；語意固定為 accountType='admin'、requireChange=false。
 */
export async function rotateLapsPassword(
  input: RotateLapsInput,
): Promise<RotateLapsResult> {
  const adminAccount = input.adminAccount ??
    (await resolveTenantAdminAccount(input.tenantId));
  return await runUserPasswordReset({
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    targetAccount: adminAccount,
    accountType: "admin",
    mode: "random",
    triggeredBy: input.triggeredBy ?? "auto",
    requireChangeOnFirstLogon: false,
  });
}

// ── 通用密碼重設（admin 自動輪換 / student 手動重設共用）────────────────────

export interface ResetUserPasswordInput {
  tenantId: string;
  deviceId: string;
  /** 目標本機帳號名（如 "ITAdmin" / "student"） */
  targetAccount: string;
  /** 'admin' | 'student' | 'other'；決定表 row 的 account_type 分類 */
  accountType: AccountType;
  /** 'random' = 系統生成隨機；'explicit' = 使用 explicitPassword */
  mode: "random" | "explicit";
  /** mode='explicit' 時必填 */
  explicitPassword?: string;
  /** true = 附帶 net user /logonpasswordchg:yes；預設 false */
  requireChangeOnFirstLogon?: boolean;
  triggeredBy?: string;
}

/**
 * 通用密碼重設入口：admin 自動輪換與 student 手動重設共用同一通道（同一 ADMX policy + 同一 registry
 * mailbox + 同一 Agent LapsWatcher）。差別只在 accountType 分類 + 是否強制首登改密。
 */
export async function resetUserPassword(
  input: ResetUserPasswordInput,
): Promise<RotateLapsResult> {
  return await runUserPasswordReset({
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    targetAccount: input.targetAccount,
    accountType: input.accountType,
    mode: input.mode,
    explicitPassword: input.explicitPassword,
    requireChangeOnFirstLogon: input.requireChangeOnFirstLogon ?? false,
    triggeredBy: input.triggeredBy ?? "manual",
  });
}

async function runUserPasswordReset(opts: {
  tenantId: string;
  deviceId: string;
  targetAccount: string;
  accountType: AccountType;
  mode: "random" | "explicit";
  explicitPassword?: string;
  requireChangeOnFirstLogon: boolean;
  triggeredBy: string;
}): Promise<RotateLapsResult> {
  if (opts.mode === "explicit") {
    if (!opts.explicitPassword || opts.explicitPassword.length < 4) {
      throw new Error(
        "resetUserPassword: mode=explicit 時 explicitPassword 必填且至少 4 字元",
      );
    }
  }
  const plainPassword = opts.mode === "explicit"
    ? opts.explicitPassword!
    : generateLapsPassword();
  const passwordEnc = encryptSecret(plainPassword);
  const rotationId = crypto.randomUUID();

  const device = await db.query.mdmDevices.findFirst({
    where: and(
      eq(mdmDevices.id, opts.deviceId),
      eq(mdmDevices.tenantId, opts.tenantId),
    ),
    columns: { udid: true },
  });
  if (!device?.udid) {
    throw new Error(
      `resetUserPassword: device ${opts.deviceId} 無 udid，無法排命令`,
    );
  }

  const cmds = buildLapsRotation({
    newPassword: plainPassword,
    adminAccount: opts.targetAccount,
    rotationId,
    requireChangeOnFirstLogon: opts.requireChangeOnFirstLogon,
  });

  const commandUuid = await enqueueWindowsCommand({
    deviceUdid: device.udid,
    commandType: "LapsRotatePassword",
    command: cmds[0],
  });

  await db.insert(mdmWindowsLaps).values({
    tenantId: opts.tenantId,
    deviceId: opts.deviceId,
    rotationId,
    adminAccount: opts.targetAccount,
    accountType: opts.accountType,
    requireChangeOnFirstLogon: opts.requireChangeOnFirstLogon,
    passwordEnc,
    status: "pending",
    commandUuid,
    triggeredBy: opts.triggeredBy,
  });

  console.log(
    `[LAPS] 密碼重設已排入: device=${opts.deviceId} account=${opts.targetAccount} type=${opts.accountType} rotation=${rotationId}`,
  );
  return { rotationId, commandUuid };
}

// ── 確認 ────────────────────────────────────────────────────────────────────

/**
 * Agent 上報確認改密成功。比對 rotationId 避免重放。
 * 回傳 true 表示確認成功。
 */
export async function confirmLapsRotation(opts: {
  deviceId: string;
  rotationId: string;
}): Promise<boolean> {
  // 按 rotationId 精確找（跨 admin/student 通用，避免同設備多 pending 混淆）
  const row = await db.query.mdmWindowsLaps.findFirst({
    where: and(
      eq(mdmWindowsLaps.deviceId, opts.deviceId),
      eq(mdmWindowsLaps.rotationId, opts.rotationId),
      eq(mdmWindowsLaps.status, "pending"),
    ),
    columns: { id: true },
  });

  if (!row) {
    console.warn(
      `[LAPS] 確認失敗: device=${opts.deviceId} rotationId=${opts.rotationId} 找不到對應 pending row`,
    );
    return false;
  }

  await db
    .update(mdmWindowsLaps)
    .set({ status: "confirmed", confirmedAt: new Date(), updatedAt: new Date() })
    .where(eq(mdmWindowsLaps.id, row.id));

  console.log(`[LAPS] 密碼重設已確認: device=${opts.deviceId} rotation=${opts.rotationId}`);
  return true;
}

// ── 查詢 ────────────────────────────────────────────────────────────────────

export interface LapsPasswordInfo {
  password: string;
  adminAccount: string;
  rotatedAt: string;
  rotationId: string;
  status: string;
  accountType: string;
  requireChangeOnFirstLogon: boolean;
}

/**
 * IT 查詢設備當前 admin 密碼：取最新 confirmed + accountType='admin' 記錄，解密返回。
 * 保持向後兼容：若 tenant/device 有多個 admin 帳號記錄，回最新一筆（跨帳號）。
 * 若需要指定帳號名查詢，用 getUserPassword。
 */
export async function getLapsPassword(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<LapsPasswordInfo | null> {
  const row = await db.query.mdmWindowsLaps.findFirst({
    where: and(
      eq(mdmWindowsLaps.tenantId, opts.tenantId),
      eq(mdmWindowsLaps.deviceId, opts.deviceId),
      eq(mdmWindowsLaps.accountType, "admin"),
      eq(mdmWindowsLaps.status, "confirmed"),
    ),
    orderBy: [desc(mdmWindowsLaps.createdAt)],
  });
  return row ? rowToInfo(row) : null;
}

/**
 * IT 查詢設備上「指定帳號」的最新 confirmed 密碼（跨 admin/student/other 通用）。
 */
export async function getUserPassword(opts: {
  tenantId: string;
  deviceId: string;
  targetAccount: string;
}): Promise<LapsPasswordInfo | null> {
  const row = await db.query.mdmWindowsLaps.findFirst({
    where: and(
      eq(mdmWindowsLaps.tenantId, opts.tenantId),
      eq(mdmWindowsLaps.deviceId, opts.deviceId),
      eq(mdmWindowsLaps.adminAccount, opts.targetAccount),
      eq(mdmWindowsLaps.status, "confirmed"),
    ),
    orderBy: [desc(mdmWindowsLaps.createdAt)],
  });
  return row ? rowToInfo(row) : null;
}

function rowToInfo(row: {
  passwordEnc: string;
  adminAccount: string;
  confirmedAt: Date | null;
  createdAt: Date;
  rotationId: string;
  status: string;
  accountType: string;
  requireChangeOnFirstLogon: boolean;
}): LapsPasswordInfo {
  return {
    password: decryptSecret(row.passwordEnc),
    adminAccount: row.adminAccount,
    rotatedAt: (row.confirmedAt ?? row.createdAt).toISOString(),
    rotationId: row.rotationId,
    status: row.status,
    accountType: row.accountType,
    requireChangeOnFirstLogon: row.requireChangeOnFirstLogon,
  };
}

// ── 觸發判斷 ────────────────────────────────────────────────────────────────

/**
 * 判斷是否需要自動觸發 LAPS 輪換：
 *   - 無記錄 → true（首次）
 *   - 最新 confirmed → false（已輪換，無需再跑）
 *   - 最新 pending 超過 STALE_PENDING_HOURS → true（重試）
 *   - 最新 pending 未超時 → false（等 Agent 回覆）
 */
export async function shouldTriggerLaps(deviceId: string): Promise<boolean> {
  // 只判斷 admin 帳號的輪換狀態；student 手動重設不影響自動 LAPS 決策
  const latest = await db.query.mdmWindowsLaps.findFirst({
    where: and(
      eq(mdmWindowsLaps.deviceId, deviceId),
      eq(mdmWindowsLaps.accountType, "admin"),
    ),
    orderBy: [desc(mdmWindowsLaps.createdAt)],
    columns: { status: true, createdAt: true },
  });

  if (!latest) return true;
  if (latest.status === "confirmed") return false;
  if (latest.status === "pending") {
    const staleThreshold = new Date(
      Date.now() - STALE_PENDING_HOURS * 60 * 60 * 1000,
    );
    return latest.createdAt < staleThreshold;
  }
  // failed → 可重試
  return true;
}

// ── 確認 + 清 registry（report / checkin 共用）────────────────────────────────

/**
 * 確認某次輪換成功，成功則排 buildLapsClear 清 registry 殘留。
 * 回傳 confirmLapsRotation 的結果。
 */
async function confirmAndClearLaps(opts: {
  deviceId: string;
  rotationId: string;
}): Promise<boolean> {
  const confirmed = await confirmLapsRotation(opts);
  if (!confirmed) return false;

  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.id, opts.deviceId),
    columns: { udid: true },
  });
  if (device?.udid) {
    const cmds = buildLapsClear();
    await enqueueWindowsCommand({
      deviceUdid: device.udid,
      commandType: "LapsClearPolicy",
      command: cmds[0],
    });
  }
  return true;
}

// ── Report Hook ─────────────────────────────────────────────────────────────

/**
 * Agent report 後的非阻塞 LAPS 處理。
 *
 * 兩條路：
 *   1. 有 laps 確認 → confirmLapsRotation + 排 buildLapsClear 清 registry
 *   2. 無確認 → shouldTriggerLaps → rotateLapsPassword
 */
export async function handleLapsOnReport(opts: {
  tenantId: string;
  deviceId: string;
  extraData: Record<string, unknown>;
}): Promise<void> {
  const windows = opts.extraData?.windows as
    | { laps?: { rotation_id?: string } }
    | undefined;

  if (windows?.laps?.rotation_id) {
    await confirmAndClearLaps({
      deviceId: opts.deviceId,
      rotationId: windows.laps.rotation_id,
    });
    return;
  }

  const needed = await shouldTriggerLaps(opts.deviceId);
  if (needed) {
    await rotateLapsPassword({
      tenantId: opts.tenantId,
      deviceId: opts.deviceId,
      triggeredBy: "auto",
    });
  }
}

// ── Checkin Hook ──────────────────────────────────────────────────────────────

/**
 * Agent 啟動 checkin 回傳的待辦動作。
 * 注意：密碼僅經 MDM CSP 通道下發，action 不攜帶任何密碼，只告知 Agent
 * 有進行中的輪換（Agent 的 LapsWatcher 從 registry 取密碼執行）。
 */
export interface CheckinAction {
  type: string;
  priority: number;
  data: Record<string, unknown>;
}

/**
 * 純函數：把「最新 pending 輪換」映射成 checkin 告知動作。
 * pending 為 null 時回傳空陣列。
 */
export function buildLapsPendingActions(
  pending: { rotationId: string; adminAccount: string } | null,
): CheckinAction[] {
  if (!pending) return [];
  return [
    {
      type: "laps_rotation_pending",
      priority: 100,
      data: {
        rotationId: pending.rotationId,
        adminAccount: pending.adminAccount,
      },
    },
  ];
}

/**
 * Agent 啟動 checkin 的 LAPS 處理 —— 讓輪換在 Agent 上線即觸發 / 確認，
 * 不必等每日 report 週期。
 *
 *   1. 帶 lapsRotationId → 確認上次改密 + 清 registry
 *   2. 否則 shouldTriggerLaps → 需要則 rotateLapsPassword（上線即觸發）
 *
 * 觸發 / 確認失敗不拋（容錯）：checkin 的上線信號仍須成立。最後查最新
 * pending 輪換，回傳告知動作（密碼走 CSP，此處僅告知）。
 */
export async function handleLapsOnCheckin(opts: {
  tenantId: string;
  deviceId: string;
  lapsRotationId?: string;
}): Promise<CheckinAction[]> {
  try {
    if (opts.lapsRotationId) {
      await confirmAndClearLaps({
        deviceId: opts.deviceId,
        rotationId: opts.lapsRotationId,
      });
    } else if (await shouldTriggerLaps(opts.deviceId)) {
      await rotateLapsPassword({
        tenantId: opts.tenantId,
        deviceId: opts.deviceId,
        triggeredBy: "auto",
      });
    }
  } catch (err) {
    console.error("[LAPS] handleLapsOnCheckin 處理失敗（不影響 checkin）", err);
  }

  const pending = await db.query.mdmWindowsLaps.findFirst({
    where: and(
      eq(mdmWindowsLaps.deviceId, opts.deviceId),
      eq(mdmWindowsLaps.status, "pending"),
    ),
    orderBy: [desc(mdmWindowsLaps.createdAt)],
    columns: { rotationId: true, adminAccount: true },
  });

  return buildLapsPendingActions(pending ?? null);
}
