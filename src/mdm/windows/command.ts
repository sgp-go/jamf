/**
 * Windows MDM 命令通道處理（SyncML over HTTPS）
 *
 * 設備按 enrollment 配置的 Poll 參數定期 PUT SyncML 到 /api/mdm/win/manage/:deviceId，
 * 後端：
 *   1. 解析設備上報的 Status / Results / Alert
 *   2. 根據 cmdRef 找到對應的 mdm_commands，更新狀態
 *   3. 取下一筆 platform='windows' 的 queued 命令
 *   4. 構建回應 SyncML
 *
 * 為了讓 cmdRef 能正確對齊到 mdm_commands.command_uuid，
 * 每個 session 維護一個 inFlight 對映表，存進 mdm_devices.management_session_state。
 */

import {
  upsertMdmDevice,
  getMdmDeviceByWindowsId,
  updateMdmCommand,
  getNextQueuedWindowsCommand,
  queueWindowsCommand,
} from "../../db/sqlite.ts";
import type { MdmDeviceRow, SyncMLVerb } from "../types.ts";
import { parseSyncML, buildSyncML, type SyncMLCommand } from "./syncml.ts";
import { upsertWindowsApp } from "./db.ts";
import { parseInventoryData, isInventoryResult } from "./inventory.ts";

/** Session 持久狀態（存於 mdm_devices.management_session_state JSON） */
interface SessionState {
  /** 上次 session ID */
  lastSessionId?: string;
  /** 上次伺服器發的 msgId */
  lastServerMsgId?: number;
  /** server CmdID → command_uuid（用於 status 對齊） */
  inFlight: Record<string, string>;
}

function parseSessionState(raw: string | null): SessionState {
  if (!raw) return { inFlight: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    return {
      lastSessionId: parsed.lastSessionId,
      lastServerMsgId: parsed.lastServerMsgId,
      inFlight: parsed.inFlight ?? {},
    };
  } catch {
    return { inFlight: {} };
  }
}

/**
 * 處理設備發來的 SyncML 訊息，回傳要送回設備的 SyncML
 *
 * @param deviceId - 從 URL path 取得的 Windows DeviceID
 * @param bodyXml - 設備發來的 SyncML XML 字串
 * @param managementUrl - 本端管理通道 URL（會作為回應 Source）
 */
