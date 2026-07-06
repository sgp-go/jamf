/**
 * MDM 命令 DB helper（Drizzle / PostgreSQL）
 *
 * 對應 src/db/sqlite.ts 中的 updateMdmCommand / getNextQueuedWindowsCommand /
 * queueWindowsCommand。W2 Day 1 OMA-DM 協議層搬遷時用。
 *
 * 關鍵差異 vs src/：
 * - src/ mdm_commands 用 `device_udid TEXT` FK to mdm_devices.udid
 * - app/ mdm_commands 用 `deviceId UUID` FK to mdm_devices.id
 *   每個 deviceUdid 參數都需先 lookup → deviceId（內部）
 * - app/ mdm_commands.tenantId NOT NULL：queueWindowsCommand 從 device row
 *   抽 tenantId 寫入
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  type MdmCommand,
  mdmCommands,
  mdmDevices,
} from "~/db/schema/devices.ts";
import { publishCommandEvent } from "./command-events.ts";
import { reconcileProfileFromCommand } from "~/services/profile-ack-reconciler.ts";
import { reconcileKioskFromCommand } from "~/services/kiosk-ack-reconciler.ts";

type SyncMLVerb = "Add" | "Replace" | "Exec" | "Get" | "Delete";

export interface QueueWindowsCommandInput {
  commandUuid: string;
  deviceUdid: string;
  commandType: string;
  cspPath: string;
  syncmlVerb: SyncMLVerb;
  syncmlData?: string | null;
  syncmlFormat?: string | null;
}

/**
 * 排入一筆 Windows 命令。需先 lookup deviceUdid → deviceId + tenantId。
 *
 * @returns 新建的 row id (UUID)
 * @throws Error 若 deviceUdid 找不到對應 device row
 */
export async function queueWindowsCommand(
  input: QueueWindowsCommandInput,
): Promise<string> {
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.udid, input.deviceUdid),
    columns: { id: true, tenantId: true },
  });
  if (!device) {
    throw new Error(
      `queueWindowsCommand: device udid=${input.deviceUdid} not found`,
    );
  }

  const [row] = await db
    .insert(mdmCommands)
    .values({
      tenantId: device.tenantId,
      deviceId: device.id,
      commandUuid: input.commandUuid,
      platform: "windows",
      commandType: input.commandType,
      status: "queued",
      requestPayload: {},
      cspPath: input.cspPath,
      syncmlVerb: input.syncmlVerb,
      syncmlData: input.syncmlData ?? null,
      syncmlFormat: input.syncmlFormat ?? null,
    })
    .returning({ id: mdmCommands.id });

  // 排隊成功 → 觸發 command.queued（內部工具命令會在 publishCommandEvent 內被過濾）
  publishCommandEvent({
    tenantId: device.tenantId,
    deviceId: device.id,
    commandUuid: input.commandUuid,
    commandType: input.commandType,
    status: "queued",
    platform: "windows",
    cspPath: input.cspPath,
  });

  return row.id;
}

/**
 * 批次排入多筆 Windows 命令（單一 transaction，原子性 all-or-nothing）。
 *
 * 用於策略推送等「一個業務操作對應 N 條 SyncML 命令」場景：任一條 insert 失敗
 * → 整批 rollback，設備不會收到部分政策（避免 minLength 套用了但 complexity
 * 沒套用這種設備被卡死的狀態）。
 *
 * @returns 新建的 row id (UUID) 列表，順序對應 input.commands 順序
 * @throws Error 若 deviceUdid 找不到對應 device row（事務不會啟動）
 */
export async function queueWindowsCommandsBatch(input: {
  deviceUdid: string;
  commands: Array<Omit<QueueWindowsCommandInput, "deviceUdid">>;
}): Promise<string[]> {
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.udid, input.deviceUdid),
    columns: { id: true, tenantId: true },
  });
  if (!device) {
    throw new Error(
      `queueWindowsCommandsBatch: device udid=${input.deviceUdid} not found`,
    );
  }

  const rows = await db.transaction(async (tx) => {
    return await tx
      .insert(mdmCommands)
      .values(
        input.commands.map((c) => ({
          tenantId: device.tenantId,
          deviceId: device.id,
          commandUuid: c.commandUuid,
          platform: "windows" as const,
          commandType: c.commandType,
          status: "queued" as const,
          requestPayload: {},
          cspPath: c.cspPath,
          syncmlVerb: c.syncmlVerb,
          syncmlData: c.syncmlData ?? null,
          syncmlFormat: c.syncmlFormat ?? null,
        })),
      )
      .returning({ id: mdmCommands.id });
  });

  // Transaction commit 後逐條發 command.queued 事件（與單筆版一致語義）
  for (const c of input.commands) {
    publishCommandEvent({
      tenantId: device.tenantId,
      deviceId: device.id,
      commandUuid: c.commandUuid,
      commandType: c.commandType,
      status: "queued",
      platform: "windows",
      cspPath: c.cspPath,
    });
  }

  return rows.map((r) => r.id);
}

