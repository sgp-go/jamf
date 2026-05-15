import { db } from "~/db/client.ts";
import { jamfTokenCache } from "~/db/schema/jamf.ts";
import type { JamfInstance } from "~/db/schema/jamf.ts";
import { AppError, JamfUpstreamError } from "~/lib/errors.ts";
import { decryptSecret } from "~/lib/secrets.ts";

const TOKEN_SAFETY_WINDOW_MS = 60_000;

interface TokenGrantResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export class JamfClient {
  private cachedToken: { value: string; expiresAt: number } | null = null;

  private constructor(private readonly instance: JamfInstance) {}

  /**
   * 依 instanceId 從 DB 取憑據建立 client（含 token 持久化快取）。
   * tenantId 必填且強制比對：避免越權拿到別家 tenant 的 instance。
   */
  static async forInstance(opts: {
    tenantId: string;
    instanceId: string;
  }): Promise<JamfClient> {
    const row = await db.query.jamfInstances.findFirst({
      where: (t, { and, eq: eqOp }) =>
        and(eqOp(t.id, opts.instanceId), eqOp(t.tenantId, opts.tenantId)),
    });
    if (!row) {
      throw new AppError(404, "jamf_instance_not_found", "Jamf instance not found");
    }
    if (!row.isActive) {
      throw new AppError(409, "jamf_instance_inactive", "Jamf instance is inactive");
    }
    return new JamfClient(row);
  }

  get id(): string {
    return this.instance.id;
  }

  get baseUrl(): string {
    return this.instance.baseUrl;
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expiresAt - TOKEN_SAFETY_WINDOW_MS) {
      return this.cachedToken.value;
    }

    const cached = await db.query.jamfTokenCache.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.jamfInstanceId, this.instance.id),
    });
    if (cached && cached.expiresAt.getTime() - now > TOKEN_SAFETY_WINDOW_MS) {
      this.cachedToken = {
        value: cached.accessToken,
        expiresAt: cached.expiresAt.getTime(),
      };
      return cached.accessToken;
    }

    const token = await this.requestNewToken();
    this.cachedToken = token;

    await db
      .insert(jamfTokenCache)
      .values({
        jamfInstanceId: this.instance.id,
        accessToken: token.value,
        expiresAt: new Date(token.expiresAt),
      })
      .onConflictDoUpdate({
        target: jamfTokenCache.jamfInstanceId,
        set: {
          accessToken: token.value,
          expiresAt: new Date(token.expiresAt),
        },
      });

    return token.value;
  }

  private async requestNewToken(): Promise<{ value: string; expiresAt: number }> {
    const url = `${this.instance.baseUrl}/api/oauth/token`;
    const clientSecret = decryptSecret(this.instance.clientSecretEnc);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.instance.clientId,
        client_secret: clientSecret,
      }),
    });

    if (!resp.ok) {
      const body = await safeReadBody(resp);
      throw new JamfUpstreamError(resp.status, url, body);
    }

    const grant = (await resp.json()) as TokenGrantResponse;
    return {
      value: grant.access_token,
      expiresAt: Date.now() + grant.expires_in * 1000,
    };
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const url = `${this.instance.baseUrl}${path}`;

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const resp = await fetch(url, { ...init, headers });
    if (!resp.ok) {
      const body = await safeReadBody(resp);
      throw new JamfUpstreamError(resp.status, url, body);
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /** Classic API XML PUT（Configuration Profile scope、Static Group 增減成員等） */
  async putXml(path: string, xmlBody: string): Promise<string> {
    return this.requestXml("PUT", path, xmlBody);
  }

  /** Classic API XML POST（BlankPush 等 trigger 命令） */
  async postXml(path: string, xmlBody?: string): Promise<string> {
    return this.requestXml("POST", path, xmlBody);
  }

  private async requestXml(
    method: "PUT" | "POST",
    path: string,
    xmlBody?: string,
  ): Promise<string> {
    const token = await this.getToken();
    const url = `${this.instance.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/xml",
    };
    if (xmlBody !== undefined) headers["Content-Type"] = "text/xml; charset=utf-8";

    const resp = await fetch(url, {
      method,
      headers,
      body: xmlBody,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new JamfUpstreamError(resp.status, url, text);
    }
    return text;
  }
}

async function safeReadBody(resp: Response): Promise<unknown> {
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return await resp.json();
    } catch {
      return null;
    }
  }
  try {
    return await resp.text();
  } catch {
    return null;
  }
}
