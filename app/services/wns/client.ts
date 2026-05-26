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
  /** WNS 响应头中的 status / error 信息 */
  wnsStatus?: string;
  wnsError?: string;
  /** 失败时的 body（DEBUG 用） */
  body?: string;
}

/** 凭证缺失或 OAuth 失败时抛出 */
export class WnsAuthError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = "WnsAuthError";
  }
}

/** WNS 客户端 */
export class WnsClient {
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly packageSid: string,
    private readonly clientSecret: string
  ) {
    if (!packageSid || !clientSecret) {
      throw new WnsAuthError(
        "WnsClient: packageSid 和 clientSecret 必填。檢查 .env 中 WNS_PACKAGE_SID / WNS_CLIENT_SECRET"
      );
    }
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
    let token = await this.getToken();
    let res = await this.doSend(channelUri, body, token);
    // 401 → 强制刷新 token retry 一次
    if (res.status === 401) {
      this.cachedToken = null;
      token = await this.getToken();
      res = await this.doSend(channelUri, body, token);
    }
    return res;
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
    const result: WnsSendResult = {
      status: res.status,
      ok: res.status === 200,
      channelExpired: res.status === 410,
      wnsStatus,
      wnsError,
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
  _instance = new WnsClient(sid, secret);
  return _instance;
}

/** 重置單例（測試用） */
export function _resetWnsClientForTesting() {
  _instance = null;
}
