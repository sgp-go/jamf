import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { profileAssignments } from "~/db/schema/profiles.ts";
import type { ProfileAssignment } from "~/db/schema/profiles.ts";
import { publishEvent } from "~/services/webhooks/publisher.ts";

/**
 * Profile push 命令 ack → 回寫 profile_assignment.status（W3 主軸 1 task 19）。
 *
 * 觸發來源：commands.ts updateMdmCommand 在 publishCommandEvent 之後呼叫此函數。
 * 識別模式：mdm_commands.command_type = `profile_apply:<profileId>`。
 *   acknowledged → assignment.status=applied, appliedVersion=profile.version, appliedAt
 *   error        → assignment.status=failed, errorMessage
 *   其餘狀態（queued/sent/...）保留 pending，不更新
 *
 * MVP 設計（W3 後段加嚴）：
 * - 反查 assignment 不依賴 lastCommandId（profile 多 csps 時只存第一條無法表達整體），
 *   改按 (profileId from commandType, deviceId) 找 device-scope assignment
 * - 多 csps 場景下「最後一條 ack 決定狀態」；但 failed 是終態，不被後續
 *   acknowledged 覆蓋（保留失敗信號便於台灣後端排查）
 * - scope=device_group 此時還未 fan-out 真派命令（push 引擎 MVP 只支 device），
 *   所以這裡查 device-scope 即可
 * - 嚴謹「所有 csps 都 ack 才標 applied」需建 profile_command_links 中間表，留後段
 *
 * fire-and-forget：reconcile 失敗只 log，不阻塞 OMA-DM session 主流程。
 */

const PROFILE_APPLY_PREFIX = "profile_apply:";

export interface ReconcileInput {
  tenantId: string;
  deviceId: string;
  commandType: string;
  status: string;
  errorChain?: unknown;
}

/**
 * 同步入口：commandType 非 profile_apply 直接返回；命中則 fire-and-forget 處理。
 */
export function reconcileProfileFromCommand(input: ReconcileInput): void {
  if (!input.commandType.startsWith(PROFILE_APPLY_PREFIX)) return;
  const profileId = input.commandType.slice(PROFILE_APPLY_PREFIX.length);
  if (!profileId) return;

  void runReconcile({ ...input, profileId }).catch((err) => {
    console.error(
      `[profile-ack] reconcile failed profile=${profileId} device=${input.deviceId}`,
      err,
    );
  });
}

async function runReconcile(
  input: ReconcileInput & { profileId: string },
): Promise<void> {
  // 反查此 (profile, device) 的 device-scope assignment
  const assignment = await db.query.profileAssignments.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(
        eqOp(t.tenantId, input.tenantId),
        eqOp(t.profileId, input.profileId),
        eqOp(t.deviceId, input.deviceId),
        eqOp(t.scope, "device"),
      ),
  });
  if (!assignment) return; // 沒對應 assignment（可能 unassign 後命令才 ack）

  // 終態保護：failed 不被後續 acknowledged 覆蓋
  if (assignment.status === "failed" && input.status === "acknowledged") return;

  const profile = await db.query.profiles.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, input.profileId), eqOp(t.tenantId, input.tenantId)),
    columns: { version: true },
  });
  const version = profile?.version ?? null;

  if (input.status === "acknowledged") {
    await db
      .update(profileAssignments)
      .set({
        status: "applied",
        appliedVersion: version,
        appliedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(profileAssignments.id, assignment.id));
    publishProfileEvent("profile.applied", input.tenantId, input.profileId, {
      ...assignment,
      appliedVersion: version,
    });
  } else if (input.status === "error") {
    const errorMessage = stringifyError(input.errorChain);
    await db
      .update(profileAssignments)
      .set({ status: "failed", errorMessage })
      .where(eq(profileAssignments.id, assignment.id));
    publishProfileEvent(
      "profile.failed",
      input.tenantId,
      input.profileId,
      { ...assignment, errorMessage },
    );
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

function publishProfileEvent(
  eventType: "profile.applied" | "profile.failed" | "profile.removed",
  tenantId: string,
  profileId: string,
  assignment: ProfileAssignment & { appliedVersion?: number | null; errorMessage?: string | null },
): void {
  void publishEvent({
    tenantId,
    eventType,
    data: {
      profile_id: profileId,
      assignment_id: assignment.id,
      device_id: assignment.deviceId,
      device_group_id: assignment.deviceGroupId,
      applied_version: assignment.appliedVersion ?? null,
      error_message: assignment.errorMessage ?? null,
    },
  }).catch((err) => {
    console.error(
      `[profile-ack] publishEvent failed event=${eventType} profile=${profileId}`,
      err,
    );
  });
}

// ============================================================
// unassign 場景：profile.removed
// ============================================================

/**
 * unassignProfile service 在 DELETE 成功後呼叫此函數推送 profile.removed 事件。
 * 不涉及 DB（assignment 已被 cascade 刪），純通知性事件。
 */
export function publishProfileRemoved(opts: {
  tenantId: string;
  profileId: string;
  assignmentId: string;
  deviceId: string | null;
  deviceGroupId: string | null;
}): void {
  void publishEvent({
    tenantId: opts.tenantId,
    eventType: "profile.removed",
    data: {
      profile_id: opts.profileId,
      assignment_id: opts.assignmentId,
      device_id: opts.deviceId,
      device_group_id: opts.deviceGroupId,
    },
  }).catch((err) => {
    console.error(
      `[profile-ack] publishEvent profile.removed failed profile=${opts.profileId}`,
      err,
    );
  });
}
