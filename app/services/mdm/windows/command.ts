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
 *
 * W2 Day 1 搬遷自 src/mdm/windows/command.ts：所有 DB 互動改 Drizzle ORM。
 * 行為應與 src/ 完全等價，但全部呼叫變 async（必須 await）。
 */

import {
  getMdmDevice,
  getMdmDeviceByWindowsId,
  upsertMdmDevice,
} from "~/services/mdm/devices.ts";
import {
  getNextQueuedWindowsCommand,
  listMdmCommands,
  queueWindowsCommand,
  updateMdmCommand,
} from "~/services/mdm/commands.ts";
import { isInternalCommandType } from "~/services/mdm/command-events.ts";
import { upsertWindowsApp } from "~/services/mdm/windows/windows-apps.ts";
import { parseSyncML, buildSyncML, type SyncMLCommand } from "./syncml.ts";
import {
  buildAppInventoryFetch,
  buildGetPushChannelUri,
  buildSetPushPfn,
} from "./csp.ts";
import { parseInventoryData, isInventoryResult } from "./inventory.ts";
import { getWnsClient, WnsAuthError } from "~/services/wns/client.ts";
import type { MdmDevice } from "~/db/schema/devices.ts";

type SyncMLVerb = "Add" | "Replace" | "Exec" | "Get" | "Delete";

/** Session 持久狀態（存於 mdm_devices.management_session_state jsonb） */
interface SessionState {
  /** 上次 session ID */
  lastSessionId?: string;
  /** 上次伺服器發的 msgId */
  lastServerMsgId?: number;
  /** server CmdID → command_uuid（用於 status 對齊） */
  inFlight: Record<string, string>;
}

function parseSessionState(raw: unknown): SessionState {
  if (raw === null || raw === undefined) return { inFlight: {} };

  // jsonb 在 Drizzle 端是 object；舊資料若 string（src/ SQLite 遷移時）也容錯
  let obj: Partial<SessionState> | null = null;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Partial<SessionState>;
    } catch {
      return { inFlight: {} };
    }
  } else if (typeof raw === "object") {
    obj = raw as Partial<SessionState>;
  } else {
    return { inFlight: {} };
  }

  return {
    lastSessionId: obj?.lastSessionId,
    lastServerMsgId: obj?.lastServerMsgId,
    inFlight: obj?.inFlight ?? {},
  };
}

/**
 * 處理設備發來的 SyncML 訊息，回傳要送回設備的 SyncML
 *
 * @param deviceId - 從 URL path 取得的 Windows DeviceID
 * @param bodyXml - 設備發來的 SyncML XML 字串
 * @param managementUrl - 本端管理通道 URL（會作為回應 Source）
 */
