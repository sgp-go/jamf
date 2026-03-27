/** 自建 MDM API 路由 - /api/mdm/* */

import { Hono } from "@hono/hono";
import { handleCheckin } from "../mdm/checkin.ts";
import { handleCommandRequest, enqueueCommand } from "../mdm/command.ts";
import { pushToDevice } from "../mdm/apns.ts";
import {
  getApnsCertInfo,
  getApnsTopic,
  getOrCreateCA,
  getOrCreateDepKeyPair,
  decryptDepToken,
  saveApnsCert,
  generateApnsCsr,
  generateVendorCsr,
  saveVendorCert,
} from "../mdm/crypto.ts";
import { generateEnrollmentProfile } from "../mdm/enrollment.ts";
import {
  getDepAccount,
  syncDevicesToDb,
  createDepProfile,
  assignDepProfile,
} from "../mdm/dep.ts";
import {
  listMdmDevices,
  getMdmDevice,
  listMdmCommands,
  listDepDevices,
  listMigrations,
  getActiveDepToken,
  saveDepToken,
  updateDepTokenInfo,
  updateDepDeviceProfile,
} from "../db/sqlite.ts";
import type { MdmCommandType, DepProfile } from "../mdm/types.ts";

const mdm = new Hono();

// ============================================================
// 裝置協議端點（Apple 裝置呼叫，XML plist）
// ============================================================

/** PUT /checkin - MDM 簽入（Authenticate/TokenUpdate/CheckOut） */
mdm.put("/checkin", async (c) => {
  const bodyXml = await c.req.text();
  const result = handleCheckin(bodyXml);
  return c.text(result.message, result.status as 200);
});

/** PUT /command - MDM 命令通道（裝置拉取命令、回傳結果） */
mdm.put("/command", async (c) => {
  const bodyXml = await c.req.text();
  const result = handleCommandRequest(bodyXml);

  if (result.contentType === "application/xml" && result.body) {
    return c.body(result.body, result.status as 200, {
      "Content-Type": "application/xml",
    });
  }
  // 無命令時回傳空 body
  return c.body(null, 200);
});

// ============================================================
// 管理 API 端點（前端/管理者呼叫，JSON）
// ============================================================

/** GET /devices - 列出所有 MDM 註冊裝置 */
mdm.get("/devices", (c) => {
  const devices = listMdmDevices();
  return c.json({ totalCount: devices.length, devices });
});

/** GET /devices/:udid - 取得裝置詳情 */
mdm.get("/devices/:udid", (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device) {
    return c.json({ error: "裝置不存在" }, 404);
  }
  return c.json(device);
});

/** POST /devices/:udid/command - 排入 MDM 命令 */
mdm.post("/devices/:udid/command", async (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device) {
    return c.json({ error: "裝置不存在" }, 404);
  }
  if (device.enrollment_status !== "enrolled") {
    return c.json({ error: "裝置未註冊或已移除" }, 400);
  }

  const body = await c.req.json<{
    commandType: MdmCommandType;
    params?: Record<string, unknown>;
  }>();

  if (!body.commandType) {
    return c.json({ error: "缺少 commandType" }, 400);
  }

  const validCommands: MdmCommandType[] = [
    "DeviceInformation",
    "SecurityInfo",
    "InstalledApplicationList",
    "DeviceLock",
    "ClearPasscode",
    "EraseDevice",
    "RestartDevice",
    "ShutDownDevice",
    "InstallProfile",
    "RemoveProfile",
    "ProfileList",
    "CertificateList",
  ];

  if (!validCommands.includes(body.commandType)) {
    return c.json(
      { error: `無效的命令類型: ${body.commandType}` },
      400
    );
  }

  const commandUuid = enqueueCommand(udid, body.commandType, body.params);
  return c.json({ commandUuid, commandType: body.commandType }, 201);
});

/** GET /devices/:udid/commands - 查詢裝置命令歷史 */
mdm.get("/devices/:udid/commands", (c) => {
  const udid = c.req.param("udid");
  const limit = Number(c.req.query("limit") ?? 50);
  const commands = listMdmCommands(udid, { limit });
  return c.json({ commands });
});

