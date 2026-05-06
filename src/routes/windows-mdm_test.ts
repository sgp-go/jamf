/** Windows MDM 路由端到端測試（in-process，無需啟動 server） */

import { assertEquals, assert, assertExists } from "jsr:@std/assert@^1";
import forge from "node-forge";
import windowsMdm from "./windows-mdm.ts";
import { Hono } from "@hono/hono";
import {
  getDb,
  getMdmDeviceByWindowsId,
  listMdmCommands,
} from "../db/sqlite.ts";

/** 用同樣方式組裝 app（避免動到生產 server.ts） */
function makeTestApp(): Hono {
  const app = new Hono();
  app.route("/", windowsMdm);
  return app;
}

const BASE = "https://test-mdm.example.com";

/** 清掉一個 deviceId 對應的測試殘留 */
function cleanup(deviceId: string) {
  const db = getDb();
  const udid = `windows-${deviceId}`;
  db.prepare("DELETE FROM mdm_windows_apps WHERE device_udid = ?").run(udid);
  db.prepare("DELETE FROM mdm_commands WHERE device_udid = ?").run(udid);
  db.prepare("DELETE FROM mdm_certificates WHERE device_udid = ?").run(udid);
  db.prepare("DELETE FROM mdm_devices WHERE udid = ?").run(udid);
}

function makeCsrBase64(commonName: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes()
  );
}

// ============================================================
// Discovery
// ============================================================

Deno.test("Discovery: GET 探活回 200 + 純文字訊息", async () => {
  const app = makeTestApp();
  const res = await app.fetch(
    new Request(`${BASE}/EnrollmentServer/Discovery.svc`)
  );
  assertEquals(res.status, 200);
  const body = await res.text();
  assert(body.toLowerCase().includes("discovery"));
});

Deno.test("Discovery: POST SOAP 回應含正確 Policy/Enrollment URL", async () => {
  const app = makeTestApp();
  const reqXml = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
  <s:Header><a:MessageID>urn:uuid:disc-1</a:MessageID></s:Header>
  <s:Body>
    <Discover xmlns="http://schemas.microsoft.com/windows/management/2012/01/enrollment">
      <request>
        <EmailAddress>u@x.com</EmailAddress>
        <RequestVersion>4.0</RequestVersion>
        <DeviceType>CIMClient_Windows</DeviceType>
        <AuthPolicies><AuthPolicy>OnPremise</AuthPolicy></AuthPolicies>
      </request>
    </Discover>
  </s:Body>
</s:Envelope>`;
  const res = await app.fetch(
    new Request(`${BASE}/EnrollmentServer/Discovery.svc`, {
      method: "POST",
      body: reqXml,
      headers: { "Content-Type": "application/soap+xml" },
    })
  );
  assertEquals(res.status, 200);
  assert(res.headers.get("Content-Type")!.includes("application/soap+xml"));
  const body = await res.text();
  assert(body.includes(`${BASE}/EnrollmentServer/Policy.svc`));
  assert(body.includes(`${BASE}/EnrollmentServer/Enrollment.svc`));
  assert(body.includes("<a:RelatesTo>urn:uuid:disc-1</a:RelatesTo>"));
});

// ============================================================
// Policy
// ============================================================

Deno.test("Policy: POST 回應含 minimalKeyLength=2048", async () => {
  const app = makeTestApp();
  const reqXml = `<s:Envelope xmlns:s="..." xmlns:a="...">
  <s:Header><a:MessageID>urn:uuid:pol-1</a:MessageID></s:Header>
  <s:Body><GetPolicies/></s:Body>
</s:Envelope>`;
  const res = await app.fetch(
    new Request(`${BASE}/EnrollmentServer/Policy.svc`, {
      method: "POST",
      body: reqXml,
    })
  );
  assertEquals(res.status, 200);
  const body = await res.text();
  assert(body.includes("<minimalKeyLength>2048</minimalKeyLength>"));
});

// ============================================================
// Enrollment（端到端：CSR → 簽發 → DB 寫入 → 回應 SOAP）
// ============================================================

Deno.test("Enrollment: 完整流程 — 寫入 mdm_devices + mdm_certificates + 回應含 wap-provisioningdoc", async () => {
  const deviceId = `WIN-E2E-${crypto.randomUUID()}`;
  cleanup(deviceId);
  const app = makeTestApp();
  const csrB64 = makeCsrBase64("ignored");

  const reqXml = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
  <s:Header><a:MessageID>urn:uuid:enr-1</a:MessageID></s:Header>
  <s:Body>
    <RequestSecurityToken>
      <BinarySecurityToken ValueType="...PKCS10" EncodingType="...base64binary">${csrB64}</BinarySecurityToken>
      <AdditionalContext>
        <ContextItem Name="DeviceID"><Value>${deviceId}</Value></ContextItem>
        <ContextItem Name="HWDevID"><Value>HW-XYZ</Value></ContextItem>
        <ContextItem Name="DeviceName"><Value>TEST-PC-01</Value></ContextItem>
        <ContextItem Name="OSVersion"><Value>10.0.22621</Value></ContextItem>
      </AdditionalContext>
    </RequestSecurityToken>
  </s:Body>
</s:Envelope>`;
  const res = await app.fetch(
    new Request(`${BASE}/EnrollmentServer/Enrollment.svc`, {
      method: "POST",
      body: reqXml,
    })
  );
  assertEquals(res.status, 200);
  const body = await res.text();
  // 回應結構
  assert(body.includes("RequestSecurityTokenResponseCollection"));
  assert(body.includes("BinarySecurityToken"));

  // DB 寫入驗證
  const device = getMdmDeviceByWindowsId(deviceId);
  assertExists(device);
  assertEquals(device.platform, "windows");
  assertEquals(device.windows_hardware_id, "HW-XYZ");
  assertEquals(device.device_name, "TEST-PC-01");
  assertEquals(device.os_version, "10.0.22621");
  assertEquals(device.enrollment_status, "enrolled");
  assertEquals(device.enrollment_type, "ppkg");

  // 證書入庫
  const cert = getDb()
    .prepare(
      "SELECT certificate_pem, subject FROM mdm_certificates WHERE device_udid = ?"
    )
    .get(`windows-${deviceId}`) as
    | { certificate_pem: string; subject: string }
    | undefined;
  assertExists(cert);
  assertEquals(cert.subject, `CN=${deviceId}`);
  // 解析 PEM 確認 CN 正確
  const parsed = forge.pki.certificateFromPem(cert.certificate_pem);
  assertEquals(parsed.subject.getField("CN")?.value, deviceId);

  cleanup(deviceId);
});

