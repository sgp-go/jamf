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
  return row.id;
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

  await db
    .update(mdmCommands)
    .set(patch)
    .where(eq(mdmCommands.commandUuid, commandUuid));
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