/** POST /devices/:udid/push - 發送 APNS 推播喚醒裝置 */
mdm.post("/devices/:udid/push", async (c) => {
  const udid = c.req.param("udid");
  const device = getMdmDevice(udid);
  if (!device) {
    return c.json({ error: "裝置不存在" }, 404);
  }
  if (!device.push_token || !device.push_magic) {
    return c.json({ error: "裝置缺少推播 token" }, 400);
  }
  if (!device.topic) {
    return c.json({ error: "裝置缺少 APNS topic" }, 400);
  }

  const result = await pushToDevice(
    device.push_token,
    device.push_magic,
    device.topic
  );
  if (result.success) {
    return c.json({ message: "推播已發送", result });
  }
  return c.json({ error: "推播失敗", result }, 502);
});

// ============================================================
// DEP/ADE 管理端點
// ============================================================

/** GET /dep/pubkey - 下載自建 MDM 公鑰（供 ABM 上傳） */
mdm.get("/dep/pubkey", (c) => {
  const { publicKeyPem } = getOrCreateDepKeyPair();
  const download = c.req.query("download");
  if (download === "true") {
    return c.body(publicKeyPem, 200, {
      "Content-Type": "application/x-pem-file",
      "Content-Disposition": "attachment; filename=mdm_dep_pubkey.pem",
    });
  }
  return c.json({ publicKeyPem });
});

/** POST /dep/token - 上傳 .p7m DEP token，自動解密、驗證、同步 */
mdm.post("/dep/token", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("token") as File | null;
    if (!file) {
      return c.json({ error: "請上傳 token 檔案（欄位名: token）" }, 400);
    }

    // 讀取 .p7m 檔案二進位
    const p7mData = new Uint8Array(await file.arrayBuffer());
    console.log(`[DEP] 收到 token 檔案: ${file.name} (${p7mData.length} bytes)`);

    // 解密取得 OAuth 憑據
    const tokenData = decryptDepToken(p7mData);
    console.log("[DEP] Token 解密成功");

    // 儲存到資料庫
    const tokenId = saveDepToken({
      consumerKey: tokenData.consumer_key,
      consumerSecret: tokenData.consumer_secret,
      accessToken: tokenData.access_token,
      accessSecret: tokenData.access_secret,
      tokenExpiry: tokenData.access_token_expiry,
    });

    // 驗證 token 有效性（呼叫 DEP /account）
    let accountInfo;
    try {
      accountInfo = await getDepAccount();
      updateDepTokenInfo(tokenId, {
        serverName: accountInfo.server_name,
        orgName: accountInfo.org_name,
        orgEmail: accountInfo.org_email,
        orgAddress: accountInfo.org_address,
      });
      console.log(`[DEP] 帳戶驗證成功: ${accountInfo.org_name}`);
    } catch (e) {
      console.error("[DEP] 帳戶驗證失敗:", e);
      return c.json({
        warning: "Token 已儲存但帳戶驗證失敗，可能需要檢查 token",
        tokenId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // 自動觸發首次裝置同步
    let syncResult;
    try {
      syncResult = await syncDevicesToDb();
      console.log(`[DEP] 首次同步完成: ${syncResult.synced} 台裝置`);
    } catch (e) {
      console.error("[DEP] 首次同步失敗:", e);
      syncResult = { synced: 0, error: e instanceof Error ? e.message : String(e) };
    }

    return c.json({
      message: "DEP Token 上傳成功",
      tokenId,
      account: accountInfo,
      sync: syncResult,
    });
  } catch (e) {
    console.error("[DEP] Token 上傳失敗:", e);
    return c.json(
      { error: e instanceof Error ? e.message : "Token 解密失敗" },
      400
    );
  }
});

/** GET /dep/account - 查詢 DEP 帳戶資訊 */
mdm.get("/dep/account", async (c) => {
  try {
    const account = await getDepAccount();
    return c.json(account);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "查詢失敗" },
      500
    );
  }
});

/** GET /dep/devices - 列出 DEP 同步的裝置 */
mdm.get("/dep/devices", (c) => {
  const devices = listDepDevices();
  return c.json({ totalCount: devices.length, devices });
});

/** POST /dep/sync - 手動觸發 DEP 裝置增量同步 */
mdm.post("/dep/sync", async (c) => {
  try {
    const result = await syncDevicesToDb();
    return c.json({ message: "同步完成", ...result });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "同步失敗" },
      500
    );
  }
});

