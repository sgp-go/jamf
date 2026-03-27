/**
 * APNS 推播客戶端 - 喚醒裝置到 MDM 伺服器拉取命令
 *
 * Apple MDM 的推播是最小化的：只需發送 {"mdm": "<PushMagic>"} 到裝置的 push token。
 * 裝置收到推播後會主動 PUT 到 ServerURL 拉取命令。
 *
 * APNS 使用 HTTP/2 + 用戶端憑證 TLS 連線到 api.push.apple.com:443
 * 由於 Deno fetch 不直接支援用戶端憑證，這裡使用 curl 子進程發送推播。
 */

const APNS_PRODUCTION = "https://api.push.apple.com";
const APNS_SANDBOX = "https://api.sandbox.push.apple.com";

/** APNS 推播結果 */
export interface ApnsPushResult {
  success: boolean;
  statusCode?: number;
  reason?: string;
  apnsId?: string;
}

/**
 * 發送 MDM 推播通知到裝置
 *
 * @param pushToken 裝置的 APNS push token（hex 字串）
 * @param pushMagic 裝置的 PushMagic（TokenUpdate 中取得）
 * @param topic APNS topic（MDM push certificate 的 Subject UID）
 * @param certPath APNS 推播憑證路徑
 * @param keyPath APNS 推播金鑰路徑
 * @param sandbox 是否使用沙箱環境
 */
export async function sendMdmPush(opts: {
  pushToken: string;
  pushMagic: string;
  topic: string;
  certPath: string;
  keyPath: string;
  sandbox?: boolean;
}): Promise<ApnsPushResult> {
  const baseUrl = opts.sandbox ? APNS_SANDBOX : APNS_PRODUCTION;
  const url = `${baseUrl}/3/device/${opts.pushToken}`;

  const payload = JSON.stringify({ mdm: opts.pushMagic });

  try {
    // 使用 curl 支援 HTTP/2 + 用戶端憑證
    const cmd = new Deno.Command("curl", {
      args: [
        "--http2",
        "--cert", opts.certPath,
        "--key", opts.keyPath,
        "-X", "POST",
        "-H", `apns-topic: ${opts.topic}`,
        "-H", "apns-push-type: mdm",
        "-H", "apns-priority: 10",
        "-d", payload,
        "-w", "\n%{http_code}",
        "-s",
        url,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    if (!output.success) {
      console.error("[APNS] curl 執行失敗:", stderr);
      return { success: false, reason: stderr };
    }

    // curl -w 輸出的最後一行是 HTTP 狀態碼
    const lines = stdout.trim().split("\n");
    const statusCode = parseInt(lines[lines.length - 1], 10);
    const body = lines.slice(0, -1).join("\n");

    if (statusCode === 200) {
      console.log(`[APNS] 推播成功: token=${opts.pushToken.slice(0, 16)}...`);
      return { success: true, statusCode };
    }

    // 解析錯誤原因
    let reason = body;
    try {
      const parsed = JSON.parse(body);
      reason = parsed.reason ?? body;
    } catch {
      // body 可能不是 JSON
    }

    console.error(`[APNS] 推播失敗: status=${statusCode}, reason=${reason}`);
    return { success: false, statusCode, reason };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[APNS] 推播異常:", errMsg);
    return { success: false, reason: errMsg };
  }
}

/**
 * 便捷方法：使用已上傳的 APNS 憑證推播
 * 憑證路徑固定在 certs/apns_cert.pem 和 certs/apns_key.pem
 */
export async function pushToDevice(
  pushToken: string,
  pushMagic: string,
  topic: string
): Promise<ApnsPushResult> {
  const certPath = "certs/apns_cert.pem";
  const keyPath = "certs/apns_key.pem";

  // 檢查憑證檔案是否存在（透過 POST /api/mdm/certs/apns 上傳）
  try {
    Deno.statSync(certPath);
    Deno.statSync(keyPath);
  } catch {
    return {
      success: false,
      reason: "APNS 憑證尚未上傳，請先呼叫 POST /api/mdm/certs/apns",
    };
  }

  return sendMdmPush({
    pushToken,
    pushMagic,
    topic,
    certPath,
    keyPath,
  });
}
