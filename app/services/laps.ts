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
import { mdmDevices, mdmWindowsLaps } from "~/db/schema/index.ts";
import { encryptSecret, decryptSecret } from "~/lib/secrets.ts";
import {
  buildLapsClear,
  buildLapsRotation,
} from "~/services/mdm/windows/csp.ts";
import { enqueueWindowsCommand } from "~/services/mdm/windows/command.ts";

const DEFAULT_ADMIN_ACCOUNT = "Administrator";
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
  adminAccount?: string;
  triggeredBy?: "auto" | "manual";
}

export interface RotateLapsResult {
  rotationId: string;
  commandUuid: string;
}

/**
 * 為指定設備觸發一次密碼輪換：生成密碼 → 加密存 DB → 排 CSP 命令。
 */
export async function rotateLapsPassword(
  input: RotateLapsInput,
): Promise<RotateLapsResult> {
  const adminAccount = input.adminAccount ?? DEFAULT_ADMIN_ACCOUNT;
  const plainPassword = generateLapsPassword();
  const passwordEnc = encryptSecret(plainPassword);
  const rotationId = crypto.randomUUID();

  const device = await db.query.mdmDevices.findFirst({
    where: and(
      eq(mdmDevices.id, input.deviceId),
      eq(mdmDevices.tenantId, input.tenantId),
    ),
    columns: { udid: true },
  });
  if (!device?.udid) {
    throw new Error(`rotateLapsPassword: device ${input.deviceId} 無 udid，無法排命令`);
  }

  const cmds = buildLapsRotation({
    newPassword: plainPassword,
    adminAccount,
    rotationId,
  });

  const commandUuid = await enqueueWindowsCommand({
    deviceUdid: device.udid,
    commandType: "LapsRotatePassword",
    command: cmds[0],
  });

  await db.insert(mdmWindowsLaps).values({
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    rotationId,
    adminAccount,
    passwordEnc,
    status: "pending",
    commandUuid,
    triggeredBy: input.triggeredBy ?? "auto",
  });

  console.log(
    `[LAPS] 密碼輪換已排入: device=${input.deviceId} rotation=${rotationId} trigger=${input.triggeredBy ?? "auto"}`,
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
  const latest = await db.query.mdmWindowsLaps.findFirst({
    where: and(
      eq(mdmWindowsLaps.deviceId, opts.deviceId),
      eq(mdmWindowsLaps.status, "pending"),
    ),
    orderBy: [desc(mdmWindowsLaps.createdAt)],
    columns: { id: true, rotationId: true },
  });

  if (!latest || latest.rotationId !== opts.rotationId) {
    console.warn(
      `[LAPS] 確認失敗: device=${opts.deviceId} 提交的 rotationId=${opts.rotationId} 不匹配最新 pending`,
    );
    return false;
  }

  await db
    .update(mdmWindowsLaps)
    .set({ status: "confirmed", confirmedAt: new Date(), updatedAt: new Date() })
    .where(eq(mdmWindowsLaps.id, latest.id));

  console.log(`[LAPS] 密碼輪換已確認: device=${opts.deviceId} rotation=${opts.rotationId}`);
  return true;
}

// ── 查詢 ────────────────────────────────────────────────────────────────────

export interface LapsPasswordInfo {
  password: string;
  adminAccount: string;
  rotatedAt: string;
  rotationId: string;
  status: string;
}

/**
 * IT 查詢設備當前管理員密碼（取最新 confirmed 記錄，解密返回）。
 */
export async function getLapsPassword(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<LapsPasswordInfo | null> {
  const row = await db.query.mdmWindowsLaps.findFirst({
    where: and(
      eq(mdmWindowsLaps.tenantId, opts.tenantId),
      eq(mdmWindowsLaps.deviceId, opts.deviceId),
      eq(mdmWindowsLaps.status, "confirmed"),
    ),
    orderBy: [desc(mdmWindowsLaps.createdAt)],
  });

  if (!row) return null;

  return {
    password: decryptSecret(row.passwordEnc),
    adminAccount: row.adminAccount,
    rotatedAt: (row.confirmedAt ?? row.createdAt).toISOString(),
    rotationId: row.rotationId,
    status: row.status,
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
  const latest = await db.query.mdmWindowsLaps.findFirst({
    where: eq(mdmWindowsLaps.deviceId, deviceId),
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
    const confirmed = await confirmLapsRotation({
      deviceId: opts.deviceId,
      rotationId: windows.laps.rotation_id,
    });
    if (confirmed) {
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
    }
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
