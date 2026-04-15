/**
 * DEP/ADE 協議客戶端
 *
 * Apple DEP API 使用 OAuth 1.0 認證，端點在 https://mdmenrollment.apple.com
 * 透過上傳的 .p7m Server Token 取得 OAuth 憑據後進行裝置同步、描述檔管理等操作
 */

import { createHmac } from "node:crypto";
import {
  getActiveDepToken,
  updateDepTokenInfo,
  upsertDepDevice,
} from "../db/sqlite.ts";
import type {
  DepAccountInfo,
  DepDevice,
  DepDeviceSyncResponse,
  DepProfile,
  DepProfileResponse,
  DepTokenRow,
} from "./types.ts";

const DEP_BASE_URL = "https://mdmenrollment.apple.com";

/** 快取的 session token */
let cachedSessionToken: string | null = null;

// ============================================================
// OAuth 1.0 簽章
// ============================================================

/** OAuth 1.0 簽章參數 */
interface OAuthParams {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
}

/** 生成 OAuth 1.0 Authorization header */
function buildOAuthHeader(
  method: string,
  url: string,
  oauth: OAuthParams
): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "");

  // OAuth 參數
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: oauth.consumerKey,
    oauth_token: oauth.accessToken,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_nonce: nonce,
    oauth_version: "1.0",
  };

  // 排序參數用於簽章
  const sortedParams = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeRFC3986(k)}=${encodeRFC3986(v)}`)
    .join("&");

  // 簽章基底字串
  const baseString = [
    method.toUpperCase(),
    encodeRFC3986(url),
    encodeRFC3986(sortedParams),
  ].join("&");

  // 簽章金鑰
  const signingKey = `${encodeRFC3986(oauth.consumerSecret)}&${encodeRFC3986(oauth.accessSecret)}`;

  // HMAC-SHA1 簽章
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  oauthParams.oauth_signature = signature;

  // 組裝 Authorization header
  const authHeader = Object.entries(oauthParams)
    .map(([k, v]) => `${k}="${encodeRFC3986(v)}"`)
    .join(", ");

  return `OAuth ${authHeader}`;
}

/** RFC 3986 編碼 */
function encodeRFC3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

// ============================================================
// DEP API 請求
// ============================================================

/** 從資料庫取得 OAuth 參數 */
function getOAuthFromToken(token: DepTokenRow): OAuthParams {
  return {
    consumerKey: token.consumer_key,
    consumerSecret: token.consumer_secret,
    accessToken: token.access_token,
    accessSecret: token.access_secret,
  };
}

/**
 * 取得 DEP API session token
 * Apple DEP API 需要先用 OAuth 1.0 呼叫 /session 端點取得 auth_session_token
 * 後續所有請求都用這個 session token
 */
async function getSessionToken(): Promise<string> {
  if (cachedSessionToken) return cachedSessionToken;

  const token = getActiveDepToken();
  if (!token) throw new Error("沒有啟用的 DEP Token");

  const url = `${DEP_BASE_URL}/session`;
  const oauth = getOAuthFromToken(token);
  const authHeader = buildOAuthHeader("GET", url, oauth);

  console.log("[DEP] 取得 session token...");
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeader,
    },
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`DEP session 取得失敗: ${resp.status} - ${errBody}`);
  }

  const data = await resp.json() as { auth_session_token: string };
  cachedSessionToken = data.auth_session_token;
  console.log("[DEP] Session token 取得成功");
  return cachedSessionToken;
}

/** 清除 session token（用於 401 時重試） */
function clearSessionToken() {
  cachedSessionToken = null;
}

/** DEP API 通用請求 */
async function depRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const sessionToken = await getSessionToken();

  const url = `${DEP_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "X-ADM-Auth-Session": sessionToken,
    "X-Server-Protocol-Version": "3",
    "Content-Type": "application/json;charset=UTF8",
    Accept: "application/json",
  };

  const options: RequestInit = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  console.log(`[DEP] ${method} ${path}`);
  let resp = await fetch(url, options);

  // session 過期，重新取得
  if (resp.status === 401) {
    console.log("[DEP] Session 過期，重新取得...");
    clearSessionToken();
    const newToken = await getSessionToken();
    headers["X-ADM-Auth-Session"] = newToken;
    resp = await fetch(url, { method, headers, body: options.body as string });
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error(`[DEP] 請求失敗: ${resp.status} ${errBody}`);
    throw new Error(`DEP API 錯誤: ${resp.status} - ${errBody}`);
  }

  if (resp.status === 204) {
    return undefined as T;
  }

  return (await resp.json()) as T;
}

