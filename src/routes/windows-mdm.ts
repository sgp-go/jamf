/** Windows MDM 路由 - MS-MDE2 SOAP 端點 + SyncML 管理通道 + 管理 API */

import { Hono } from "@hono/hono";
import {
  parseDiscoverRequest,
  buildDiscoverResponse,
  DISCOVERY_GET_OK_BODY,
} from "../mdm/windows/discovery.ts";
import {
  parsePolicyMessageId,
  buildPolicyResponse,
} from "../mdm/windows/policy.ts";
import {
  parseEnrollmentRequest,
  buildEnrollmentResponse,
} from "../mdm/windows/enrollment.ts";
import {
  handleSyncMLRequest,
  enqueueWindowsCommand,
  projectWindowsDevice,
} from "../mdm/windows/command.ts";
import {
  buildRemoteWipe,
  buildMsixInstall,
  buildMsixUpdate,
  buildUpdateScan,
  buildMsixUninstall,
  buildAppInventoryConfig,
  buildAppInventoryFetch,
  type WipeAction,
  type MsixInstallParams,
} from "../mdm/windows/csp.ts";
import {
  upsertMdmDevice,
  listMdmDevicesByPlatform,
  getMdmDevice,
  getMdmDeviceByWindowsId,
  listMdmCommands,
  getDb,
} from "../db/sqlite.ts";
import { listWindowsAppsByDevice } from "../mdm/windows/db.ts";

const w = new Hono();

const SOAP_CONTENT_TYPE_BASE = "application/soap+xml; charset=utf-8";
// SOAP 1.2 要求響應 Content-Type 含 action 參數，否則 Win10 ENROLLClient 報
// ERROR_WINHTTP_HEADER_NOT_FOUND (0x80192F76)，GUI 顯示「無法自動發現」。
const SOAP_DISCOVER_RESP =
  `${SOAP_CONTENT_TYPE_BASE}; action="http://schemas.microsoft.com/windows/management/2012/01/enrollment/IDiscoveryService/DiscoverResponse"`;
const SOAP_POLICY_RESP =
  `${SOAP_CONTENT_TYPE_BASE}; action="http://schemas.microsoft.com/windows/pki/2009/01/enrollmentpolicy/IPolicy/GetPoliciesResponse"`;
const SOAP_ENROLLMENT_RESP =
  `${SOAP_CONTENT_TYPE_BASE}; action="http://schemas.microsoft.com/windows/pki/2009/01/enrollment/RSTRC/wstep"`;

// ============================================================
// MS-MDE2: Discovery.svc
// ============================================================

/** GET /EnrollmentServer/Discovery.svc — 部分客戶端探活 */
w.get("/EnrollmentServer/Discovery.svc", (c) => {
  return c.text(DISCOVERY_GET_OK_BODY, 200);
});

/** 對所有 SOAP 響應應用：阻止反向代理（ngrok / Cloudflare）對 body 做 gzip / chunked 變換。
 *  Win10 ENROLLClient 嚴格按 winhttp 解析；中間代理動了 body 會報 0x80192F76。 */
function setSoapHeaders(c: import("@hono/hono").Context, contentType: string, body: string) {
  const len = new TextEncoder().encode(body).length;
  c.header("Content-Type", contentType);
  c.header("Content-Length", String(len));
  c.header("Cache-Control", "no-transform, no-store");
  c.header("Content-Encoding", "identity");
}

/** POST /EnrollmentServer/Discovery.svc — Discover SOAP */
w.post("/EnrollmentServer/Discovery.svc", async (c) => {
  const xml = await c.req.text();
  const req = parseDiscoverRequest(xml);
  if (!req.messageId) {
    return c.text("missing MessageID", 400);
  }
  const baseUrl = getBaseUrl(c);
  const responseXml = buildDiscoverResponse({
    requestMessageId: req.messageId,
    baseUrl,
  });
  console.log(
    `[Win MDM] Discovery: email=${req.emailAddress ?? "?"} version=${
      req.requestVersion ?? "?"
    } baseUrl=${baseUrl} ua=${c.req.header("user-agent") ?? "?"}`
  );
  setSoapHeaders(c, SOAP_DISCOVER_RESP, responseXml);
  return c.body(responseXml, 200);
});

