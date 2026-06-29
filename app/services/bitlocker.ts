/**
 * BitLocker Recovery Key 託管服務。
 *
 * enrollment 後自動觸發 BitLocker 加密：
 *   後端排入 ADMX enable 命令 → Agent BitLockerWatcher 靜默加密 →
 *   捕獲 Recovery Password 寫確認檔 → 下次 report 帶回 →
 *   後端加密存 DB → IT 按設備查詢。
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmWindowsBitlocker } from "~/db/schema/bitlocker.ts";
import { encryptSecret, decryptSecret } from "~/lib/secrets.ts";
import { buildBitLockerClear } from "~/services/mdm/windows/csp-bitlocker.ts";
import { enqueueWindowsCommand } from "~/services/mdm/windows/command.ts";
import { mdmDevices } from "~/db/schema/devices.ts";

// ── Report Hook ─────────────────────────────────────────────────────────────

/**
 * Agent report 後的非阻塞 BitLocker 處理。
 *
 * 有 bitlocker 確認（encryption_id + recovery_password）→ 確認 + 存 recovery key + 清 registry
 */
export async function handleBitLockerOnReport(opts: {
  tenantId: string;
  deviceId: string;
  extraData: Record<string, unknown>;
}): Promise<void> {
  const windows = opts.extraData?.windows as
    | {
        bitlocker?: {
          encryption_id?: string;
          recovery_password?: string;
          protection_status?: string;
          volume_status?: string;
          encryption_percentage?: number;
          encryption_method?: string;
        };
      }
    | undefined;

  const encryptionId = windows?.bitlocker?.encryption_id;
  if (!encryptionId) return;

  await confirmBitLockerEncryption({
    deviceId: opts.deviceId,
    encryptionId,
    recoveryPassword: windows?.bitlocker?.recovery_password ?? null,
  });
}

// ── 確認 ────────────────────────────────────────────────────────────────────

async function confirmBitLockerEncryption(opts: {
  deviceId: string;
  encryptionId: string;
  recoveryPassword: string | null;
}): Promise<boolean> {
  const latest = await db.query.mdmWindowsBitlocker.findFirst({
    where: and(
      eq(mdmWindowsBitlocker.deviceId, opts.deviceId),
      eq(mdmWindowsBitlocker.status, "pending"),
    ),
    orderBy: [desc(mdmWindowsBitlocker.createdAt)],
    columns: { id: true, encryptionId: true },
  });

  if (!latest || latest.encryptionId !== opts.encryptionId) {
    console.warn(
      `[BitLocker] 確認失敗: device=${opts.deviceId} 提交的 encryptionId=${opts.encryptionId} 不匹配最新 pending`,
    );
    return false;
  }

  const recoveryPasswordEnc = opts.recoveryPassword
    ? encryptSecret(opts.recoveryPassword)
    : null;

  await db
    .update(mdmWindowsBitlocker)
    .set({
      status: "confirmed",
      confirmedAt: new Date(),
      updatedAt: new Date(),
      recoveryPasswordEnc,
    })
    .where(eq(mdmWindowsBitlocker.id, latest.id));

  console.log(
    `[BitLocker] 加密已確認: device=${opts.deviceId} encryption=${opts.encryptionId} hasRecoveryKey=${!!opts.recoveryPassword}`,
  );

  // 清除 Registry 信箱
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.id, opts.deviceId),
    columns: { udid: true },
  });
  if (device?.udid) {
    const clearCmd = buildBitLockerClear();
    await enqueueWindowsCommand({
      deviceUdid: device.udid,
      commandType: "BitLockerClear",
      command: clearCmd[0],
    });
  }

  return true;
}

// ── 查詢 ────────────────────────────────────────────────────────────────────

export interface BitLockerRecoveryInfo {
  recoveryPassword: string | null;
  encryptionMethod: string | null;
  encryptionId: string;
  status: string;
  confirmedAt: string | null;
}

/**
 * IT 查詢設備 BitLocker Recovery Password。
 *
 * 優先取最新 **confirmed** 記錄（已加密完成、含 recovery key）；若無 confirmed
 * 但有 pending 記錄（正在加密中），回傳 pending 狀態（recoveryPassword=null）
 * 讓 caller 能區分「設備加密中」vs「完全無加密記錄」。
 *
 * - 完全無記錄 → null（caller 回 404）
 * - 有 pending 但尚無 confirmed → 回傳 status="pending"（caller 可顯示「加密中」）
 * - 有 confirmed → 回傳最新一筆 confirmed 的 recovery key
 */
export async function getBitLockerRecoveryKey(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<BitLockerRecoveryInfo | null> {
  const confirmed = await db.query.mdmWindowsBitlocker.findFirst({
    where: and(
      eq(mdmWindowsBitlocker.tenantId, opts.tenantId),
      eq(mdmWindowsBitlocker.deviceId, opts.deviceId),
      eq(mdmWindowsBitlocker.status, "confirmed"),
    ),
    orderBy: [desc(mdmWindowsBitlocker.createdAt)],
  });

  const row =
    confirmed ??
    (await db.query.mdmWindowsBitlocker.findFirst({
      where: and(
        eq(mdmWindowsBitlocker.tenantId, opts.tenantId),
        eq(mdmWindowsBitlocker.deviceId, opts.deviceId),
      ),
      orderBy: [desc(mdmWindowsBitlocker.createdAt)],
    }));

  if (!row) return null;

  return {
    recoveryPassword: row.recoveryPasswordEnc
      ? decryptSecret(row.recoveryPasswordEnc)
      : null,
    encryptionMethod: row.encryptionMethod,
    encryptionId: row.encryptionId,
    status: row.status,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}
