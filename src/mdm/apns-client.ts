/**
 * APNS 長連線 HTTP/2 客戶端
 *
 * 採用 Deno.createHttpClient + fetch，底層自動 HTTP/2 + 長連線。
 * 需要啟動參數 --unstable-http。
 *
 * 單例設計：所有 push 共用同一個 HttpClient，享受 multiplexing。
 * 憑證更新時呼叫 reset() 關閉舊 client，下次 push 自動重建。
 */

const APNS_PRODUCTION = "https://api.push.apple.com";
const APNS_SANDBOX = "https://api.sandbox.push.apple.com";

const CERT_PATH = "certs/apns_cert.pem";
const KEY_PATH = "certs/apns_key.pem";

const MAX_CONCURRENT_PUSHES = 100;

export interface ApnsPushResult {
  success: boolean;
  statusCode?: number;
  reason?: string;
  apnsId?: string;
}

export interface ApnsPushOptions {
  pushToken: string;
  pushMagic: string;
  topic: string;
  sandbox?: boolean;
}

/** 最小 semaphore：限制同時進行的 push 數 */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

type HttpClient = ReturnType<typeof Deno.createHttpClient>;

class ApnsClient {
  private client: HttpClient | null = null;
  private readonly semaphore = new Semaphore(MAX_CONCURRENT_PUSHES);

  private ensureClient(): HttpClient {
    if (this.client) return this.client;

    let cert: string;
    let key: string;
    try {
      cert = Deno.readTextFileSync(CERT_PATH);
      key = Deno.readTextFileSync(KEY_PATH);
    } catch {
      throw new Error(
        "APNS 憑證尚未上傳，請先呼叫 POST /api/mdm/certs/apns"
      );
    }

    this.client = Deno.createHttpClient({ cert, key });
    console.log("[APNS] 新建 HttpClient（長連線）");
    return this.client;
  }

  /** 發送單筆 MDM 推播 */
  async push(opts: ApnsPushOptions): Promise<ApnsPushResult> {
    await this.semaphore.acquire();
    try {
      return await this.doPush(opts);
    } finally {
      this.semaphore.release();
    }
  }

  private async doPush(opts: ApnsPushOptions): Promise<ApnsPushResult> {
    const baseUrl = opts.sandbox ? APNS_SANDBOX : APNS_PRODUCTION;
    const url = `${baseUrl}/3/device/${opts.pushToken}`;
    const payload = JSON.stringify({ mdm: opts.pushMagic });

    let response: Response;
    try {
      const client = this.ensureClient();
      response = await fetch(url, {
        method: "POST",
        // @ts-ignore: Deno.createHttpClient option on fetch
        client,
        headers: {
          "apns-topic": opts.topic,
          "apns-push-type": "mdm",
          "apns-priority": "10",
        },
        body: payload,
      });
    } catch (e) {
      // 連線層錯誤：關舊 client，下次重建
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("[APNS] 連線錯誤，下次重建 client:", errMsg);
      this.reset();
      return { success: false, reason: errMsg };
    }

    const apnsId = response.headers.get("apns-id") ?? undefined;
    const statusCode = response.status;

    if (statusCode === 200) {
      await response.body?.cancel();
      return { success: true, statusCode, apnsId };
    }

    const bodyText = await response.text();
    let reason = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      reason = parsed.reason ?? bodyText;
    } catch {
      // body 可能不是 JSON
    }

    console.error(
      `[APNS] 推播失敗: status=${statusCode}, reason=${reason}, token=${opts.pushToken.slice(0, 16)}...`
    );
    return { success: false, statusCode, reason, apnsId };
  }

  /** 關閉目前連線（憑證更新後呼叫）— 下次 push 時會自動重建 */
  reset(): void {
    if (this.client) {
      try {
        this.client.close();
      } catch {
        // 已關閉
      }
      this.client = null;
      console.log("[APNS] HttpClient 已重置");
    }
  }

  /** 伺服器關閉時清理 */
  close(): void {
    this.reset();
  }
}

export const apnsClient = new ApnsClient();