// ============================================================
// MS-MDE2: Policy.svc
// ============================================================

w.post("/EnrollmentServer/Policy.svc", async (c) => {
  const xml = await c.req.text();
  const messageId = parsePolicyMessageId(xml);
  if (!messageId) {
    return c.text("missing MessageID", 400);
  }
  const responseXml = buildPolicyResponse({ requestMessageId: messageId });
  console.log(`[Win MDM] Policy: msgId=${messageId}`);
  setSoapHeaders(c, SOAP_POLICY_RESP, responseXml);
  return c.body(responseXml, 200);
});

// ============================================================
// MS-MDE2: Enrollment.svc
// ============================================================

w.post("/EnrollmentServer/Enrollment.svc", async (c) => {
  const xml = await c.req.text();
  let parsed;
  try {
    parsed = parseEnrollmentRequest(xml);
  } catch (e) {
    console.error("[Win MDM] Enrollment 解析失敗:", e);
    return c.text(`bad RST: ${(e as Error).message}`, 400);
  }
  if (!parsed.messageId) {
    return c.text("missing MessageID", 400);
  }

  // 從 Context 取得 DeviceID（設備自報），缺失則生成 GUID
  const deviceId =
    parsed.context.DeviceID ||
    parsed.context["DeviceID"] ||
    crypto.randomUUID();
  const hardwareId = parsed.context.HWDevID ?? null;

  const baseUrl = getBaseUrl(c);
  const managementUrl = `${baseUrl}/api/mdm/win/manage/${encodeURIComponent(
    deviceId
  )}`;
  // PFN CSP 要求對應 MSIX app 已安裝在設備上，否則 enrollment 應用 wap-provisioningdoc 時失敗
  // (parm-error PFN hresult=0x82AA0002)。MVP 階段先不寫 Push/PFN，走純輪詢；WNS 後續在管理通道補發。
  const wnsPfn: string | undefined = undefined;

  let result;
  try {
    result = buildEnrollmentResponse({
      requestMessageId: parsed.messageId,
      deviceId,
      managementUrl,
      csrPem: parsed.csrPem,
      wnsPfn,
    });
  } catch (e) {
    console.error("[Win MDM] CSR 簽發失敗:", e);
    return c.text(`signing failed: ${(e as Error).message}`, 500);
  }

  // 寫入裝置記錄 + 證書
  const udid = `windows-${deviceId}`;
  upsertMdmDevice(udid, {
    platform: "windows",
    windowsDeviceId: deviceId,
    windowsHardwareId: hardwareId,
    deviceName: parsed.context.DeviceName ?? null,
    osVersion: parsed.context.OSVersion ?? null,
    enrollmentStatus: "enrolled",
    enrollmentType: "ppkg",
  });

  getDb()
    .prepare(
      `INSERT INTO mdm_certificates (device_udid, certificate_pem, subject)
       VALUES (?, ?, ?)`
    )
    .run(udid, result.deviceCertPem, `CN=${deviceId}`);

  console.log(
    `[Win MDM] Enrolled: deviceId=${deviceId} udid=${udid} hwId=${
      hardwareId ?? "?"
    }`
  );

  setSoapHeaders(c, SOAP_ENROLLMENT_RESP, result.soapResponse);
  return c.body(result.soapResponse, 200);
});

// ============================================================
// SyncML 管理通道
// ============================================================

/** 設備走 mTLS 透過 POST/PUT 發送 SyncML 訊息（Microsoft DM Client 用 POST + query string） */
async function handleManagementChannel(
  c: import("@hono/hono").Context
): Promise<Response> {
  const deviceId = c.req.param("deviceId");
  const xml = await c.req.text();
  const baseUrl = getBaseUrl(c);
  const managementUrl = `${baseUrl}/api/mdm/win/manage/${encodeURIComponent(
    deviceId
  )}`;
  const result = handleSyncMLRequest({ deviceId, bodyXml: xml, managementUrl });
  c.header("Content-Type", result.contentType);
  return c.body(result.body, result.status as 200 | 400 | 404);
}
w.post("/api/mdm/win/manage/:deviceId", handleManagementChannel);
w.put("/api/mdm/win/manage/:deviceId", handleManagementChannel);

// ============================================================
// 管理 API（給操作員 / 前端）
// ============================================================

