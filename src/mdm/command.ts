/** MDM 命令佇列 - 建構命令 plist、處理裝置回應 */

import { parsePlist, buildPlist } from "./plist.ts";
import {
  queueMdmCommand,
  queueMdmCommandsBatch,
  getNextQueuedCommand,
  getMdmCommand,
  updateMdmCommand,
  upsertMdmDevice,
} from "../db/sqlite.ts";
import type { CommandRequest, MdmCommandType } from "./types.ts";

/**
 * 處理裝置發來的命令請求
 * 裝置 PUT 到 ServerURL，包含狀態和上一筆命令的回應
 * 回傳下一筆命令的 plist，或空 body（無命令）
 */
export function handleCommandRequest(bodyXml: string): {
  status: number;
  body: string;
  contentType: string;
} {
  let req: CommandRequest;
  try {
    req = parsePlist<CommandRequest>(bodyXml);
  } catch (e) {
    console.error("Command 請求 plist 解析失敗:", e);
    return {
      status: 400,
      body: "無效的 plist 格式",
      contentType: "text/plain",
    };
  }

  if (!req.UDID) {
    return { status: 400, body: "缺少 UDID", contentType: "text/plain" };
  }

  // 更新裝置最後連線時間
  upsertMdmDevice(req.UDID, {});

  // 處理上一筆命令的回應
  if (req.CommandUUID) {
    const statusMap: Record<string, string> = {
      Acknowledged: "acknowledged",
      Error: "error",
      CommandFormatError: "error",
      NotNow: "notnow",
    };
    const cmdStatus = statusMap[req.Status] ?? req.Status.toLowerCase();

    updateMdmCommand(req.CommandUUID, {
      status: cmdStatus,
      responsePayload: bodyXml,
      errorChain: req.ErrorChain ? JSON.stringify(req.ErrorChain) : undefined,
    });

    console.log(
      `[MDM] Command 回應: UUID=${req.CommandUUID}, Status=${req.Status}`
    );

    // Lost Mode 狀態簿記：ack 時同步本地 flag
    if (req.Status === "Acknowledged") {
      applyLostModeBookkeeping(req.UDID, req.CommandUUID);
    }
  }

  // 取得下一筆待執行命令
  const nextCmd = getNextQueuedCommand(req.UDID);

  if (!nextCmd) {
    // 無命令，回傳空 body 結束輪詢
    return { status: 200, body: "", contentType: "text/plain" };
  }

  // 標記為已發送
  updateMdmCommand(nextCmd.command_uuid, { status: "sent" });

  console.log(
    `[MDM] 發送命令: UUID=${nextCmd.command_uuid}, Type=${nextCmd.command_type}, UDID=${req.UDID}`
  );

  return {
    status: 200,
    body: nextCmd.request_payload,
    contentType: "application/xml",
  };
}

/**
 * 建立並排入 MDM 命令
 * 回傳 command UUID
 */
export function enqueueCommand(
  deviceUdid: string,
  commandType: MdmCommandType,
  params?: Record<string, unknown>
): string {
  const commandUuid = crypto.randomUUID();
  const payload = buildCommandPlist(commandUuid, commandType, params);

  queueMdmCommand(commandUuid, deviceUdid, commandType, payload);

  console.log(
    `[MDM] 命令已排入: UUID=${commandUuid}, Type=${commandType}, UDID=${deviceUdid}`
  );

  return commandUuid;
}

/**
 * 批次建立並排入 MDM 命令（單一 transaction）
 * 回傳 udid → commandUuid 的對應表
 */
export function enqueueCommandBatch(
  deviceUdids: string[],
  commandType: MdmCommandType,
  params?: Record<string, unknown>
): Record<string, string> {
  const result: Record<string, string> = {};
  const rows = deviceUdids.map((udid) => {
    const commandUuid = crypto.randomUUID();
    const payload = buildCommandPlist(commandUuid, commandType, params);
    result[udid] = commandUuid;
    return {
      commandUuid,
      deviceUdid: udid,
      commandType,
      requestPayload: payload,
    };
  });

  queueMdmCommandsBatch(rows);

  console.log(
    `[MDM] 批次命令已排入: Type=${commandType}, 裝置數=${deviceUdids.length}`
  );

  return result;
}