/** POST /dep/profile - 建立/更新 ADE 描述檔 */
mdm.post("/dep/profile", async (c) => {
  try {
    const serverUrl = Deno.env.get("MDM_SERVER_URL");
    if (!serverUrl) {
      return c.json({ error: "未設定 MDM_SERVER_URL" }, 500);
    }

    const body = await c.req.json<Partial<DepProfile>>();
    const profile: DepProfile = {
      profile_name: body.profile_name ?? "Self-Hosted MDM Auto Enrollment",
      url: `${serverUrl}/api/mdm/enroll`,
      allow_pairing: body.allow_pairing ?? true,
      is_supervised: body.is_supervised ?? true,
      is_mandatory: body.is_mandatory ?? true,
      await_device_configured: body.await_device_configured ?? false,
      is_mdm_removable: body.is_mdm_removable ?? false,
      support_phone_number: body.support_phone_number,
      support_email_address: body.support_email_address,
      org_magic: body.org_magic ?? "Self-Hosted MDM",
      skip_setup_items: body.skip_setup_items ?? [
        "Location",
        "Restore",
        "AppleID",
        "Terms",
        "Siri",
        "Diagnostics",
        "Biometric",
        "Payment",
        "ScreenTime",
        "SoftwareUpdate",
      ],
    };

    const result = await createDepProfile(profile);
    return c.json({ message: "ADE 描述檔已建立", ...result });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "建立失敗" },
      500
    );
  }
});

/** POST /dep/assign - 將 ADE 描述檔分配給裝置 */
mdm.post("/dep/assign", async (c) => {
  try {
    const body = await c.req.json<{
      profileUuid: string;
      serialNumbers: string[];
    }>();

    if (!body.profileUuid || !body.serialNumbers?.length) {
      return c.json({ error: "需要 profileUuid 和 serialNumbers" }, 400);
    }

    const result = await assignDepProfile(
      body.profileUuid,
      body.serialNumbers
    );

    // 更新本地資料庫的描述檔分配狀態
    for (const serial of body.serialNumbers) {
      const status = result.devices?.[serial];
      if (status === "SUCCESS") {
        updateDepDeviceProfile(serial, body.profileUuid, "assigned");
      }
    }

    return c.json({ message: "描述檔已分配", ...result });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "分配失敗" },
      500
    );
  }
});

// ============================================================
// 遷移端點
// ============================================================

/** POST /migration/start - 啟動 Jamf → 自建遷移 */
mdm.post("/migration/start", async (c) => {
  try {
    const body = await c.req.json<{
      serialNumber: string;
      jamfDeviceId?: string;
      jamfManagementId?: string;
    }>();

    if (!body.serialNumber) {
      return c.json({ error: "需要 serialNumber" }, 400);
    }

    const { createMigration } = await import("../db/sqlite.ts");
    const migrationId = createMigration({
      serialNumber: body.serialNumber,
      jamfDeviceId: body.jamfDeviceId,
      jamfManagementId: body.jamfManagementId,
    });

    return c.json({
      message: "遷移已建立",
      migrationId,
      nextSteps: [
        "1. 在 ABM 中將裝置的 MDM Server 改為自建 MDM",
        "2. 呼叫 POST /api/mdm/dep/sync 同步裝置",
        "3. 呼叫 POST /api/mdm/dep/assign 分配 ADE 描述檔",
        "4. 抹掉裝置（透過 Jamf 或手動）",
        "5. 裝置重新進入 Setup Assistant 後自動註冊",
      ],
    }, 201);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "建立遷移失敗" },
      500
    );
  }
});

/** GET /migration/status - 查詢遷移狀態 */
mdm.get("/migration/status", (c) => {
  const migrations = listMigrations();
  return c.json({ totalCount: migrations.length, migrations });
});

// ============================================================
// 憑證狀態
// ============================================================

/** GET /certs/status - 查看憑證狀態 */
mdm.get("/certs/status", (c) => {
  const apnsCert = getApnsCertInfo();

  let caCert: { exists: boolean; expiry?: string } = { exists: false };
  try {
    const ca = getOrCreateCA();
    caCert = {
      exists: true,
      expiry: ca.cert.validity.notAfter.toISOString(),
    };
  } catch {
    // CA 不存在或載入失敗
  }

  const depToken = getActiveDepToken();
  const depTokenInfo = depToken
    ? {
        exists: true,
        orgName: depToken.org_name,
        expiry: depToken.token_expiry,
        lastSynced: depToken.last_synced_at,
      }
    : { exists: false };

  return c.json({ apnsCert, caCert, depToken: depTokenInfo });
});

