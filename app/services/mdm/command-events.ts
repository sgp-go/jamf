/**
 * mdm_commands 狀態變化 → Webhook 事件橋接。
 *
 * 設計：把「狀態 → 事件類型」的純映射（commandStatusToEvent）與「實際推送」
 * （publishCommandEvent）分離。純映射易單測、無副作用；推送 fire-and-forget，
 * webhook 失敗絕不影響 OMA-DM session 或命令排隊主流程。
 *
 * 掛鉤點集中在 commands.ts（queueWindowsCommand / updateMdmCommand），故所有
 * 走這兩個函式的狀態變化都會觸發對應事件，不需在每個呼叫端散落埋點。
 * install-agent.ts 直插 mdm_commands（事務原子性需求）為例外，自行補發 queued。
 */

import { publishEvent } from "~/services/webhooks/publisher.ts";
import type { WebhookEventType } from "~/services/webhooks/events.ts";
import type { MdmCommandStatus } from "./commands.ts";

/** 協議層內部工具命令類型：不對台灣後端上報（純噪音，非業務命令）。 */
const INTERNAL_COMMAND_TYPES = new Set<string>([
  "PushSetPfn",
  "PushGetChannelUri",
]);

/** 內部命令類型前綴（如 PollConfig / PollConfigReset 等輪詢配置命令）。 */
const INTERNAL_COMMAND_PREFIXES = ["PollConfig"];

/**
 * 判斷是否為協議層內部工具命令（WNS push 協商、Poll 配置等），這類命令不觸發
 * webhook，也不觸發 enqueue 時的 WNS push（見 enqueueWindowsCommand）。
 */
export function isInternalCommandType(commandType: string): boolean {
  if (INTERNAL_COMMAND_TYPES.has(commandType)) return true;
  return INTERNAL_COMMAND_PREFIXES.some((p) => commandType.startsWith(p));
}

/**
 * mdm_commands.status → webhook 事件類型。返回 null = 該狀態不上報。
 *
 * Windows OMA-DM 語義下 SyncML Status 200-299 即代表命令執行完成，故
 * acknowledged 映射為 command.completed（而非 command.acknowledged，該事件保留
 * 給未來 Apple MDM「已接收但仍執行中」的中間態）。not_now / idle / expired
 * 為非終態雜訊，暫不上報。
 */
export function commandStatusToEvent(
  status: MdmCommandStatus,
): WebhookEventType | null {
  switch (status) {
    case "queued":
      return "command.queued";
    case "sent":
      return "command.sent";
    case "acknowledged":
      return "command.completed";
    case "error":
      return "command.failed";
    default:
      return null;
  }
}

export interface CommandEventInput {
  tenantId: string;
  /** mdm_devices.id（內部 UUID），對齊 agent.* 事件的 device_id 慣例。 */
  deviceId: string;
  commandUuid: string;
  commandType: string;
  status: MdmCommandStatus;
  platform: "apple" | "windows";
  cspPath?: string | null;
}

/**
 * 依命令當前狀態 fire-and-forget 推送對應 webhook 事件。
 *
 * - 內部工具命令（isInternalCommandType）直接跳過
 * - 無對應事件的狀態（commandStatusToEvent → null）直接跳過
 * - publishEvent 失敗只記 log，不拋出（不阻塞呼叫端的命令排隊 / 狀態更新）
 */
/**
 * 可注入的 publisher（預設 publishEvent）；分離出來讓整合測試能斷言推送行為
 * （推送了什麼 payload、內部命令/非終態是否跳過、publisher reject 是否被吞）。
 */
export type CommandEventPublisher = (opts: {
  tenantId: string;
  eventType: WebhookEventType;
  data: Record<string, unknown>;
}) => Promise<unknown>;

export function publishCommandEvent(
  input: CommandEventInput,
  publish: CommandEventPublisher = publishEvent,
): void {
  if (isInternalCommandType(input.commandType)) return;
  const eventType = commandStatusToEvent(input.status);
  if (!eventType) return;

  void publish({
    tenantId: input.tenantId,
    eventType,
    data: {
      command_id: input.commandUuid,
      device_id: input.deviceId,
      command_type: input.commandType,
      status: input.status,
      platform: input.platform,
      csp_path: input.cspPath ?? null,
    },
  }).catch((err) => {
    console.error(
      `[command-event] publishEvent 失敗 command=${input.commandUuid} event=${eventType}`,
      err,
    );
  });
}
