/**
 * Windows MDM 路由 - MS-MDE2 SOAP 端點 + SyncML 管理通道 + 管理 API
 *
 * W2 Day 1 從 src/routes/windows-mdm.ts 搬遷，runtime 統一 Deno，所有 DB 互動
 * 改 Drizzle helper。enrollment 多租戶：device 綁定到 active self_mdm_config 的
 * tenantId + selfMdmConfigId，device cert 用 config 的 per-tenant CA 簽。
 *
 * 含跨前綴端點（/EnrollmentServer/* 與 /api/mdm/win/*），mount 在 app root。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import {
  buildDiscoverResponse,
  DISCOVERY_GET_OK_BODY,
  parseDiscoverRequest,
} from "~/services/mdm/windows/discovery.ts";
import {
  buildPolicyResponse,
  parsePolicyMessageId,
} from "~/services/mdm/windows/policy.ts";
import {
  buildEnrollmentResponse,
  parseEnrollmentRequest,
} from "~/services/mdm/windows/enrollment.ts";
import {
  enqueueWindowsCommand,
  handleSyncMLRequest,
  projectWindowsDevice,
} from "~/services/mdm/windows/command.ts";
import {
  buildAppInventoryConfig,
  buildAppInventoryFetch,
  buildGetPushChannelUri,
  buildLockAdmxInstall,
  buildMsixInstall,
  buildMsixInstallAddNode,
  buildMsixUninstall,
  buildMsixUpdate,
  buildReboot,
  buildRemoteWipe,
  buildSetPollInterval,
  buildSetPushPfn,
  buildUpdateScan,
  type MsixInstallParams,
  type PollConfig,
  type WipeAction,
} from "~/services/mdm/windows/csp.ts";
import { getWnsClient, WnsAuthError } from "~/services/wns/client.ts";
import {
  enrollWindowsDevice,
  getMdmDevice,
  insertDeviceCertificate,
  listMdmDevicesByPlatform,
} from "~/services/mdm/devices.ts";
import { listMdmCommands } from "~/services/mdm/commands.ts";
import { listWindowsAppsByDevice } from "~/services/mdm/windows/windows-apps.ts";
import {
  getActiveSelfMdmConfig,
  loadCaFromConfig,
} from "~/services/mdm/self-mdm-config.ts";

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
function setSoapHeaders(c: Context, contentType: string, body: string) {
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
    } baseUrl=${baseUrl} ua=${c.req.header("user-agent") ?? "?"}`,
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

  // 多租戶：取 active self_mdm_config 決定 tenant + per-tenant CA
  let config;
  try {
    config = await getActiveSelfMdmConfig();
  } catch (e) {
    console.error("[Win MDM] 無 active self_mdm_config:", e);
    return c.text("no active MDM config", 500);
  }
  const ca = loadCaFromConfig(config);

  // 從 Context 取得 DeviceID（設備自報），缺失則生成 GUID
  const deviceId = parsed.context.DeviceID ||
    parsed.context["DeviceID"] ||
    crypto.randomUUID();
  const hardwareId = parsed.context.HWDevID ?? null;

  const baseUrl = getBaseUrl(c);
  const managementUrl = `${baseUrl}/api/mdm/win/manage/${
    encodeURIComponent(deviceId)
  }`;
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
      ca,
    });
  } catch (e) {
    console.error("[Win MDM] CSR 簽發失敗:", e);
    return c.text(`signing failed: ${(e as Error).message}`, 500);
  }

  // 寫入裝置記錄（綁 tenant + self_mdm_config）+ 證書
  const udid = `windows-${deviceId}`;
  await enrollWindowsDevice({
    tenantId: config.tenantId,
    selfMdmConfigId: config.id,
    udid,
    windowsDeviceId: deviceId,
    windowsHardwareId: hardwareId,
    deviceName: parsed.context.DeviceName ?? null,
    osVersion: parsed.context.OSVersion ?? null,
  });

  await insertDeviceCertificate({
    selfMdmConfigId: config.id,
    deviceUdid: udid,
    certificatePem: result.deviceCertPem,
    subject: `CN=${deviceId}`,
  });

  console.log(
    `[Win MDM] Enrolled: deviceId=${deviceId} udid=${udid} tenant=${config.tenantId} hwId=${
      hardwareId ?? "?"
    }`,
  );

  setSoapHeaders(c, SOAP_ENROLLMENT_RESP, result.soapResponse);
  return c.body(result.soapResponse, 200);
});

// ============================================================
// SyncML 管理通道
// ============================================================

/** 設備走 mTLS 透過 POST/PUT 發送 SyncML 訊息（Microsoft DM Client 用 POST + query string） */
async function handleManagementChannel(c: Context): Promise<Response> {
  const deviceId = c.req.param("deviceId") ?? "";
  const xml = await c.req.text();
  const baseUrl = getBaseUrl(c);
  const managementUrl = `${baseUrl}/api/mdm/win/manage/${
    encodeURIComponent(deviceId)
  }`;
  const result = await handleSyncMLRequest({
    deviceId,
    bodyXml: xml,
    managementUrl,
  });
  c.header("Content-Type", result.contentType);
  return c.body(result.body, result.status as 200 | 400 | 404);
}
w.post("/api/mdm/win/manage/:deviceId", handleManagementChannel);
w.put("/api/mdm/win/manage/:deviceId", handleManagementChannel);