Deno.test("Enrollment: 缺 BinarySecurityToken 回 400", async () => {
  const app = makeTestApp();
  const reqXml = `<s:Envelope>
  <s:Header><a:MessageID>id</a:MessageID></s:Header>
  <s:Body><RequestSecurityToken></RequestSecurityToken></s:Body>
</s:Envelope>`;
  const res = await app.fetch(
    new Request(`${BASE}/EnrollmentServer/Enrollment.svc`, {
      method: "POST",
      body: reqXml,
    })
  );
  assertEquals(res.status, 400);
});

// ============================================================
// 管理 API：Wipe + 列表 + 命令歷史
// ============================================================

Deno.test("管理 API + SyncML 管理通道：Wipe → poll → 設備 ack 全鏈路", async () => {
  const deviceId = `WIN-WIPE-${crypto.randomUUID()}`;
  const udid = `windows-${deviceId}`;
  cleanup(deviceId);
  const app = makeTestApp();

  // 先做一次完整 enrollment 建立裝置記錄
  const csrB64 = makeCsrBase64("ignored");
  await app.fetch(
    new Request(`${BASE}/EnrollmentServer/Enrollment.svc`, {
      method: "POST",
      body: `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
  <s:Header><a:MessageID>urn:uuid:enr-w</a:MessageID></s:Header>
  <s:Body>
    <RequestSecurityToken>
      <BinarySecurityToken>${csrB64}</BinarySecurityToken>
      <AdditionalContext>
        <ContextItem Name="DeviceID"><Value>${deviceId}</Value></ContextItem>
      </AdditionalContext>
    </RequestSecurityToken>
  </s:Body>
</s:Envelope>`,
    })
  );

  // 1) 列裝置
  const listRes = await app.fetch(new Request(`${BASE}/api/mdm/win/devices`));
  assertEquals(listRes.status, 200);
  const listJson = await listRes.json();
  assert(
    Array.isArray(listJson.devices) &&
      listJson.devices.some((d: { udid: string }) => d.udid === udid),
    "新裝置應出現在列表中"
  );

  // 2) 排入 Wipe
  const wipeRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/devices/${udid}/wipe`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    })
  );
  assertEquals(wipeRes.status, 200);
  const wipeJson = await wipeRes.json();
  assertExists(wipeJson.commandUuid);
  assertEquals(wipeJson.action, "doWipe");

  // 3) 設備首次 PUT SyncML（含 Alert 1201），應拉到 Wipe 命令
  const firstSync = `<?xml version="1.0" encoding="UTF-8"?>
<SyncML xmlns="SYNCML:SYNCML1.2">
  <SyncHdr>
    <VerDTD>1.2</VerDTD><VerProto>DM/1.2</VerProto>
    <SessionID>1</SessionID><MsgID>1</MsgID>
    <Target><LocURI>${BASE}/api/mdm/win/manage/${deviceId}</LocURI></Target>
    <Source><LocURI>${deviceId}</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Alert><CmdID>2</CmdID><Data>1201</Data></Alert>
    <Final/>
  </SyncBody>
</SyncML>`;
  const syncRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/manage/${deviceId}`, {
      method: "PUT",
      body: firstSync,
      headers: { "Content-Type": "application/vnd.syncml.dm+xml" },
    })
  );
  assertEquals(syncRes.status, 200);
  const respXml1 = await syncRes.text();
  assert(respXml1.includes("<Exec>"), "回應應含 Exec 命令");
  assert(respXml1.includes("./Device/Vendor/MSFT/RemoteWipe/doWipe"));

  // 4) 命令歷史顯示已 sent
  const histRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/devices/${udid}/commands`)
  );
  const histJson = await histRes.json();
  const wipeCmd = histJson.commands.find(
    (c: { command_uuid: string }) => c.command_uuid === wipeJson.commandUuid
  );
  assertExists(wipeCmd);
  assertEquals(wipeCmd.status, "sent");

  // 5) 設備第二次 PUT 上報 Wipe 執行成功（Status 200，cmdRef=2）
  const ackSync = `<SyncML xmlns="SYNCML:SYNCML1.2">
  <SyncHdr>
    <SessionID>1</SessionID><MsgID>2</MsgID>
    <Target><LocURI>${BASE}/api/mdm/win/manage/${deviceId}</LocURI></Target>
    <Source><LocURI>${deviceId}</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Status><CmdID>1</CmdID><MsgRef>1</MsgRef><CmdRef>0</CmdRef><Cmd>SyncHdr</Cmd><Data>200</Data></Status>
    <Status><CmdID>2</CmdID><MsgRef>1</MsgRef><CmdRef>2</CmdRef><Cmd>Exec</Cmd><Data>200</Data></Status>
    <Final/>
  </SyncBody>
