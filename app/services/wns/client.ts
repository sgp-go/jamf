/**
 * WNS (Windows Notification Service) 客戶端
 *
 * 用途：給 enrolled Windows 設備發 raw push notification 觸發 device 立刻發起 OMA-DM session。
 * 是「polling 兜底 + push 觸發秒級響應」雙層機制中的 push 一段。
 *
 * 流程：
 *   1. OAuth client_credentials 拿 access_token（cache 12h）
 *   2. POST 到 device 的 channelUri（device enrollment 時上報）+ X-WNS-Type: wns/raw + bearer
 *   3. 401 → 強制刷新 token retry 一次；410 → channel 失效返給 caller 處理
 *   4. 429/406（限速）→ 讀 Retry-After 指數退避重試（封頂 maxRetries / maxBackoffMs）
 *
 * 限速（W5 P0）：WNS 有 per-app 推送配額，1000 台批量喚醒必觸發限速。兩層防護：
 *   - sendRaw 內 429/406 退避重試（被動：撞限速後退避）
 *   - 可選令牌桶 rate limit（主動：限制出站 push/sec，從源頭不撞限速）
 *     fire-and-forget 並發 push 共用同一 client 單例 → 共用同一桶 → 天然節流，無需改 caller
 *
 * 參考：
 *   - https://learn.microsoft.com/en-us/previous-versions/windows/apps/hh465435(v=win.10)
 *   - https://learn.microsoft.com/en-us/previous-versions/windows/apps/hh868245(v=win.10)
 */

const TOKEN_ENDPOINT = "https://login.live.com/accesstoken.srf";
/** Token TTL 缓存：12h（实际 token 通常 24h 有效，留余量） */
const TOKEN_CACHE_MS = 12 * 60 * 60 * 1000;

/** WNS push 结果 */
export interface WnsSendResult {
  /** HTTP status code */
  status: number;
  /** 是否成功（200） */
  ok: boolean;
  /** channel URI 失效（410），caller 应重新让 device 注册 */
  channelExpired: boolean;
  /** 被 WNS 限速（HTTP 429 或 406）。重试耗尽后仍 true 表示放弃 */
  throttled: boolean;
  /** WNS 响应头中的 status / error 信息 */
  wnsStatus?: string;
  wnsError?: string;
  /** x-wns-notificationstatus（received / dropped / channelthrottled） */
  wnsNotificationStatus?: string;
  /** Retry-After 解析出的毫秒数（最后一次限速响应；缺则 undefined） */
  retryAfterMs?: number;
  /** 实际重试次数（0=一次成功；调试 / 压测指标用） */
  retries?: number;
  /** 失败时的 body（DEBUG 用） */
  body?: string;
}

/** 429/406 限速退避配置 */
export interface WnsThrottleConfig {
  /** 限速最多重试次数（默认 3） */
  maxRetries?: number;
  /** 退避基数 ms（默认 1000）；第 n 次退避 = base * 2^(n-1） */
  baseBackoffMs?: number;
  /** 单次退避上限 ms（默认 30000）；Retry-After 也封顶于此，避免病态阻塞 */
  maxBackoffMs?: number;
}

/** 令牌桶 rate limit 配置（主动限制出站 push 速率） */
export interface WnsRateLimitConfig {
  /** 每秒补充令牌数（push/sec 上限）。<=0 或省略 = 不限流 */
  ratePerSec?: number;
  /** 桶容量（突发上限）。默认 = ratePerSec（向上取整，至少 1） */
  burst?: number;
}

const DEFAULT_THROTTLE: Required<WnsThrottleConfig> = {
  maxRetries: 3,
  baseBackoffMs: 1000,
  maxBackoffMs: 30000,
};

/** 默认 sleep（可注入以便测试快速跑） */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 解析 Retry-After header → 毫秒。
 * 支持两种格式：delta-seconds（整数）或 HTTP-date。无法解析返 undefined。
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * 令牌桶限流器。acquire() 在令牌不足时 await 等待补充。
 * 单线程模型下 refill→decrement 在同一 tick 同步完成，多 waiter 不会重复消费同一令牌。
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;

  constructor(
    private readonly ratePerSec: number,
    capacity: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.capacity = Math.max(1, capacity);
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }

  async acquire(): Promise<void> {
    if (this.ratePerSec <= 0) return; // 不限流
    // 最多自旋若干次防极端情况死循环；正常 1-2 次即拿到
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000);
      await this.sleep(waitMs);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.ratePerSec,
    );
    this.lastRefillMs = now;
  }
}

/** 凭证缺失或 OAuth 失败时抛出 */
export class WnsAuthError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = "WnsAuthError";
  }
}

/** WnsClient 可选配置 */
export interface WnsClientOptions {
  /** 429/406 限速退避配置（省略走默认） */
  throttle?: WnsThrottleConfig;
  /** 令牌桶 rate limit（省略 = 不限流，保持原行为） */
  rateLimit?: WnsRateLimitConfig;
  /** sleep 实现（测试注入；默认 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
}

/** WNS 客户端 */
export class WnsClient {
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private readonly throttle: Required<WnsThrottleConfig>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bucket: TokenBucket;

  constructor(
    private readonly packageSid: string,
    private readonly clientSecret: string,
    opts: WnsClientOptions = {},
  ) {
    if (!packageSid || !clientSecret) {
      throw new WnsAuthError(
        "WnsClient: packageSid 和 clientSecret 必填。檢查 .env 中 WNS_PACKAGE_SID / WNS_CLIENT_SECRET"
      );
    }
    this.throttle = { ...DEFAULT_THROTTLE, ...opts.throttle };
    this.sleep = opts.sleep ?? realSleep;
    const ratePerSec = opts.rateLimit?.ratePerSec ?? 0;
    const burst = opts.rateLimit?.burst ?? Math.ceil(ratePerSec);
    this.bucket = new TokenBucket(ratePerSec, burst, this.sleep);
  }