/**
 * GET /certs/vendor/csr - 生成 MDM Vendor Certificate 的 CSR
 * 使用者拿此 CSR 到 Apple Developer 後台申請 MDM Vendor Certificate
 * 私鑰自動儲存在伺服器，後續上傳 .cer 時配對使用
 */
mdm.get("/certs/vendor/csr", (c) => {
  try {
    const { csrPem } = generateVendorCsr();
    const download = c.req.query("download");
    if (download === "true") {
      return c.body(csrPem, 200, {
        "Content-Type": "application/pkcs10",
        "Content-Disposition": "attachment; filename=mdm_vendor.csr",
      });
    }
    return c.json({
      message: "Vendor CSR 已生成，私鑰已儲存在伺服器",
      csrPem,
      nextSteps: [
        "1. 登入 Apple Developer (https://developer.apple.com/account)",
        "2. Certificates, Identifiers & Profiles → Certificates → +",
        "3. 選擇 MDM CSR Signing Certificate",
        "4. 上傳此 CSR 檔案",
        "5. 下載 Apple 簽發的 .cer 檔案",
        "6. 呼叫 POST /api/mdm/certs/vendor 上傳 .cer（伺服器自動配對私鑰）",
      ],
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "CSR 生成失敗" },
      500
    );
  }
});

/**
 * POST /certs/vendor - 上傳 Apple Developer 簽發的 MDM Vendor Certificate (.cer)
 * 伺服器自動配對先前生成的私鑰，儲存後用於簽署 APNS CSR
 */
mdm.post("/certs/vendor", async (c) => {
  try {
    const contentType = c.req.header("content-type") ?? "";
    let cerData: Uint8Array;
    let keyPem: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const certFile = formData.get("cert") as File | null;
      const keyFile = formData.get("key") as File | null;
      if (!certFile) {
        return c.json({ error: "請上傳 cert 檔案（.cer）" }, 400);
      }
      cerData = new Uint8Array(await certFile.arrayBuffer());
      keyPem = keyFile ? await keyFile.text() : undefined;
    } else {
      const body = await c.req.json<{ cert_base64: string; key?: string }>();
      if (!body.cert_base64) {
        return c.json({ error: "需要 cert_base64 欄位（DER base64）" }, 400);
      }
      cerData = Uint8Array.from(atob(body.cert_base64), c => c.charCodeAt(0));
      keyPem = body.key;
    }

    const result = saveVendorCert(cerData, keyPem);
    return c.json({
      message: "MDM Vendor Certificate 上傳成功",
      ...result,
      nextSteps: [
        "1. 呼叫 GET /api/mdm/certs/apns/csr 生成 APNS CSR",
        "2. 呼叫 POST /api/mdm/certs/apns/sign 自動簽署（不需要再傳 vendor cert）",
        "3. 拿簽署結果去 Apple Push Certificates Portal 取得推播憑證",
        "4. 呼叫 POST /api/mdm/certs/apns 上傳推播憑證",
      ],
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "上傳失敗" },
      400
    );
  }
});

/** GET /certs/apns/csr - 生成並下載 APNS CSR（私鑰自動儲存在伺服器） */
mdm.get("/certs/apns/csr", (c) => {
  try {
    const { csrPem } = generateApnsCsr();
    const download = c.req.query("download");
    if (download === "true") {
      return c.body(csrPem, 200, {
        "Content-Type": "application/pkcs10",
        "Content-Disposition": "attachment; filename=mdm_apns.csr",
      });
    }
    return c.json({
      message: "CSR 已生成，私鑰已儲存在伺服器",
      csrPem,
      nextSteps: [
        "1. 用 MDM vendor certificate 簽署此 CSR",
        "2. 將簽署後的 CSR 上傳到 Apple Push Certificates Portal (https://identity.apple.com/pushcert/)",
        "3. 下載 Apple 簽發的推播憑證（.pem）",
        "4. 呼叫 POST /api/mdm/certs/apns 上傳憑證（只需 cert，私鑰已在伺服器上）",
      ],
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "CSR 生成失敗" },
      500
    );
  }
});