// ============================================================
// DEP API 操作
// ============================================================

/** 取得帳戶資訊（驗證 token 是否有效） */
export async function getDepAccount(): Promise<DepAccountInfo> {
  return depRequest<DepAccountInfo>("GET", "/account");
}

/**
 * 首次同步裝置列表
 * 回傳分配給此 MDM 伺服器的所有裝置
 */
export async function fetchDepDevices(): Promise<DepDeviceSyncResponse> {
  return depRequest<DepDeviceSyncResponse>("POST", "/server/devices", {});
}

/**
 * 增量同步裝置
 * 使用上次同步的 cursor 取得變更
 */
export async function syncDepDevices(
  cursor?: string
): Promise<DepDeviceSyncResponse> {
  const body = cursor ? { cursor } : {};
  return depRequest<DepDeviceSyncResponse>("POST", "/devices/sync", body);
}

/**
 * 同步裝置到本地資料庫
 * 首次使用 fetchDepDevices，後續使用 syncDepDevices
 */
export async function syncDevicesToDb(): Promise<{
  synced: number;
  total: number;
}> {
  const token = getActiveDepToken();
  if (!token) throw new Error("沒有啟用的 DEP Token");

  let totalSynced = 0;
  let response: DepDeviceSyncResponse;

  // 嘗試增量同步，失敗則回退到全量同步
  try {
    if (!token.last_synced_at) {
      response = await fetchDepDevices();
    } else {
      response = await syncDepDevices();
    }
  } catch {
    console.log("[DEP] 增量同步失敗，回退到全量同步");
    response = await fetchDepDevices();
  }

  // 儲存裝置到資料庫
  for (const device of response.devices) {
    upsertDepDevice({
      serialNumber: device.serial_number,
      model: device.model,
      description: device.description,
      color: device.color,
      deviceFamily: device.device_family,
      os: device.os,
      profileUuid: device.profile_uuid,
      profileStatus: device.profile_status,
    });
    totalSynced++;
  }

  // 處理分頁
  while (response.more_to_follow) {
    response = await syncDepDevices(response.cursor);
    for (const device of response.devices) {
      upsertDepDevice({
        serialNumber: device.serial_number,
        model: device.model,
        description: device.description,
        color: device.color,
        deviceFamily: device.device_family,
        os: device.os,
        profileUuid: device.profile_uuid,
        profileStatus: device.profile_status,
      });
      totalSynced++;
    }
  }

  // 更新同步時間
  updateDepTokenInfo(token.id, {
    lastSyncedAt: new Date().toISOString(),
  });

  console.log(`[DEP] 同步完成: ${totalSynced} 台裝置`);
  return { synced: totalSynced, total: totalSynced };
}

/** 建立 ADE 描述檔 */
export async function createDepProfile(
  profile: DepProfile
): Promise<DepProfileResponse> {
  return depRequest<DepProfileResponse>("POST", "/profile", profile);
}

/** 分配描述檔給裝置 */
export async function assignDepProfile(
  profileUuid: string,
  serialNumbers: string[]
): Promise<DepProfileResponse> {
  return depRequest<DepProfileResponse>("PUT", "/profile/devices", {
    profile_uuid: profileUuid,
    devices: serialNumbers,
  });
}

/** 取消裝置的描述檔分配 */
export async function removeDepProfile(
  serialNumbers: string[]
): Promise<DepProfileResponse> {
  return depRequest<DepProfileResponse>("DELETE", "/profile/devices", {
    devices: serialNumbers,
  });
}

/** 查詢描述檔詳情 */
export async function getDepProfile(
  profileUuid: string
): Promise<DepProfile & { profile_uuid: string }> {
  return depRequest("GET", `/profile?profile_uuid=${profileUuid}`);
}

/** 批次查詢裝置詳情 */
export async function getDepDeviceDetails(
  serialNumbers: string[]
): Promise<{ devices: Record<string, DepDevice> }> {
  return depRequest("POST", "/devices", { devices: serialNumbers });
}