// ============================================================
// 管理 API（給操作員 / 前端）
// ============================================================

/** GET /api/mdm/win/devices — 列出 Windows 裝置 */
w.get("/api/mdm/win/devices", async (c) => {
  const devices = (await listMdmDevicesByPlatform("windows")).map(
    projectWindowsDevice,
  );
  return c.json({ devices });
});

/** GET /api/mdm/win/devices/:udid — 裝置詳情 */
w.get("/api/mdm/win/devices/:udid", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  return c.json({ device: projectWindowsDevice(device) });
});

/** GET /api/mdm/win/devices/:udid/commands — 命令歷史 */
w.get("/api/mdm/win/devices/:udid/commands", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const limit = Number(c.req.query("limit") ?? 50);
  const commands = await listMdmCommands(udid, { limit });
  return c.json({ commands });
});

/** GET /api/mdm/win/devices/:udid/apps — 從 mdm_windows_apps 讀已知清單 */
w.get("/api/mdm/win/devices/:udid/apps", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const apps = await listWindowsAppsByDevice(udid);
  return c.json({ apps });
});

/** POST /api/mdm/win/devices/:udid/apps/refresh — 排入 inventory 查詢（兩段式） */
w.post("/api/mdm/win/devices/:udid/apps/refresh", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  // EnterpriseModernAppManagement CSP spec：必須先 Replace AppInventoryQuery 設條件
  // 再 Get AppInventoryResults。MAX_COMMANDS_PER_RESPONSE>=2 保證同一輪 SyncML 同時下發。
  const configUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "AppInventoryConfig",
    command: buildAppInventoryConfig(),
  });
  const fetchUuid = await enqueueWindowsCommand({
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
  c: { req: { json: () => Promise<unknown> } },
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
  // hashHex 不再是必需（XSD 中沒有 Hash 欄位；HTTPS 信任 MSIX 自身簽名）
  // 但保留欄位入 params 給未來 UNC/SMB 場景用
  if (!packageFamilyName || !contentUri) {
    return [
      null,
      {
        json: { error: "packageFamilyName, contentUri required" },
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

/**
 * POST /api/mdm/win/devices/:udid/apps/install — 派送 MSIX (HostedInstall)
 *
 * Spec 要求兩段式：先 Add ./AppInstallation/{PFN} 節點，再 Exec HostedInstall。
 * 跳過 Add device 會回 404。MAX_COMMANDS_PER_RESPONSE>=2 保證同輪 SyncML 同時下發。
 */
w.post("/api/mdm/win/devices/:udid/apps/install", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const [params, err] = await parseMsixParams(c);
  if (err) return c.json(err.json, err.status);
  const addUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "MsixInstallAdd",
    command: buildMsixInstallAddNode(params!.packageFamilyName),
  });
  const execUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "MsixInstall",
    command: buildMsixInstall(params!),
  });
  return c.json({
    addUuid,
    execUuid,
    packageFamilyName: params!.packageFamilyName,
    note:
      "Install queued (Add+Exec). Device will pick up on next poll (1-60 min).",
  });
});