  /**
   * 發送 raw push notification 到 device 的 ChannelURI
   *
   * @param channelUri device 上報的 https://*.notify.windows.com/... URL
   * @param body 任意 binary（<=5KB）。**必須非空** — 真機驗證空 body 會被 OS
   *             以 0x80070057 (E_INVALIDARG) 拒收（push body count=0 視為無效資料）。
   *             默認帶 4 字節 'mdm\n' 觸發 DMClient 即可。
   */
  async sendRaw(
    channelUri: string,
    body: Uint8Array = new TextEncoder().encode("mdm\n")
  ): Promise<WnsSendResult> {
    if (!/^https:\/\/[^.]+\.notify\.windows\.com\//i.test(channelUri)) {
      throw new Error(
        `sendRaw: invalid channelUri (must be https://*.notify.windows.com/...): ${channelUri}`
      );
    }
    let attempt = 0;
    for (;;) {
      // 主动限流：撞 WNS 配额前先在源头节流（rateLimit 未配则立即返回）
      await this.bucket.acquire();
      let token = await this.getToken();
      let res = await this.doSend(channelUri, body, token);
      // 401 → 强制刷新 token retry 一次
      if (res.status === 401) {
        this.cachedToken = null;
        token = await this.getToken();
        res = await this.doSend(channelUri, body, token);
      }
      // 429/406 → 被动退避重试
      if (res.throttled && attempt < this.throttle.maxRetries) {
        attempt++;
        const backoff = this.throttle.baseBackoffMs * 2 ** (attempt - 1);
        // Retry-After 优先；两者都封顶 maxBackoffMs 避免病态阻塞
        const waitMs = Math.min(
          res.retryAfterMs ?? backoff,
          this.throttle.maxBackoffMs,
        );
        await this.sleep(waitMs);
        continue;
      }
      res.retries = attempt;
      return res;
    }
  }

  /** 显式触发 token 刷新（测试 / 调试用） */
  async refreshToken(): Promise<string> {
    this.cachedToken = null;
    return await this.getToken();
  }

  // -- 内部 --

  private async getToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.token;
    }
    const formBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.packageSid,
      client_secret: this.clientSecret,
      scope: "notify.windows.com",
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new WnsAuthError(
        `WNS OAuth 失敗 (status=${res.status}): ${errText.slice(0, 300)}`,
        res.status
      );
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new WnsAuthError(
        "WNS OAuth 回應缺 access_token: " + JSON.stringify(json).slice(0, 300)
      );
    }
    this.cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + TOKEN_CACHE_MS,
    };
    return json.access_token;
  }

  private async doSend(
    channelUri: string,
    body: Uint8Array,
    token: string
  ): Promise<WnsSendResult> {
    const res = await fetch(channelUri, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-WNS-Type": "wns/raw",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
      },
      // Deno 嚴格 type 對 Uint8Array<ArrayBufferLike> 不直接接受成 BodyInit；
      // BufferSource 在 runtime 是 valid body，cast 安全
      body: body as unknown as BodyInit,
    });
    const wnsStatus = res.headers.get("x-wns-status") ?? undefined;
    const wnsError = res.headers.get("x-wns-error-description") ?? undefined;
    const wnsNotificationStatus =
      res.headers.get("x-wns-notificationstatus") ?? undefined;
    // WNS 限速：HTTP 429（现代）或 406 Not Acceptable（经典 per-app throttle）
    const throttled = res.status === 429 || res.status === 406;
    const result: WnsSendResult = {
      status: res.status,
      ok: res.status === 200,
      channelExpired: res.status === 410,
      throttled,
      wnsStatus,
      wnsError,
      wnsNotificationStatus,
      retryAfterMs: throttled
        ? parseRetryAfter(res.headers.get("retry-after"))
        : undefined,
    };
    if (!result.ok) {
      result.body = (await res.text().catch(() => "")).slice(0, 500);
    } else {
      // drain body
      await res.arrayBuffer().catch(() => {});
    }
    return result;
  }
}

/** 從環境變數初始化單例 client（依賴 .env load 已執行） */
let _instance: WnsClient | null = null;
export function getWnsClient(): WnsClient {
  if (_instance) return _instance;
  const sid = Deno.env.get("WNS_PACKAGE_SID");
  const secret = Deno.env.get("WNS_CLIENT_SECRET");
  if (!sid || !secret) {
    throw new WnsAuthError(
      "WNS_PACKAGE_SID 或 WNS_CLIENT_SECRET 未設置。push 不可用。"
    );
  }
  // 可选出站限流：WNS_PUSH_RATE_PER_SEC 设了才启用（默认不限流，保持原行为）。
  // 1000 台批量场景建议按 WNS 配额设（如 50），从源头避免撞限速。
  const ratePerSec = parseFloat(Deno.env.get("WNS_PUSH_RATE_PER_SEC") ?? "");
  const burstRaw = parseFloat(Deno.env.get("WNS_PUSH_BURST") ?? "");
  const rateLimit = Number.isFinite(ratePerSec) && ratePerSec > 0
    ? {
      ratePerSec,
      burst: Number.isFinite(burstRaw) && burstRaw > 0 ? burstRaw : undefined,
    }
    : undefined;
  _instance = new WnsClient(sid, secret, { rateLimit });
  return _instance;
}

/** 重置單例（測試用） */
export function _resetWnsClientForTesting() {
  _instance = null;
}