</SyncML>`;
  const ackRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/manage/${deviceId}`, {
      method: "PUT",
      body: ackSync,
    })
  );
  assertEquals(ackRes.status, 200);

  // 6) 命令狀態應更新為 acknowledged
  const finalCmds = listMdmCommands(udid, { limit: 10 });
  const finalWipe = finalCmds.find(
    (c) => c.command_uuid === wipeJson.commandUuid
  );
  assertExists(finalWipe);
  assertEquals(finalWipe.status, "acknowledged");

  cleanup(deviceId);
});

Deno.test("管理 API：Wipe 不存在的裝置回 404", async () => {
  const app = makeTestApp();
  const res = await app.fetch(
    new Request(`${BASE}/api/mdm/win/devices/not-exist/wipe`, {
      method: "POST",
    })
  );
  assertEquals(res.status, 404);
});

Deno.test("管理通道：未註冊裝置 PUT SyncML 回 404", async () => {
  const app = makeTestApp();
  const res = await app.fetch(
    new Request(`${BASE}/api/mdm/win/manage/non-enrolled-device`, {
      method: "PUT",
      body: "<SyncML/>",
    })
  );
  assertEquals(res.status, 404);
});

// ============================================================
// PR5: MSIX 部署 + 應用清單
// ============================================================

/** Helper：跑一次 enrollment 建立測試裝置 */
async function enrollDevice(
  app: Hono,
  deviceId: string,
  csrB64: string
): Promise<void> {
  await app.fetch(
    new Request(`${BASE}/EnrollmentServer/Enrollment.svc`, {
      method: "POST",
      body: `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
  <s:Header><a:MessageID>urn:uuid:enr</a:MessageID></s:Header>
  <s:Body><RequestSecurityToken>
    <BinarySecurityToken>${csrB64}</BinarySecurityToken>
    <AdditionalContext>
      <ContextItem Name="DeviceID"><Value>${deviceId}</Value></ContextItem>
    </AdditionalContext>
  </RequestSecurityToken></s:Body>
</s:Envelope>`,
    })
  );
}