export function handleSyncMLRequest(opts: {
  deviceId: string;
  bodyXml: string;
  managementUrl: string;
}): { status: number; body: string; contentType: string } {
  const { deviceId, bodyXml, managementUrl } = opts;

  // 找到 platform='windows' 且 windows_device_id 對應的裝置
  const device = getMdmDeviceByWindowsId(deviceId);
  if (!device || device.platform !== "windows") {
    return {
      status: 404,
      body: "device not enrolled",
      contentType: "text/plain",
    };
  }

  let parsed;
  try {
    parsed = parseSyncML(bodyXml);
  } catch (e) {
    console.error("[Win MDM] SyncML 解析失敗:", e);
    return { status: 400, body: "bad syncml", contentType: "text/plain" };
  }

  const state = parseSessionState(device.management_session_state);

  // 1. 處理 client status：根據 cmdRef 找到 inFlight 對應的 command_uuid
  for (const s of parsed.statuses) {
    if (s.cmd === "SyncHdr") continue; // 對 hdr 的 status 不入庫
    const commandUuid = state.inFlight[s.cmdRef];
    if (!commandUuid) continue; // 沒對到（可能是另一個 session 留下的，忽略）
    const dbStatus = mapStatusCode(s.data);
    updateMdmCommand(commandUuid, {
      status: dbStatus,
      responsePayload: JSON.stringify({ cmd: s.cmd, data: s.data }),
    });
    delete state.inFlight[s.cmdRef];
    console.log(
      `[Win MDM] 命令完成: ${commandUuid} cmd=${s.cmd} status=${dbStatus}`
    );
  }

  // 2. Alert 1201 = ClientInitiated（首次連線/輪詢觸發）— 僅紀錄
  for (const a of parsed.alerts) {
    if (a.data === "1201") {
      console.log(`[Win MDM] Device ${deviceId} 觸發 1201 (ClientInitiated)`);
    }
  }

  // 3. Results：應用清單等查詢結果
  for (const r of parsed.results) {
    if (!isInventoryResult(r.source)) continue;
    const entries = parseInventoryData(r.data);
    for (const e of entries) {
      upsertWindowsApp({
        deviceUdid: device.udid,
        packageFamilyName: e.packageFamilyName,
        displayName: e.displayName ?? null,
        version: e.version ?? null,
        installState: e.installState ?? null,
      });
    }
    console.log(
      `[Win MDM] Inventory: device=${deviceId} 收到 ${entries.length} 個應用`
    );
  }

  // 4. 取下一筆待執行命令（最多一次發 1 筆，避免複雜化 inFlight）
  const next = getNextQueuedWindowsCommand(device.udid);
  const commands: SyncMLCommand[] = [];
  if (next && next.csp_path && next.syncml_verb) {
    commands.push({
      cmdId: "0", // buildSyncML 會自動分配
      verb: next.syncml_verb as SyncMLVerb,
      target: next.csp_path,
      data: next.syncml_data ?? undefined,
      format: next.syncml_data ? "chr" : undefined,
    });
  }

  // 5. 回應 SyncML
  const sessionId = parsed.header.sessionId || "1";
  const newServerMsgId = (state.lastServerMsgId ?? 0) + 1;
  const responseXml = buildSyncML({
    sessionId,
    msgId: String(newServerMsgId),
    deviceId,
    managementUrl,
    hdrStatus: { msgRef: parsed.header.msgId, data: "200" },
    statuses: [], // 我們對 Alert/Status/Results 不單獨回 Status（mTLS 已認證，簡化）
    commands,
  });

  // 命令 cmdId 在 buildSyncML 內按順序分配：
  //   1 = SyncHdr Status
  //   2..N = statuses 各條
  //   後續為 commands
  // 由於我們 statuses=[]，commands 第 i 筆 cmdId = 2 + i
  if (next && commands.length > 0) {
    const cmdIdOfNext = String(2);
    state.inFlight[cmdIdOfNext] = next.command_uuid;
    updateMdmCommand(next.command_uuid, { status: "sent" });
    console.log(
      `[Win MDM] 發送命令: ${next.command_uuid} csp=${next.csp_path} verb=${next.syncml_verb}`
    );
  }

  // 持久化 session 狀態
  state.lastSessionId = sessionId;
  state.lastServerMsgId = newServerMsgId;
  upsertMdmDevice(device.udid, {
    managementSessionState: JSON.stringify(state),
  });

  return {
    status: 200,
    body: responseXml,
    contentType: "application/vnd.syncml.dm+xml; charset=utf-8",
  };
}

/** 映射 SyncML 狀態碼到 mdm_commands.status */
function mapStatusCode(code: string): string {
  const num = parseInt(code, 10);
  if (num >= 200 && num < 300) return "acknowledged";
  if (num === 0 || isNaN(num)) return "acknowledged";
  return "error";
}

/**
 * 排入 Windows 命令的高階封裝（接 csp.ts 產出的 SyncMLCommand）
 *
 * 回傳 command_uuid。
 */
export function enqueueWindowsCommand(opts: {
  deviceUdid: string;
  /** 命令類型標籤（如 "RemoteWipe"、"MsixInstall"），存到 command_type 供查詢 */
  commandType: string;
  command: SyncMLCommand;
}): string {
  const commandUuid = crypto.randomUUID();
  queueWindowsCommand(
    commandUuid,
    opts.deviceUdid,
    opts.commandType,
    opts.command.target,
    opts.command.verb,
    opts.command.data ?? null
  );
  console.log(
    `[Win MDM] 命令已排入: ${commandUuid} type=${opts.commandType} udid=${opts.deviceUdid}`
  );
  return commandUuid;
}

/** 將 MdmDeviceRow 投影為前端友好的格式（PR5/6 會用） */
export function projectWindowsDevice(d: MdmDeviceRow) {
  return {
    udid: d.udid,
    deviceId: d.windows_device_id,
    deviceName: d.device_name,
    model: d.model,
    osVersion: d.os_version,
    enrollmentStatus: d.enrollment_status,
    lastSeenAt: d.last_seen_at,
    wnsChannelUri: d.wns_channel_uri,
    wnsChannelExpiry: d.wns_channel_expiry,
    enrolledAt: d.enrolled_at,
  };
}