export async function handleSyncMLRequest(opts: {
  deviceId: string;
  bodyXml: string;
  managementUrl: string;
}): Promise<{ status: number; body: string; contentType: string }> {
  const { deviceId, bodyXml, managementUrl } = opts;

  // 找到 platform='windows' 且 windows_device_id 對應的裝置
  const device = await getMdmDeviceByWindowsId(deviceId);
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

  const state = parseSessionState(device.managementSessionState);

  // 0. session 切換偵測：sessionId 跟上次不同 → 先前 inFlight 對映已過期，先清空
  // （否則本輪 client status 可能誤命中舊 session 留下的 cmdId 對映）
  const sessionId = parsed.header.sessionId || "1";
  const isNewSession = sessionId !== state.lastSessionId;
  if (isNewSession && Object.keys(state.inFlight).length > 0) {
    console.log(
      `[Win MDM] Session 切換 ${state.lastSessionId} → ${sessionId}，清空 ${Object.keys(state.inFlight).length} 個過期 inFlight`,
    );
    state.inFlight = {};
  }

  // 1. 處理 client status：根據 cmdRef 找到 inFlight 對應的 command_uuid
  for (const s of parsed.statuses) {
    if (s.cmd === "SyncHdr") continue; // 對 hdr 的 status 不入庫
    const commandUuid = state.inFlight[s.cmdRef];
    if (!commandUuid) continue; // 沒對到（可能是另一個 session 留下的，忽略）
    const dbStatus = mapStatusCode(s.data);
    await updateMdmCommand(commandUuid, {
      status: dbStatus,
      responsePayload: { cmd: s.cmd, data: s.data },
    });
    delete state.inFlight[s.cmdRef];
    console.log(
      `[Win MDM] 命令完成: ${commandUuid} cmd=${s.cmd} status=${dbStatus} syncmlCode=${s.data}`,
    );
  }

  // 2. Alert 1201 = ClientInitiated（首次連線/輪詢觸發）— 僅紀錄
  for (const a of parsed.alerts) {
    if (a.data === "1201") {
      console.log(`[Win MDM] Device ${deviceId} 觸發 1201 (ClientInitiated)`);
    }
  }

  // 3. Results：應用清單 / push channel URI 等查詢結果
  for (const r of parsed.results) {
    if (isInventoryResult(r.source)) {
      const entries = parseInventoryData(r.data);
      for (const e of entries) {
        await upsertWindowsApp({
          deviceUdid: device.udid!,
          packageFamilyName: e.packageFamilyName,
          displayName: e.displayName ?? null,
          version: e.version ?? null,
          installState: e.installState ?? null,
        });
        // 自動 push 配置（時序後半段）：push MSIX 裝好（installState=0）且設備尚無
        // channel → 下發 push-config（Replace Push/PFN + Get ChannelURI）。
        // 卡點：PFN CSP 要求對應 MSIX 已裝，故必須等 inventory 確認裝好才能下發。
        const pushPfn = Deno.env.get("WNS_PFN");
        if (
          pushPfn && e.packageFamilyName === pushPfn &&
          e.installState === "0" && !device.wnsChannelUri
        ) {
          await enqueueWindowsCommand({
            deviceUdid: device.udid!,
            commandType: "PushSetPfn",
            command: buildSetPushPfn(pushPfn),
          });
          await enqueueWindowsCommand({
            deviceUdid: device.udid!,
            commandType: "PushGetChannelUri",
            command: buildGetPushChannelUri(),
          });
          console.log(
            `[Win MDM] push MSIX 已裝，自動配置 push channel udid=${device.udid}`,
          );
        }
      }
      console.log(
        `[Win MDM] Inventory: device=${deviceId} 收到 ${entries.length} 個應用`,
      );

      // 自愈：配 push 中但 push MSIX 還沒裝好 → 續一個 inventory fetch 驅動設備再上報，
      // 直到裝好觸發上面的 push-config。一進一出（每次上報續一個，設備執行後再上報），不堆積。
      const healPfn = Deno.env.get("WNS_PFN");
      if (healPfn && !device.wnsChannelUri) {
        const batchPush = entries.find((e) => e.packageFamilyName === healPfn);
        if (batchPush?.installState !== "0") {
          // 還沒裝好。確認設備確在配 push（有 push MSIX install 命令）才續，
          // 避免普通 inventory 查詢（無 push MSIX）被無限續 fetch。
          const cmds = await listMdmCommands(device.udid!, { limit: 30 });
          const configuringPush = cmds.some(
            (cmd) =>
              cmd.commandType === "MsixInstall" &&
              (cmd.cspPath ?? "").includes(healPfn),
          );
          if (configuringPush) {
            await enqueueWindowsCommand({
              deviceUdid: device.udid!,
              commandType: "AppInventoryFetch",
              command: buildAppInventoryFetch(),
            });
            console.log(
              `[Win MDM] push 配置中,push MSIX 未就緒,續 inventory fetch udid=${device.udid}`,
            );
          }
        }
      }
      continue;
    }
    // DMClient Push/ChannelURI Get 結果 → 入庫供 WNS push 使用
    if (/\/Push\/ChannelURI(\?|$)/i.test(r.source)) {
      const uri = r.data.trim();
      if (uri && /^https:\/\/[^.]+\.notify\.windows\.com\//i.test(uri)) {
        await upsertMdmDevice(device.udid!, { wnsChannelUri: uri });
        console.log(
          `[Win MDM] WNS ChannelURI 入庫: device=${deviceId} uri=${uri.slice(0, 60)}...`,
        );
      } else {
        console.warn(
          `[Win MDM] WNS ChannelURI 格式異常 (device=${deviceId}): ${uri.slice(0, 100)}`,
        );
      }
      continue;
    }
  }

  // 4. 取待執行命令（一次最多發 MAX_COMMANDS_PER_RESPONSE 條）
  const queuedCommands: { uuid: string; command: SyncMLCommand }[] = [];
  for (let i = 0; i < MAX_COMMANDS_PER_RESPONSE; i++) {
    const next = await getNextQueuedWindowsCommand(device.udid!);
    if (!next || !next.cspPath || !next.syncmlVerb) break;
    queuedCommands.push({
      uuid: next.commandUuid,
      command: {
        cmdId: "0", // buildSyncML 會分配真實值並透過回傳元數據告知
        verb: next.syncmlVerb as SyncMLVerb,
        target: next.cspPath,
        data: next.syncmlData ?? undefined,
        // 優先用 enqueue 時指定的 format（如 AppInventoryQuery 需 xml）
        // 沒指定則 fallback：有 data 預設 chr，無 data 不寫 format
        format:
          next.syncmlFormat ?? (next.syncmlData ? "chr" : undefined),
      },
    });
    // 立刻標 sent 並從 queue 移走（getNextQueuedWindowsCommand 只取 status='queued'）
    await updateMdmCommand(next.commandUuid, { status: "sent" });
  }

  // 5. 回應 SyncML
  // OMA-DM 1.2.1 §6.3：server MsgID per-session 遞增。
  // 當前架構是 1:1 request/response 配對，鏡像 device 的 MsgID 最穩健
  //（之前實作跨 session 累加 → device 收到突兀大 MsgID 對 SyncHdr 回 500）。
  const newServerMsgId = parseInt(parsed.header.msgId, 10) || 1;
  const built = buildSyncML({
    sessionId,
    msgId: String(newServerMsgId),
    deviceId,
    managementUrl,
    hdrStatus: { msgRef: parsed.header.msgId, data: "200" },
    statuses: [], // 對 Alert/Status/Results 不單獨回 Status（mTLS 已認證，簡化）
    commands: queuedCommands.map((q) => q.command),
  });

  // 用 buildSyncML 回傳的真實 CmdID 寫入 inFlight，避免推算耦合
  for (let i = 0; i < queuedCommands.length; i++) {
    const realCmdId = built.commandCmdIds[i];
    const q = queuedCommands[i];
    state.inFlight[realCmdId] = q.uuid;
    console.log(
      `[Win MDM] 發送命令: ${q.uuid} cmdId=${realCmdId} csp=${q.command.target} verb=${q.command.verb}`,
    );
  }

  // 持久化 session 狀態
  state.lastSessionId = sessionId;
  state.lastServerMsgId = newServerMsgId;
  await upsertMdmDevice(device.udid!, {
    managementSessionState: state as unknown as Record<string, unknown>,
  });

  return {
    status: 200,
    body: built.xml,
    contentType: "application/vnd.syncml.dm+xml; charset=utf-8",
  };
}

