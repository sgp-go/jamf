/** Jamf Pro API 客戶端 - 封裝認證和請求 */

import "@std/dotenv/load";
import type { TokenResponse, JamfApiError } from "./types.ts";

export class JamfClient {
  private baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(opts?: {
    baseUrl?: string;
    clientId?: string;
    clientSecret?: string;
  }) {
    this.baseUrl = opts?.baseUrl ?? Deno.env.get("JAMF_BASE_URL") ?? "";
    this.clientId = opts?.clientId ?? Deno.env.get("JAMF_CLIENT_ID") ?? "";
    this.clientSecret =
      opts?.clientSecret ?? Deno.env.get("JAMF_CLIENT_SECRET") ?? "";

    if (!this.baseUrl || !this.clientId || !this.clientSecret) {
      throw new Error(
        "Missing JAMF_BASE_URL, JAMF_CLIENT_ID, or JAMF_CLIENT_SECRET"
      );
    }
  }

  /** 獲取有效的 Access Token，過期前自動重新整理 */
  private async getToken(): Promise<string> {
    // 提前 60 秒重新整理，避免邊界問題
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const resp = await fetch(`${this.baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!resp.ok) {
      throw new Error(
        `Token request failed: ${resp.status} ${resp.statusText}`
      );
    }

    const data: TokenResponse = await resp.json();
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }

  /** 發起經過認證的 API 請求 */
  async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = await this.getToken();
    const url = `${this.baseUrl}${path}`;

    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const resp = await fetch(url, { ...options, headers });

    if (!resp.ok) {
      let errorBody: JamfApiError | string;
      try {
        errorBody = await resp.json();
      } catch {
        errorBody = await resp.text();
      }
      throw new JamfRequestError(resp.status, url, errorBody);
    }

    // 204 No Content
    if (resp.status === 204) {
      return undefined as T;
    }

    return resp.json();
  }

  /** GET 請求 */
  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  /** POST 請求 */
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /** PUT 請求 */
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /** DELETE 請求 */
  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}

/** Jamf API 請求錯誤 */
export class JamfRequestError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: unknown
  ) {
    super(`Jamf API error ${status} on ${url}`);
    this.name = "JamfRequestError";
  }
}
