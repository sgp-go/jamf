/** MDM Check-in 處理器 - 處理 Authenticate/TokenUpdate/CheckOut */

import { parsePlist, bufferToHex, bufferToBase64 } from "./plist.ts";
import { upsertMdmDevice } from "../db/sqlite.ts";
import type { CheckinMessage } from "./types.ts";

/** 處理 Check-in 請求，回傳 HTTP 狀態碼 */
export function handleCheckin(bodyXml: string): {
  status: number;
  message: string;
} {
  let msg: CheckinMessage;
  try {
    msg = parsePlist<CheckinMessage>(bodyXml);
  } catch (e) {
    console.error("Check-in plist 解析失敗:", e);
    return { status: 400, message: "無效的 plist 格式" };
  }

  if (!msg.MessageType || !msg.UDID) {
    return { status: 400, message: "缺少 MessageType 或 UDID" };
  }

  switch (msg.MessageType) {
    case "Authenticate":
      return handleAuthenticate(msg);
    case "TokenUpdate":
      return handleTokenUpdate(msg);
    case "CheckOut":
      return handleCheckOut(msg);
    default: {
      const unknown = msg as Record<string, unknown>;
      console.warn("未知的 Check-in MessageType:", unknown.MessageType);
      return { status: 400, message: `未知的 MessageType: ${unknown.MessageType}` };
    }
  }
}

/** 處理 Authenticate - 裝置首次簽入 */
function handleAuthenticate(msg: CheckinMessage): {
  status: number;
  message: string;
} {
  console.log(
    `[MDM] Authenticate: UDID=${msg.UDID}, Topic=${msg.Topic}`
  );

  const authMsg = msg as unknown as Record<string, unknown>;

  upsertMdmDevice(msg.UDID, {
    topic: msg.Topic,
    serialNumber: (authMsg.SerialNumber as string) ?? undefined,
    deviceName: (authMsg.DeviceName as string) ?? undefined,
    model: (authMsg.Model as string) ?? undefined,
    osVersion: (authMsg.OSVersion as string) ?? undefined,
    enrollmentStatus: "authenticated",
  });

  return { status: 200, message: "OK" };
}

/** 處理 TokenUpdate - 更新推播 token */
function handleTokenUpdate(msg: CheckinMessage): {
  status: number;
  message: string;
} {
  const tokenMsg = msg as unknown as Record<string, unknown>;

  // Token 是二進位資料，轉為 hex 字串用於 APNS 推播
  const pushToken = tokenMsg.Token
    ? bufferToHex(tokenMsg.Token as Uint8Array | string)
    : undefined;

  const pushMagic = tokenMsg.PushMagic as string | undefined;

  // UnlockToken 儲存為 base64
  const unlockToken = tokenMsg.UnlockToken
    ? bufferToBase64(tokenMsg.UnlockToken as Uint8Array | string)
    : undefined;

  console.log(
    `[MDM] TokenUpdate: UDID=${msg.UDID}, Token=${pushToken?.slice(0, 16)}...`
  );

  upsertMdmDevice(msg.UDID, {
    topic: msg.Topic,
    pushToken,
    pushMagic,
    unlockToken,
    enrollmentStatus: "enrolled",
  });

  return { status: 200, message: "OK" };
}

/** 處理 CheckOut - 裝置移除 MDM 描述檔 */
function handleCheckOut(msg: CheckinMessage): {
  status: number;
  message: string;
} {
  console.log(`[MDM] CheckOut: UDID=${msg.UDID}`);

  upsertMdmDevice(msg.UDID, {
    enrollmentStatus: "unenrolled",
  });

  return { status: 200, message: "OK" };
}
