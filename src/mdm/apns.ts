/**
 * APNS 推播對外介面
 *
 * 薄封裝：委派至 apns-client.ts 的長連線單例。
 * 保留舊 sendMdmPush / pushToDevice 簽名以維持相容性。
 */

import { apnsClient, type ApnsPushResult } from "./apns-client.ts";

export type { ApnsPushResult };

/** 發送 MDM 推播通知到裝置（使用長連線單例） */
export function sendMdmPush(opts: {
  pushToken: string;
  pushMagic: string;
  topic: string;
  sandbox?: boolean;
}): Promise<ApnsPushResult> {
  return apnsClient.push(opts);
}

/**
 * 便捷方法：推播到指定裝置
 * 憑證路徑固定在 certs/apns_cert.pem 和 certs/apns_key.pem
 */
export function pushToDevice(
  pushToken: string,
  pushMagic: string,
  topic: string
): Promise<ApnsPushResult> {
  return apnsClient.push({ pushToken, pushMagic, topic });
}