/**
 * POST /api/mdm/win/devices/:udid/apps/update — 升級 MSIX
 *
 * 真機驗證：install 完成後 HostedInstall sub-node 會被 device 清掉，
 * update 直接 Exec 會 404。必須重新 Add PFN 節點 → 再 Exec HostedInstall（含 ForceUpdate）。
 * 與 install 流程一致，差別只在 Exec 攜帶 ForceUpdateToAnyVersion 位。
 */
w.post("/api/mdm/win/devices/:udid/apps/update", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const [params, err] = await parseMsixParams(c);
  if (err) return c.json(err.json, err.status);
  const addUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "MsixUpdateAdd",
    command: buildMsixInstallAddNode(params!.packageFamilyName),
  });
  const execUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "MsixUpdate",
    command: buildMsixUpdate(params!),
  });
  return c.json({
    addUuid,
    execUuid,
    packageFamilyName: params!.packageFamilyName,
    note: "Update queued (Add+Exec ForceUpdateToAnyVersion).",
  });
});

/**
 * POST /api/mdm/win/devices/:udid/apps/update-scan — 觸發設備掃描所有可升級 MSIX
 * 不需指定 PFN；設備按已部署的 LOB 應用清單自動拉新版本。
 */
w.post("/api/mdm/win/devices/:udid/apps/update-scan", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const commandUuid = await enqueueWindowsCommand({
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
    addUuid?: string;
    execUuid?: string;
    error?: string;
  }> = [];
  for (const udid of udids) {
    const device = await getMdmDevice(udid);
    if (!device || device.platform !== "windows") {
      results.push({ udid, error: "device not found" });
      continue;
    }
    const addUuid = await enqueueWindowsCommand({
      deviceUdid: udid,
      commandType: "MsixInstallAdd",
      command: buildMsixInstallAddNode(params!.packageFamilyName),
    });
    const execUuid = await enqueueWindowsCommand({
      deviceUdid: udid,
      commandType: "MsixInstall",
      command: buildMsixInstall(params!),
    });
    results.push({ udid, addUuid, execUuid });
  }
  const ok = results.filter((r) => r.execUuid).length;
  return c.json({
    total: udids.length,
    queued: ok,
    failed: udids.length - ok,
    results,
  });
});

/** DELETE /api/mdm/win/devices/:udid/apps/:pfn — 卸載 MSIX */
w.delete("/api/mdm/win/devices/:udid/apps/:pfn", async (c) => {
  const udid = c.req.param("udid");
  const pfn = c.req.param("pfn");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const cmd = buildMsixUninstall(pfn);
  const commandUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "MsixUninstall",
    command: cmd,
  });
  return c.json({ commandUuid, packageFamilyName: pfn });
});

/**
 * POST /api/mdm/win/devices/:udid/poll-config — 設置 device 的 OMA-DM polling 間隔
 *
 * 默認 Win10 polling 間隔很長（前 8 次每 15 分鐘，之後每 8 小時），
 * 命令排隊後動輒等幾小時。發此 API 後 device 會在下次 poll 套用新間隔，
 * 之後所有命令在新間隔內到達。生產推薦 5/15 分鐘組合。
 *
 * Body: PollConfig（全為 optional，省略走推薦預設）
 */