/** GET /api/mdm/win/devices — 列出 Windows 裝置 */
w.get("/api/mdm/win/devices", (c) => {
  const devices = listMdmDevicesByPlatform("windows").map(projectWindowsDevice);
  return c.json({ devices });
});

/** GET /api/mdm/win/devices/:udid — 裝置詳情 */
w.get("/api/mdm/win/devices/:udid", (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  return c.json({ device: projectWindowsDevice(device) });
});

/** GET /api/mdm/win/devices/:udid/commands — 命令歷史 */
w.get("/api/mdm/win/devices/:udid/commands", (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const limit = Number(c.req.query("limit") ?? 50);
  const commands = listMdmCommands(udid, { limit });
  return c.json({ commands });
});

/** GET /api/mdm/win/devices/:udid/apps — 從 mdm_windows_apps 讀已知清單 */
w.get("/api/mdm/win/devices/:udid/apps", (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const apps = listWindowsAppsByDevice(udid);
  return c.json({ apps });
});

/** POST /api/mdm/win/devices/:udid/apps/refresh — 排入 inventory 查詢（兩段式） */
w.post("/api/mdm/win/devices/:udid/apps/refresh", (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  // EnterpriseModernAppManagement CSP spec：必須先 Replace AppInventoryQuery 設條件
  // 再 Get AppInventoryResults。MAX_COMMANDS_PER_RESPONSE>=2 保證同一輪 SyncML 同時下發。
  const configUuid = enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "AppInventoryConfig",
    command: buildAppInventoryConfig(),
  });
  const fetchUuid = enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "AppInventoryFetch",
    command: buildAppInventoryFetch(),
  });
  return c.json({
    configUuid,
    fetchUuid,
    note:
      "Inventory query queued (Replace+Get). Device will report apps on next poll (1-60 min).",
  });
});

/**
 * 從 JSON body 解析 MSIX install/update 共用參數，做欄位驗證。
 * 回傳 [params, errorResponse]，errorResponse 為 null 表通過。
 */
async function parseMsixParams(
  c: { req: { json: () => Promise<unknown> } }
): Promise<[MsixInstallParams | null, { json: object; status: 400 } | null]> {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return [null, { json: { error: "invalid json body" }, status: 400 }];
  }
  const packageFamilyName = body.packageFamilyName as string | undefined;
  const contentUri = body.contentUri as string | undefined;
  const hashHex = body.hashHex as string | undefined;
  if (!packageFamilyName || !contentUri || !hashHex) {
    return [
      null,
      {
        json: { error: "packageFamilyName, contentUri, hashHex required" },
        status: 400,
      },
    ];
  }
  if (!/^https:\/\//i.test(contentUri)) {
    return [
      null,
      { json: { error: "contentUri must be HTTPS" }, status: 400 },
    ];
  }
  return [
    {
      packageFamilyName,
      contentUri,
      hashHex,
      isLOB: body.isLOB as boolean | undefined,
      forceApplicationShutdown: body.forceApplicationShutdown as
        | boolean
        | undefined,
      forceUpdateToAnyVersion: body.forceUpdateToAnyVersion as
        | boolean
        | undefined,
      deferRegistration: body.deferRegistration as boolean | undefined,
    },
    null,
  ];
}

/** POST /api/mdm/win/devices/:udid/apps/install — 派送 MSIX (HostedInstall) */
w.post("/api/mdm/win/devices/:udid/apps/install", async (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const [params, err] = await parseMsixParams(c);
  if (err) return c.json(err.json, err.status);
  const commandUuid = enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "MsixInstall",
    command: buildMsixInstall(params!),
  });
  return c.json({
    commandUuid,
    packageFamilyName: params!.packageFamilyName,
    note:
      "Install queued. Device will pick up on next poll (1-60 min) or via WNS push.",
  });
});

/**
 * POST /api/mdm/win/devices/:udid/apps/update — 升級 MSIX（覆蓋安裝 + ForceUpdateToAnyVersion）
 * 入參同 install；自動帶 forceUpdateToAnyVersion=true。
 */
w.post("/api/mdm/win/devices/:udid/apps/update", async (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const [params, err] = await parseMsixParams(c);
  if (err) return c.json(err.json, err.status);
  const commandUuid = enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "MsixUpdate",
    command: buildMsixUpdate(params!),
  });
  return c.json({
    commandUuid,
    packageFamilyName: params!.packageFamilyName,
    note: "Update queued (ForceUpdateToAnyVersion=true).",
  });
});