/** 建構 MDM 命令的 plist XML */
function buildCommandPlist(
  commandUuid: string,
  commandType: MdmCommandType,
  params?: Record<string, unknown>
): string {
  const command: Record<string, unknown> = {
    RequestType: commandType,
  };

  // 各命令的特定參數
  switch (commandType) {
    case "DeviceInformation":
      command.Queries = params?.Queries ?? [
        "DeviceName",
        "OSVersion",
        "BuildVersion",
        "ModelName",
        "Model",
        "ProductName",
        "SerialNumber",
        "UDID",
        "IMEI",
        "MEID",
        "BatteryLevel",
        "AvailableDeviceCapacity",
        "DeviceCapacity",
        "WiFiMAC",
        "BluetoothMAC",
        "IsSupervised",
      ];
      break;

    case "SecurityInfo":
      // 無額外參數
      break;

    case "InstalledApplicationList":
      if (params?.ManagedAppsOnly) {
        command.ManagedAppsOnly = true;
      }
      break;

    case "DeviceLock":
      if (params?.Message) command.Message = params.Message;
      if (params?.PhoneNumber) command.PhoneNumber = params.PhoneNumber;
      if (params?.PIN) command.PIN = params.PIN;
      break;

    case "EraseDevice":
      if (params?.PIN) command.PIN = params.PIN;
      if (params?.PreserveDataPlan !== undefined)
        command.PreserveDataPlan = params.PreserveDataPlan;
      break;

    case "ClearPasscode":
      // 需要 UnlockToken
      break;

    case "RestartDevice":
    case "ShutDownDevice":
      // 無額外參數
      break;

    case "InstallProfile":
      if (params?.Payload) command.Payload = params.Payload;
      break;

    case "RemoveProfile":
      if (params?.Identifier) command.Identifier = params.Identifier;
      break;

    case "ProfileList":
    case "CertificateList":
      // 無額外參數
      break;

    case "EnableLostMode": {
      // Apple MDM：需要 supervised 裝置，至少提供 Message/PhoneNumber/Footnote 其中之一
      const message = params?.Message as string | undefined;
      const phone = params?.PhoneNumber as string | undefined;
      const footnote = params?.Footnote as string | undefined;
      if (!message && !phone && !footnote) {
        throw new Error(
          "EnableLostMode 至少需要 Message、PhoneNumber、Footnote 其中之一"
        );
      }
      if (message) command.Message = message;
      if (phone) command.PhoneNumber = phone;
      if (footnote) command.Footnote = footnote;
      break;
    }

    case "DisableLostMode":
      // 無額外參數
      break;

    case "InstallApplication": {
      // 三種來源擇一：iTunesStoreID（App Store）、ManifestURL（in-house）、Identifier（已派送 App 的重新設定）
      const itunesId = params?.iTunesStoreID;
      const manifestUrl = params?.ManifestURL as string | undefined;
      const identifier = params?.Identifier as string | undefined;
      if (itunesId === undefined && !manifestUrl && !identifier) {
        throw new Error(
          "InstallApplication 需要 iTunesStoreID、ManifestURL 或 Identifier 其中之一"
        );
      }
      if (itunesId !== undefined) command.iTunesStoreID = itunesId;
      if (manifestUrl) command.ManifestURL = manifestUrl;
      if (identifier) command.Identifier = identifier;
      if (params?.ManagementFlags !== undefined)
        command.ManagementFlags = params.ManagementFlags;
      if (params?.ChangeManagementState)
        command.ChangeManagementState = params.ChangeManagementState;
      if (params?.Options) command.Options = params.Options;
      if (params?.Attributes) command.Attributes = params.Attributes;
      if (params?.Configuration) command.Configuration = params.Configuration;
      break;
    }

    case "RemoveApplication": {
      const identifier = params?.Identifier as string | undefined;
      if (!identifier) {
        throw new Error("RemoveApplication 需要 Identifier（Bundle ID）");
      }
      command.Identifier = identifier;
      break;
    }
  }

  return buildPlist({
    CommandUUID: commandUuid,
    Command: command,
  });
}

/**
 * Lost Mode ack 簿記：收到 EnableLostMode/DisableLostMode 的 Acknowledged 時，
 * 更新裝置 lost_mode_* 欄位
 */
function applyLostModeBookkeeping(udid: string, commandUuid: string): void {
  const cmd = getMdmCommand(commandUuid);
  if (!cmd) return;

  if (cmd.command_type === "EnableLostMode") {
    const params = extractCommandParams(cmd.request_payload);
    upsertMdmDevice(udid, {
      lostModeEnabled: true,
      lostModeMessage: (params.Message as string | undefined) ?? null,
      lostModePhone: (params.PhoneNumber as string | undefined) ?? null,
      lostModeFootnote: (params.Footnote as string | undefined) ?? null,
      lostModeEnabledAt: new Date().toISOString(),
    });
    console.log(`[MDM] Lost Mode 已啟用: UDID=${udid}`);
  } else if (cmd.command_type === "DisableLostMode") {
    upsertMdmDevice(udid, {
      lostModeEnabled: false,
      lostModeMessage: null,
      lostModePhone: null,
      lostModeFootnote: null,
      lostModeEnabledAt: null,
    });
    console.log(`[MDM] Lost Mode 已停用: UDID=${udid}`);
  }
}

/** 從入隊時的 plist payload 解回 Command 內的參數 */
function extractCommandParams(requestPayload: string): Record<string, unknown> {
  try {
    const parsed = parsePlist<{ Command?: Record<string, unknown> }>(
      requestPayload
    );
    const cmdObj = parsed.Command ?? {};
    const copy = { ...cmdObj };
    delete copy.RequestType;
    return copy;
  } catch {
    return {};
  }
}