/** 單次 SyncML 回應最多攜帶的命令數（保守值；過多會撐爆 SyncML 訊息） */
const MAX_COMMANDS_PER_RESPONSE = 5;

/** 映射 SyncML 狀態碼到 mdm_commands.status */
function mapStatusCode(
  code: string,
): "acknowledged" | "error" {
  const num = parseInt(code, 10);
  if (num >= 200 && num < 300) return "acknowledged";
  if (num === 0 || isNaN(num)) return "acknowledged";
  return "error";
}

/**
 * 排入 Windows 命令的高階封裝（接 csp.ts 產出的 SyncMLCommand）
 *
 * 回傳 command_uuid。排隊成功後會 fire-and-forget 觸發 WNS push 通知 device 立刻
 * 發起 OMA-DM session（A 路徑秒級響應）。push 失敗不影響 enqueue 結果，
 * device 仍會按 polling 間隔（B 路徑兜底）拉到命令。
 */
export async function enqueueWindowsCommand(opts: {
  deviceUdid: string;
  /** 命令類型標籤（如 "RemoteWipe"、"MsixInstall"），存到 command_type 供查詢 */
  commandType: string;
  command: SyncMLCommand;
}): Promise<string> {
  const commandUuid = crypto.randomUUID();
  await queueWindowsCommand({
    commandUuid,
    deviceUdid: opts.deviceUdid,
    commandType: opts.commandType,
    cspPath: opts.command.target,
    syncmlVerb: opts.command.verb,
    syncmlData: opts.command.data ?? null,
    syncmlFormat: opts.command.format ?? null,
  });
  console.log(
    `[Win MDM] 命令已排入: ${commandUuid} type=${opts.commandType} udid=${opts.deviceUdid}`,
  );
  // Fire-and-forget WNS push（不 await，不 throw 影響 enqueue）
  // 排除自身：協議工具命令（PushSetPfn / PushGetChannelUri / PollConfig）不觸發 push，
  // 與 webhook 上報共用同一組「內部命令」定義（command-events.ts）
  if (!isInternalCommandType(opts.commandType)) {
    triggerWnsPush(opts.deviceUdid).catch((e) => {
      console.warn(
        `[Win MDM] WNS push 觸發失敗（不影響 enqueue）: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  return commandUuid;
}

/**
 * 異步嘗試 WNS push（fire-and-forget）
 *
 * 跳過條件：
 *   - device 無 wnsChannelUri（未跑過 push-config）
 *   - WNS 凭据未配（環境變數缺失）
 *
 * 副作用：
 *   - 410 channel expired → 清空 device.wnsChannelUri，提醒 caller 重跑 push-config
 */
export async function triggerWnsPush(deviceUdid: string): Promise<void> {
  const device = await getMdmDevice(deviceUdid);
  if (!device || !device.wnsChannelUri) return; // 沒 channel 就不發
  let client;
  try {
    client = getWnsClient();
  } catch (e) {
    if (e instanceof WnsAuthError) return; // 凭据未配，靜默跳過（B polling 兜底）
    throw e;
  }
  const result = await client.sendRaw(device.wnsChannelUri);
  if (result.channelExpired) {
    console.warn(
      `[Win MDM] WNS channel expired (410)，清空 device ${deviceUdid} 的 channel uri`,
    );
    await upsertMdmDevice(deviceUdid, { wnsChannelUri: null });
  } else if (result.throttled) {
    console.warn(
      `[Win MDM] WNS push 被限速放弃 (status=${result.status} retries=${result.retries ?? 0})：` +
        `device ${deviceUdid} 将靠 polling 兜底；批量场景建议设 WNS_PUSH_RATE_PER_SEC 从源头限流`,
    );
  } else if (!result.ok) {
    console.warn(
      `[Win MDM] WNS push 非 200: status=${result.status} wnsStatus=${result.wnsStatus ?? "?"}`,
    );
  } else {
    console.log(`[Win MDM] WNS push 已發 (${result.wnsStatus ?? "received"})`);
  }
}

/** 將 MdmDevice 投影為前端友好的格式（PR5/6 會用） */
export function projectWindowsDevice(d: MdmDevice) {
  return {
    udid: d.udid,
    deviceId: d.windowsDeviceId,
    deviceName: d.deviceName,
    model: d.model,
    osVersion: d.osVersion,
    enrollmentStatus: d.enrollmentStatus,
    lastSeenAt: d.lastSeenAt,
    wnsChannelUri: d.wnsChannelUri,
    wnsChannelExpiry: d.wnsChannelExpiry,
    enrolledAt: d.enrolledAt,
  };
}