/**
 * 拉設備下一筆 queued 的 Windows 命令（FIFO by queuedAt）。
 */
export async function getNextQueuedWindowsCommand(
  deviceUdid: string,
): Promise<MdmCommand | undefined> {
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.udid, deviceUdid),
    columns: { id: true },
  });
  if (!device) return undefined;

  return db.query.mdmCommands.findFirst({
    where: and(
      eq(mdmCommands.deviceId, device.id),
      eq(mdmCommands.platform, "windows"),
      eq(mdmCommands.status, "queued"),
    ),
    orderBy: asc(mdmCommands.queuedAt),
  });
}

/**
 * 以 commandUuid 取一筆命令。
 */
export async function getMdmCommand(
  commandUuid: string,
): Promise<MdmCommand | undefined> {
  return db.query.mdmCommands.findFirst({
    where: eq(mdmCommands.commandUuid, commandUuid),
  });
}

/**
 * 列設備命令歷史（by udid，最新優先）。含 udid → deviceId lookup。
 */
export async function listMdmCommands(
  deviceUdid: string,
  opts?: { limit?: number },
): Promise<MdmCommand[]> {
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.udid, deviceUdid),
    columns: { id: true },
  });
  if (!device) return [];

  // core query：避開 relational findMany 的 list 延遲（見 devices.ts 同類註解）
  return db
    .select()
    .from(mdmCommands)
    .where(eq(mdmCommands.deviceId, device.id))
    .orderBy(desc(mdmCommands.queuedAt))
    .limit(opts?.limit ?? 50);
}

export type MdmCommandStatus =
  | "queued"
  | "sent"
  | "acknowledged"
  | "error"
  | "not_now"
  | "idle"
  | "expired";

export interface UpdateMdmCommandFields {
  status: MdmCommandStatus;
  responsePayload?: string | Record<string, unknown> | null;
  errorChain?: string | unknown[] | null;
}

/**
 * 更新命令狀態。
 * - status='sent'：寫 sentAt
 * - 其他 status：寫 respondedAt + responsePayload + errorChain
 *
 * responsePayload / errorChain 接 string (JSON) 或 object，內部 parse 成 jsonb。
 */
export async function updateMdmCommand(
  commandUuid: string,
  fields: UpdateMdmCommandFields,
): Promise<void> {
  const now = new Date();
  const patch: Partial<typeof mdmCommands.$inferInsert> = { status: fields.status };

  if (fields.status === "sent") {
    patch.sentAt = now;
  } else {
    patch.respondedAt = now;
    if (fields.responsePayload !== undefined) {
      patch.responsePayload = parseJsonField(fields.responsePayload);
    }
    if (fields.errorChain !== undefined) {
      patch.errorChain = parseJsonArrayField(fields.errorChain);
    }
  }

  // returning 拿回觸發 webhook 所需欄位（零額外查詢）；status='sent' 與 ack/error
  // 都會走到這裡，故狀態流的 sent / completed / failed 事件統一在此觸發
  const [updated] = await db
    .update(mdmCommands)
    .set(patch)
    .where(eq(mdmCommands.commandUuid, commandUuid))
    .returning({
      tenantId: mdmCommands.tenantId,
      deviceId: mdmCommands.deviceId,
      commandUuid: mdmCommands.commandUuid,
      commandType: mdmCommands.commandType,
      status: mdmCommands.status,
      platform: mdmCommands.platform,
      cspPath: mdmCommands.cspPath,
      errorChain: mdmCommands.errorChain,
    });

  if (updated) {
    publishCommandEvent({
      tenantId: updated.tenantId,
      deviceId: updated.deviceId,
      commandUuid: updated.commandUuid,
      commandType: updated.commandType,
      status: updated.status,
      platform: updated.platform,
      cspPath: updated.cspPath,
    });
    // W3 主軸 1 task 19：profile_apply 命令 ack → 回寫 profile_assignment 狀態
    reconcileProfileFromCommand({
      tenantId: updated.tenantId,
      deviceId: updated.deviceId,
      commandType: updated.commandType,
      status: updated.status,
      errorChain: updated.errorChain,
    });
    // Kiosk：KioskApply ack → 回寫 kiosk_device_states.status + appliedVersion
    reconcileKioskFromCommand({
      tenantId: updated.tenantId,
      deviceId: updated.deviceId,
      commandUuid: updated.commandUuid,
      commandType: updated.commandType,
      status: updated.status,
      errorChain: updated.errorChain,
    });
  }
}

function parseJsonField(
  value: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return value;
}

function parseJsonArrayField(
  value: string | unknown[] | null,
): unknown[] | null {
  if (value === null) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return value;
}