/**
 * POST /certs/apns/sign - 用已上傳的 Vendor Certificate 簽署 APNS CSR
 * 生成 Apple Push Certificates Portal 接受的格式：
 * base64 編碼的 plist，包含 PushCertRequestCSR、PushCertSignature、PushCertCertificateChain
 */
mdm.post("/certs/apns/sign", async (c) => {
  try {
    // 檢查 APNS CSR 是否已生成（自動生成）
    let csrPem: string;
    try {
      csrPem = Deno.readTextFileSync("certs/apns_csr.pem");
    } catch {
      const { csrPem: newCsr } = generateApnsCsr();
      csrPem = newCsr;
    }

    // 檢查 vendor cert 和 key
    const vendorCertPath = "certs/vendor_cert.pem";
    const vendorKeyPath = "certs/vendor_key.pem";
    try {
      Deno.statSync(vendorCertPath);
      Deno.statSync(vendorKeyPath);
    } catch {
      return c.json({
        error: "Vendor Certificate 尚未上傳，請先完成以下步驟",
        steps: [
          "1. GET /api/mdm/certs/vendor/csr → 下載 CSR",
          "2. 到 Apple Developer 後台上傳 CSR，下載 .cer",
          "3. POST /api/mdm/certs/vendor → 上傳 .cer",
        ],
      }, 400);
    }

    const tmpDir = "tmp";
    try { Deno.mkdirSync(tmpDir, { recursive: true }); } catch { /* exists */ }

    // 1. CSR PEM → DER → base64
    Deno.writeTextFileSync(`${tmpDir}/_apns_csr.pem`, csrPem);
    const toDer = new Deno.Command("openssl", {
      args: ["req", "-inform", "pem", "-outform", "der",
             "-in", `${tmpDir}/_apns_csr.pem`, "-out", `${tmpDir}/_apns_csr.der`],
      stdout: "piped", stderr: "piped",
    });
    if (!(await toDer.output()).success) {
      return c.json({ error: "CSR PEM→DER 轉換失敗" }, 500);
    }
    const csrDerBytes = Deno.readFileSync(`${tmpDir}/_apns_csr.der`);
    const csrBase64 = btoa(String.fromCharCode(...csrDerBytes));

    // 2. 用 vendor 私鑰對 CSR DER 簽名（SHA1，Apple 要求）
    const signCmd = new Deno.Command("openssl", {
      args: ["sha1", "-sign", vendorKeyPath, `${tmpDir}/_apns_csr.der`],
      stdout: "piped", stderr: "piped",
    });
    const signResult = await signCmd.output();
    if (!signResult.success) {
      return c.json({ error: "CSR 簽名失敗" }, 500);
    }
    const sigBase64 = btoa(String.fromCharCode(...signResult.stdout));

    // 3. 建構完整證書鏈：vendor cert + Apple WWDR G3 + Apple Root CA
    const vendorCertPem = Deno.readTextFileSync(vendorCertPath);

    // 下載 Apple 中間 CA 和根 CA
    const wwdrG3Resp = await fetch("https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer");
    const wwdrG3Der = new Uint8Array(await wwdrG3Resp.arrayBuffer());
    const rootResp = await fetch("http://www.apple.com/appleca/AppleIncRootCertificate.cer");
    const rootDer = new Uint8Array(await rootResp.arrayBuffer());

    // DER → PEM
    async function derToPem(der: Uint8Array): Promise<string> {
      const cmd = new Deno.Command("openssl", {
        args: ["x509", "-inform", "der"],
        stdin: "piped", stdout: "piped", stderr: "piped",
      });
      const proc = cmd.spawn();
      const writer = proc.stdin.getWriter();
      await writer.write(der);
      await writer.close();
      const out = await proc.output();
      return new TextDecoder().decode(out.stdout);
    }

    const wwdrG3Pem = await derToPem(wwdrG3Der);
    const rootPem = await derToPem(rootDer);
    const certChain = vendorCertPem.trim() + "\n" + wwdrG3Pem.trim() + "\n" + rootPem.trim() + "\n";

    // 4. 用 plistlib 格式建構 plist（和 Jamf 格式一致）
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1">
  <dict>
    <key>PushCertSignature</key>
    <string>${sigBase64}</string>
    <key>PushCertRequestCSR</key>
    <string>${csrBase64}</string>
    <key>PushCertCertificateChain</key>
    <string>${certChain}</string>
  </dict>
</plist>
`;

    // 5. base64 編碼整個 plist
    const plistBase64 = btoa(plist);

    // 清理臨時檔案
    for (const f of ["_apns_csr.pem", "_apns_csr.der"]) {
      try { Deno.removeSync(`${tmpDir}/${f}`); } catch { /* ok */ }
    }

    // 回傳 .plist 檔案（base64 編碼的 plist，Apple Portal 接受此格式）
    return c.body(plistBase64, 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=SignedCSR.plist",
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "簽署失敗" },
      500
    );
  }
});

/**
 * POST /certs/apns - 上傳 APNS 推播憑證
 * - 若先前呼叫過 GET /certs/apns/csr：只需上傳 cert（私鑰已在伺服器上）
 * - 也可同時上傳 cert + key
 */
mdm.post("/certs/apns", async (c) => {
  try {
    const contentType = c.req.header("content-type") ?? "";

    let certPem: string;
    let keyPem: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const certFile = formData.get("cert") as File | null;
      const keyFile = formData.get("key") as File | null;

      if (!certFile) {
        return c.json({ error: "請上傳 cert PEM 檔案" }, 400);
      }
      certPem = await certFile.text();
      keyPem = keyFile ? await keyFile.text() : undefined;
    } else {
      const body = await c.req.json<{ cert: string; key?: string }>();
      if (!body.cert) {
        return c.json({ error: "需要 cert 欄位（PEM 格式字串）" }, 400);
      }
      certPem = body.cert;
      keyPem = body.key;
    }

    const result = saveApnsCert(certPem, keyPem);
    return c.json({
      message: "APNS 憑證上傳成功",
      topic: result.topic,
      expiry: result.expiry,
      subject: result.subject,
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "上傳失敗" },
      400
    );
  }
});

/** POST /certs/ca/regenerate - 重新生成 CA 根憑證 */
mdm.post("/certs/ca/regenerate", (c) => {
  try {
    // 刪除現有 CA 憑證，強制重新生成
    try {
      Deno.removeSync("certs/ca_cert.pem");
      Deno.removeSync("certs/ca_key.pem");
    } catch {
      // 不存在也沒關係
    }

    const ca = getOrCreateCA();
    return c.json({
      message: "CA 憑證已重新生成",
      expiry: ca.cert.validity.notAfter.toISOString(),
      subject: ca.cert.subject.attributes
        .map((a: { shortName?: string; value?: string }) => `${a.shortName}=${a.value}`)
        .join(", "),
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "重新生成失敗" },
      500
    );
  }
});

// ============================================================
// 註冊描述檔
// ============================================================

/** POST /enroll - ADE 觸發的註冊端點，回傳 .mobileconfig */
mdm.post("/enroll", (c) => {
  const serverUrl = Deno.env.get("MDM_SERVER_URL");
  const topic = getApnsTopic();

  if (!serverUrl) {
    return c.json({ error: "未設定 MDM_SERVER_URL" }, 500);
  }
  if (!topic) {
    return c.json(
      { error: "APNS 憑證尚未上傳，請先呼叫 POST /api/mdm/certs/apns" },
      500
    );
  }

  const profileXml = generateEnrollmentProfile({
    serverBaseUrl: serverUrl,
    topic,
  });

  return c.body(profileXml, 200, {
    "Content-Type": "application/x-apple-aspen-config",
  });
});

/** GET /enroll - 也支援 GET 方式下載描述檔（手動安裝用） */
mdm.get("/enroll", (c) => {
  const serverUrl = Deno.env.get("MDM_SERVER_URL");
  const topic = getApnsTopic();

  if (!serverUrl) {
    return c.json({ error: "未設定 MDM_SERVER_URL" }, 500);
  }
  if (!topic) {
    return c.json(
      { error: "APNS 憑證尚未上傳，請先呼叫 POST /api/mdm/certs/apns" },
      500
    );
  }

  const profileXml = generateEnrollmentProfile({
    serverBaseUrl: serverUrl,
    topic,
  });

  return c.body(profileXml, 200, {
    "Content-Type": "application/x-apple-aspen-config",
    "Content-Disposition": "attachment; filename=enroll.mobileconfig",
  });
});

export default mdm;