Deno.test("MSIX install API: 缺欄位回 400", async () => {
  const deviceId = `WIN-INST-${crypto.randomUUID()}`;
  const udid = `windows-${deviceId}`;
  cleanup(deviceId);
  const app = makeTestApp();
  await enrollDevice(app, deviceId, makeCsrBase64("x"));

  const res = await app.fetch(
    new Request(`${BASE}/api/mdm/win/devices/${udid}/apps/install`, {
      method: "POST",
      body: JSON.stringify({ packageFamilyName: "X" }),
      headers: { "Content-Type": "application/json" },
    })
  );
  assertEquals(res.status, 400);
  cleanup(deviceId);
});

Deno.test("MSIX install API: contentUri 必須 HTTPS", async () => {
  const deviceId = `WIN-INST2-${crypto.randomUUID()}`;
  const udid = `windows-${deviceId}`;
  cleanup(deviceId);
  const app = makeTestApp();
  await enrollDevice(app, deviceId, makeCsrBase64("x"));

  const res = await app.fetch(
    new Request(`${BASE}/api/mdm/win/devices/${udid}/apps/install`, {
      method: "POST",
      body: JSON.stringify({
        packageFamilyName: "X.Y_z",
        contentUri: "http://insecure.example.com/x.msix",
        hashHex: "abc",
      }),
      headers: { "Content-Type": "application/json" },
    })
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.error.includes("HTTPS"));
  cleanup(deviceId);
});

Deno.test("MSIX install API + SyncML 通道：排入命令 → 設備 poll 拉到 Exec", async () => {
  const deviceId = `WIN-MSIX-${crypto.randomUUID()}`;
  const udid = `windows-${deviceId}`;
  cleanup(deviceId);
  const app = makeTestApp();
  await enrollDevice(app, deviceId, makeCsrBase64("x"));

  // 排入安裝
  const installRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/devices/${udid}/apps/install`, {
      method: "POST",
      body: JSON.stringify({
        packageFamilyName: "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
        contentUri:
          "https://cdn.example.com/calculator.msixbundle",
        hashHex: "abc123def456",
        isLOB: false,
      }),
      headers: { "Content-Type": "application/json" },
    })
  );
  assertEquals(installRes.status, 200);
  const installJson = await installRes.json();
  assertExists(installJson.commandUuid);

  // 設備 poll
  const sync = `<SyncML xmlns="SYNCML:SYNCML1.2">
  <SyncHdr>
    <SessionID>1</SessionID><MsgID>1</MsgID>
    <Target><LocURI>${BASE}/api/mdm/win/manage/${deviceId}</LocURI></Target>
    <Source><LocURI>${deviceId}</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Alert><CmdID>2</CmdID><Data>1201</Data></Alert>
    <Final/>
  </SyncBody>
</SyncML>`;
  const syncRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/manage/${deviceId}`, {
      method: "PUT",
      body: sync,
    })
  );
  const respXml = await syncRes.text();
  assert(respXml.includes("<Exec>"));
  assert(
    respXml.includes(
      "EnterpriseModernAppManagement/AppInstallation/Microsoft.WindowsCalculator"
    )
  );
  // Data 含 ContentURL
  assert(respXml.includes("cdn.example.com/calculator.msixbundle"));

  cleanup(deviceId);
});

