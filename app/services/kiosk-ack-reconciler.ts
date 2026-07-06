import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  kioskDeviceStates,
  kioskProfiles,
  type KioskDeviceState,
} from "~/db/schema/kiosk.ts";
import { publishEvent } from "~/services/webhooks/publisher.ts";

/**
 * Kiosk 命令 ack → 回寫 kiosk_device_states.status + appliedVersion。
 *
 * 觸發來源：`app/services/mdm/commands.ts:updateMdmCommand` 在 publishCommandEvent
 * 之後呼叫此函數（與 [[profile-ack-reconciler]] 對稱）。
 *
 * **命中規則**：只處理 `commandType='KioskApply'`；反查方式 = `last_command_id`
 * （service 層 applyKioskToDevice 明確存 KioskApply 命令 UUID 到 state row）。
 * KioskRemove ack 不需 reconcile（remove API 已直接寫 `status='removed'`）。
 *
 * 語意：
 *   - acknowledged → status='active'，appliedVersion=kiosk_profiles.version，
 *                    發 `kiosk.applied` event
 *   - error        → status='failed'，errorDetail=stringify，發 `kiosk.failed` event
 *   - 其他狀態（queued/sent/idle 等）保留 pending，不更新
 *
 * 冪等：只對 status='pending' 的 row 觸發更新，避免重複 ack 覆蓋。
 * fire-and-forget：reconcile 失敗只 log，不阻塞 OMA-DM session 主流程。
 */

export interface KioskAckReconcileInput {
  tenantId: string;
  deviceId: string;
  commandUuid: string;
  commandType: string;
  status: string;
  errorChain?: unknown;
}

/**
 * 同步入口：非 KioskApply 直接返回；命中則 fire-and-forget 處理。
 */
export function reconcileKioskFromCommand(
  input: KioskAckReconcileInput,
): void {
  if (input.commandType !== "KioskApply") return;

  void runReconcile(input).catch((err) => {
    console.error(
      `[kiosk-ack] reconcile failed command=${input.commandUuid} device=${input.deviceId}`,
      err,
    );
  });
}

async function runReconcile(input: KioskAckReconcileInput): Promise<void> {
  // 反查此設備當前 kiosk state；若 last_command_id 不等於本次 ack 的 commandUuid，
  // 表示這個 ack 是舊 iteration 的（例如中間又派了新 apply），忽略。
  const state = await db.query.kioskDeviceStates.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(
        eqOp(t.deviceId, input.deviceId),
        eqOp(t.tenantId, input.tenantId),
      ),
  });
  if (!state) return;
  if (state.lastCommandId !== input.commandUuid) return;

  // 終態保護：failed 不被後續 acknowledged 覆蓋（保留失敗信號便於排查）
  if (state.status === "failed" && input.status === "acknowledged") return;
  // 已 active / removed 也不改（避免舊 pending ack 亂覆蓋）
  if (state.status !== "pending") return;

  if (input.status === "acknowledged") {
    const profile = state.profileId
      ? await db.query.kioskProfiles.findFirst({
        where: (t, { eq: eqOp }) => eqOp(t.id, state.profileId!),
        columns: { version: true },
      })
      : null;
    const version = profile?.version ?? null;

    await db
      .update(kioskDeviceStates)
      .set({
        status: "active",
        appliedVersion: version,
        errorDetail: null,
      })
      .where(eq(kioskDeviceStates.deviceId, state.deviceId));

    publishKioskEvent("kiosk.applied", input.tenantId, {
      ...state,
      status: "active",
      appliedVersion: version,
    });
  } else if (input.status === "error") {
    const errorDetail = stringifyError(input.errorChain);
    await db
      .update(kioskDeviceStates)
      .set({ status: "failed", errorDetail })
      .where(eq(kioskDeviceStates.deviceId, state.deviceId));

    publishKioskEvent("kiosk.failed", input.tenantId, {
      ...state,
      status: "failed",
      errorDetail,
    });
  }
}

function stringifyError(errorChain: unknown): string {
  if (errorChain == null) return "unknown error";
  if (typeof errorChain === "string") return errorChain;
  try {
    return JSON.stringify(errorChain);
  } catch {
    return String(errorChain);
  }
}

function publishKioskEvent(
  eventType: "kiosk.applied" | "kiosk.failed",
  tenantId: string,
  state: KioskDeviceState,
): void {
  void publishEvent({
    tenantId,
    eventType,
    data: {
      device_id: state.deviceId,
      profile_id: state.profileId,
      status: state.status,
      applied_version: state.appliedVersion ?? null,
      error_detail: state.errorDetail ?? null,
      last_command_id: state.lastCommandId ?? null,
    },
  }).catch((err) => {
    console.error(
      `[kiosk-ack] publishEvent failed event=${eventType} device=${state.deviceId}`,
      err,
    );
  });
}