w.post("/api/mdm/win/devices/:udid/poll-config", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  let config: PollConfig = {};
  try {
    config = (await c.req.json().catch(() => ({}))) as PollConfig;
  } catch {
    // 無 body 時用預設
  }
  const cmds = buildSetPollInterval(config);
  const uuids: string[] = [];
  for (let i = 0; i < cmds.length; i++) {
    uuids.push(
      await enqueueWindowsCommand({
        deviceUdid: udid,
        commandType: `PollConfig-${i}`,
        command: cmds[i],
      }),
    );
  }
  return c.json({
    commandUuids: uuids,
    config: {
      intervalFirst: config.intervalFirst ?? 5,
      countFirst: config.countFirst ?? 8,
      intervalRest: config.intervalRest ?? 15,
      countRest: config.countRest ?? 0,
      pollOnLogin: config.pollOnLogin ?? true,
    },
    note: "Poll config queued. Takes effect on next poll, then steady state.",
  });
});

/**
 * POST /api/mdm/win/devices/:udid/push-config — 設置 device 的 WNS push 接收 PFN
 *
 * 完整流程：
 *   1. server 排 Replace ./Push/PFN = <PFN> + Get ./Push/ChannelURI
 *   2. device poll 拉到後 DMClient 註冊 push channel 到 OS（前置：該 PFN 對應的
 *      push-capable MSIX 已裝在 device 上）
 *   3. device 在後續 SyncML Results 上報 ChannelURI，server 寫入 mdm_devices.wnsChannelUri
 *   4. 之後 enqueue 命令時 server 可調 WNS API 立刻 push 觸發 device session
 *
 * Body: { pfn?: string }（省略則用 .env WNS_PFN）
 */
w.post("/api/mdm/win/devices/:udid/push-config", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as { pfn?: string };
  const pfn = body.pfn ?? process.env.WNS_PFN;
  if (!pfn) {
    return c.json(
      { error: "pfn required (or set WNS_PFN in .env)" },
      400,
    );
  }
  const setPfnUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "PushSetPfn",
    command: buildSetPushPfn(pfn),
  });
  const getUriUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "PushGetChannelUri",
    command: buildGetPushChannelUri(),
  });
  return c.json({
    setPfnUuid,
    getUriUuid,
    pfn,
    note:
      "Push config queued (Replace PFN + Get ChannelURI). Device must have push-capable MSIX with matching PFN installed.",
  });
});

/**
 * POST /api/mdm/win/devices/:udid/push — 立即發 WNS raw push 給 device
 *
 * 前置：device 已透過 push-config 上報 ChannelURI；mdm_devices.wnsChannelUri 非空。
 * 觸發後 device 應在數秒內發起 OMA-DM session 拉取排隊中的命令（A 路徑秒級響應）。
 */
w.post("/api/mdm/win/devices/:udid/push", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  if (!device.wnsChannelUri) {
    return c.json(
      {
        error:
          "device 尚未上報 ChannelURI；先 POST /push-config 並等 device poll 後才能 push",
      },
      409,
    );
  }
  try {
    const wns = getWnsClient();
    const result = await wns.sendRaw(device.wnsChannelUri);
    return c.json({
      ok: result.ok,
      status: result.status,
      wnsStatus: result.wnsStatus,
      wnsError: result.wnsError,
      channelExpired: result.channelExpired,
    });
  } catch (e) {
    if (e instanceof WnsAuthError) {
      return c.json({ error: "WNS auth: " + e.message }, 502);
    }
    throw e;
  }
});

/**
 * POST /api/mdm/win/devices/:udid/provision-lock-policy — 補發遠端鎖定的 ADMX ingest
 *
 * 遠端鎖定走 ADMX-backed Policy CSP（Registry CSP 桌面死路，見 csp.ts buildLockAdmxInstall）。
 * 新設備由 install-agent 流程自動注入此 ADMX；本端點供對「存量設備」（install-agent 之前
 * 無 ADMXInstall）一次性補 ingest，使其具備 lock 投遞能力。
 *
 * 重複對已 ingest 的設備調用：設備回 418 Already exists（命令標 error），無害——策略已就緒。
 */