Deno.test("Inventory refresh API + 設備回 Results：寫入 mdm_windows_apps", async () => {
  const deviceId = `WIN-INV-${crypto.randomUUID()}`;
  const udid = `windows-${deviceId}`;
  cleanup(deviceId);
  const app = makeTestApp();
  await enrollDevice(app, deviceId, makeCsrBase64("x"));

  // 排入 inventory query
  const refreshRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/devices/${udid}/apps/refresh`, {
      method: "POST",
    })
  );
  assertEquals(refreshRes.status, 200);

  // 設備 poll 拉到 Get
  const sync1 = `<SyncML xmlns="SYNCML:SYNCML1.2">
  <SyncHdr>
    <SessionID>1</SessionID><MsgID>1</MsgID>
    <Target><LocURI>${BASE}/api/mdm/win/manage/${deviceId}</LocURI></Target>
    <Source><LocURI>${deviceId}</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Alert><CmdID>2</CmdID><Data>1201</Data></Alert>
    <Final/>
  </SyncBody>
</SyncML>`;
  const r1 = await app.fetch(
    new Request(`${BASE}/api/mdm/win/manage/${deviceId}`, {
      method: "PUT",
      body: sync1,
    })
  );
  const respXml = await r1.text();
  assert(respXml.includes("<Get>"));
  assert(respXml.includes("AppInventoryResults"));

  // 模擬設備回 Results（escape 後的 inner XML）
  const innerXml =
    '<Results Schema="1.0">' +
    '<App PackageFamilyName="Microsoft.WindowsCalculator_8wekyb3d8bbwe" Version="10.2204" Name="Calculator" InstallState="2"/>' +
    '<App PackageFamilyName="Microsoft.MicrosoftEdge_8wekyb3d8bbwe" Version="126.0" Name="Edge" InstallState="2"/>' +
    "</Results>";
  const escaped = innerXml
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const sync2 = `<SyncML xmlns="SYNCML:SYNCML1.2">
  <SyncHdr>
    <SessionID>1</SessionID><MsgID>2</MsgID>
    <Target><LocURI>${BASE}/api/mdm/win/manage/${deviceId}</LocURI></Target>
    <Source><LocURI>${deviceId}</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Status><CmdID>1</CmdID><MsgRef>1</MsgRef><CmdRef>0</CmdRef><Cmd>SyncHdr</Cmd><Data>200</Data></Status>
    <Status><CmdID>2</CmdID><MsgRef>1</MsgRef><CmdRef>2</CmdRef><Cmd>Get</Cmd><Data>200</Data></Status>
    <Results>
      <CmdID>3</CmdID>
      <MsgRef>1</MsgRef>
      <CmdRef>2</CmdRef>
      <Item>
        <Source><LocURI>./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInventoryResults?Filter=Output=Inventory</LocURI></Source>
        <Meta><Format xmlns="syncml:metinf">chr</Format></Meta>
        <Data>${escaped}</Data>
      </Item>
    </Results>
    <Final/>
  </SyncBody>
</SyncML>`;
  await app.fetch(
    new Request(`${BASE}/api/mdm/win/manage/${deviceId}`, {
      method: "PUT",
      body: sync2,
    })
  );

  // 從 GET apps 取回
  const listRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/devices/${udid}/apps`)
  );
  const listJson = await listRes.json();
  assertEquals(listJson.apps.length, 2);
  const calc = listJson.apps.find(
    (a: { package_family_name: string }) =>
      a.package_family_name === "Microsoft.WindowsCalculator_8wekyb3d8bbwe"
  );
  assertExists(calc);
  assertEquals(calc.display_name, "Calculator");
  assertEquals(calc.version, "10.2204");
  assertEquals(calc.install_state, "2");

  cleanup(deviceId);
});

Deno.test("MSIX uninstall API: 排入 Delete 命令", async () => {
  const deviceId = `WIN-UNINST-${crypto.randomUUID()}`;
  const udid = `windows-${deviceId}`;
  cleanup(deviceId);
  const app = makeTestApp();
  await enrollDevice(app, deviceId, makeCsrBase64("x"));

  const res = await app.fetch(
    new Request(
      `${BASE}/api/mdm/win/devices/${udid}/apps/Microsoft.WindowsCalculator_8wekyb3d8bbwe`,
      { method: "DELETE" }
    )
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.commandUuid);

  // 設備 poll 應拉到 Delete
  const sync = `<SyncML xmlns="SYNCML:SYNCML1.2">
  <SyncHdr>
    <SessionID>1</SessionID><MsgID>1</MsgID>
    <Target><LocURI>${BASE}/api/mdm/win/manage/${deviceId}</LocURI></Target>
    <Source><LocURI>${deviceId}</LocURI></Source>
  </SyncHdr>
  <SyncBody><Alert><CmdID>2</CmdID><Data>1201</Data></Alert><Final/></SyncBody>
</SyncML>`;
  const syncRes = await app.fetch(
    new Request(`${BASE}/api/mdm/win/manage/${deviceId}`, {
      method: "PUT",
      body: sync,
    })
  );
  const respXml = await syncRes.text();
  assert(respXml.includes("<Delete>"));
  assert(respXml.includes("AppManagement/AppStore/Microsoft.WindowsCalculator"));

  cleanup(deviceId);
});
