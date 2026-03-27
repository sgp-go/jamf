/** MDM 命令佇列 - 建構命令 plist、處理裝置回應 */

import { parsePlist, buildPlist } from "./plist.ts";
import {
  queueMdmCommand,
  getNextQueuedCommand,
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
  }

  return buildPlist({
    CommandUUID: commandUuid,
    Command: command,
  });
}