w.post("/api/mdm/win/devices/:udid/provision-lock-policy", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }
  const commandUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "policy_admx_install",
    command: buildLockAdmxInstall(),
  });
  return c.json({
    commandUuid,
    note:
      "Lock ADMX ingest queued. 已 ingest 的設備會回 418（已就緒，無害）。",
  });
});

/**
 * POST /api/mdm/win/devices/provision-lock-policy/bulk — 批量補發遠端鎖定 ADMX ingest
 *
 * 供「存量設備」批量補 ingest 鎖定策略（單台版見上方端點）。8000 台鋪開時用。
 * Body 二選一：
 *   { all: true }              — 對所有 windows 設備補 ingest
 *   { deviceUdids: string[] }  — 對指定設備補 ingest
 *
 * 命令僅入庫，設備靠各自 poll 週期（1-60min）自然錯峰拉取，批量入隊不發 WNS，
 * 故無 429 風險（錯峰由 poll 週期天然分散，不需限速）。重複對已 ingest 設備
 * 調用：設備回 418（已就緒，無害）。不存在/非 windows 設備記入 failures 不中斷整批。
 */
w.post("/api/mdm/win/devices/provision-lock-policy/bulk", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }

  const failures: Array<{ udid: string; error: string }> = [];
  let udids: string[];

  if (body.all === true) {
    // 全部 windows 設備：list 已保證 platform，無需逐台重查 getMdmDevice。
    // udid schema 可空，過濾掉未完成 enrollment 的空 udid 設備。
    udids = (await listMdmDevicesByPlatform("windows"))
      .map((d) => d.udid)
      .filter((u): u is string => u !== null);
  } else if (Array.isArray(body.deviceUdids) && body.deviceUdids.length > 0) {
    // 指定設備：逐台驗證存在且為 windows，不存在的記入 failures 不中斷。
    udids = [];
    for (const udid of body.deviceUdids as string[]) {
      const device = await getMdmDevice(udid);
      if (!device || device.platform !== "windows") {
        failures.push({ udid, error: "device not found" });
        continue;
      }
      udids.push(udid);
    }
  } else {
    return c.json(
      { error: "either { all: true } or { deviceUdids: string[] } required" },
      400,
    );
  }

  // 命令內容對所有設備相同，構造一次複用（單台端點每次重建）。
  const admx = buildLockAdmxInstall();
  let queued = 0;
  for (const udid of udids) {
    try {
      await enqueueWindowsCommand({
        deviceUdid: udid,
        commandType: "policy_admx_install",
        command: admx,
      });
      queued++;
    } catch (e) {
      failures.push({ udid, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({
    total: queued + failures.length,
    queued,
    failed: failures.length,
    failures,
    note:
      "Lock ADMX ingest 已批量入隊。設備靠各自 poll 週期(1-60min)自然錯峰拉取，" +
      "批量入隊不發 WNS，無 429 風險。已 ingest 設備回 418(無害)。",
  });
});

/** POST /api/mdm/win/devices/:udid/reboot — 排入 Reboot 命令 */
w.post("/api/mdm/win/devices/:udid/reboot", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
  if (!device || device.platform !== "windows") {
    return c.json({ error: "device not found" }, 404);
  }

  const cmd = buildReboot("RebootNow");
  const commandUuid = await enqueueWindowsCommand({
    deviceUdid: udid,
    commandType: "Reboot",
    command: cmd,
  });

  return c.json({
    commandUuid,
    action: "RebootNow",
    note:
      "Command queued. Device will reboot after WNS push or next poll (5-15 min countdown shown to user).",
  });
});

/** POST /api/mdm/win/devices/:udid/wipe — 排入 RemoteWipe */
w.post("/api/mdm/win/devices/:udid/wipe", async (c) => {
  const udid = c.req.param("udid");
  const device = await getMdmDevice(udid);
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
  const commandUuid = await enqueueWindowsCommand({
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

function getBaseUrl(c: Context): string {
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