/**
 * POST /api/mdm/win/devices/:udid/apps/update-scan — 觸發設備掃描所有可升級 MSIX
 * 不需指定 PFN；設備按已部署的 LOB 應用清單自動拉新版本。
 */
w.post("/api/mdm/win/devices/:udid/apps/update-scan", (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const commandUuid = enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "UpdateScan",
    command: buildUpdateScan(),
  });
  return c.json({ commandUuid, note: "UpdateScan queued." });
});

/**
 * POST /api/mdm/win/devices/install/bulk — 批量派送 MSIX 到多台設備
 * Body: { deviceUdids: string[], packageFamilyName, contentUri, hashHex, isLOB?, ...installOptions }
 * 對每台 enqueue 一條 MsixInstall，不存在的設備標 error 但不中斷整批。
 */
w.post("/api/mdm/win/devices/install/bulk", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  const udids = body.deviceUdids as string[] | undefined;
  if (!Array.isArray(udids) || udids.length === 0) {
    return c.json({ error: "deviceUdids (non-empty array) required" }, 400);
  }
  // 復用 parseMsixParams 對命令參數做相同驗證（透過構造一個 minimal req）
  const fakeC = { req: { json: () => Promise.resolve(body) } };
  const [params, err] = await parseMsixParams(fakeC);
  if (err) return c.json(err.json, err.status);

  const results: Array<{
    udid: string;
    commandUuid?: string;
    error?: string;
  }> = [];
  for (const udid of udids) {
    const device = getMdmDevice(udid);
    if (!device || device.platform !== "windows") {
      results.push({ udid, error: "device not found" });
      continue;
    }
    const commandUuid = enqueueWindowsCommand({
      deviceUdid: udid,
      commandType: "MsixInstall",
      command: buildMsixInstall(params!),
    });
    results.push({ udid, commandUuid });
  }
  const ok = results.filter((r) => r.commandUuid).length;
  return c.json({
    total: udids.length,
    queued: ok,
    failed: udids.length - ok,
    results,
  });
});

/** DELETE /api/mdm/win/devices/:udid/apps/:pfn — 卸載 MSIX */
w.delete("/api/mdm/win/devices/:udid/apps/:pfn", (c) => {
  const udid = c.req.param("udid");
  const pfn = c.req.param("pfn");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const cmd = buildMsixUninstall(pfn);
  const commandUuid = enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "MsixUninstall",
    command: cmd,
  });
  return c.json({ commandUuid, packageFamilyName: pfn });
});

/** POST /api/mdm/win/devices/:udid/wipe — 排入 RemoteWipe */
w.post("/api/mdm/win/devices/:udid/wipe", async (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  let action: WipeAction = "doWipe";
  try {
    const body = await c.req.json().catch(() => ({}));
    if (
      body.action === "doWipeProtected" ||
      body.action === "doWipePersistProvisionedData"
    ) {
      action = body.action;
    }
  } catch {
    // 無 body 時用預設
  }

  const cmd = buildRemoteWipe(action);
  const commandUuid = enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "RemoteWipe",
    command: cmd,
  });

  return c.json({
    commandUuid,
    action,
    note:
      "Command queued. Device will pick up on next poll (1-60 min) or via WNS push (if configured).",
  });
});

// ============================================================
// 工具：從 c.req 推導對外 baseUrl（尊重反向代理 / 隧道的 X-Forwarded-* 頭）
// ============================================================

function getBaseUrl(c: import("@hono/hono").Context): string {
  // ngrok / Cloudflare Tunnel / Nginx 等反向代理會解 TLS 後用 HTTP 轉給後端，
  // 必須讀 X-Forwarded-Proto / X-Forwarded-Host 才能還原對外 URL，
  // 否則 Discovery 回 http:// URL 被 Win10 ENROLLClient 拒絕（敏感端點必須 HTTPS）。
  const fwdProto = c.req.header("x-forwarded-proto");
  const fwdHost = c.req.header("x-forwarded-host");
  if (fwdProto && fwdHost) {
    return `${fwdProto}://${fwdHost}`;
  }
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host}`;
}

export default w;
