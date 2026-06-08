import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { parseSyncML, buildSyncML } from "./syncml.ts";

// ============================================================
// parseSyncML
// ============================================================

Deno.test("parseSyncML: 客戶端首次連線 Alert 1201", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SyncML xmlns="SYNCML:SYNCML1.2">
  <SyncHdr>
    <VerDTD>1.2</VerDTD>
    <VerProto>DM/1.2</VerProto>
    <SessionID>1</SessionID>
    <MsgID>1</MsgID>
    <Target><LocURI>https://mdm.example.com/manage/dev-001</LocURI></Target>
    <Source><LocURI>WIN-DEV-001-GUID</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Alert>
      <CmdID>2</CmdID>
      <Data>1201</Data>
    </Alert>
    <Final/>
  </SyncBody>
</SyncML>`;

  const parsed = parseSyncML(xml);
  assertEquals(parsed.header.sessionId, "1");
  assertEquals(parsed.header.msgId, "1");
  assertEquals(parsed.header.target, "https://mdm.example.com/manage/dev-001");
  assertEquals(parsed.header.source, "WIN-DEV-001-GUID");
  assertEquals(parsed.alerts.length, 1);
  assertEquals(parsed.alerts[0].data, "1201");
  assertEquals(parsed.alerts[0].cmdId, "2");
  assertEquals(parsed.statuses.length, 0);
  assertEquals(parsed.hasFinal, true);
});

Deno.test("parseSyncML: Status 區塊（對伺服器命令的回應）", () => {
  const xml = `<SyncML>
  <SyncHdr>
    <SessionID>3</SessionID>
    <MsgID>2</MsgID>
    <Target><LocURI>https://mdm/manage/d</LocURI></Target>
    <Source><LocURI>DEV</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Status>
      <CmdID>1</CmdID>
      <MsgRef>1</MsgRef>
      <CmdRef>0</CmdRef>
      <Cmd>SyncHdr</Cmd>
      <Data>200</Data>
    </Status>
    <Status>
      <CmdID>2</CmdID>
      <MsgRef>1</MsgRef>
      <CmdRef>3</CmdRef>
      <Cmd>Exec</Cmd>
      <Data>200</Data>
    </Status>
    <Final/>
  </SyncBody>
</SyncML>`;
  const parsed = parseSyncML(xml);
  assertEquals(parsed.statuses.length, 2);
  assertEquals(parsed.statuses[1].cmd, "Exec");
  assertEquals(parsed.statuses[1].cmdRef, "3");
  assertEquals(parsed.statuses[1].data, "200");
});

Deno.test("parseSyncML: Get 命令的 Results 回應", () => {
  const xml = `<SyncML>
  <SyncHdr>
    <SessionID>5</SessionID><MsgID>3</MsgID>
    <Target><LocURI>https://mdm</LocURI></Target>
    <Source><LocURI>DEV</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Results>
      <CmdID>4</CmdID>
      <MsgRef>2</MsgRef>
      <CmdRef>5</CmdRef>
      <Item>
        <Source><LocURI>./Vendor/MSFT/DeviceStatus/OS/Edition</LocURI></Source>
        <Meta><Format xmlns="syncml:metinf">int</Format></Meta>
        <Data>48</Data>
      </Item>
    </Results>
    <Final/>
  </SyncBody>
</SyncML>`;
  const parsed = parseSyncML(xml);
  assertEquals(parsed.results.length, 1);
  assertEquals(parsed.results[0].source, "./Vendor/MSFT/DeviceStatus/OS/Edition");
  assertEquals(parsed.results[0].data, "48");
  assertEquals(parsed.results[0].format, "int");
  assertEquals(parsed.results[0].cmdRef, "5");
});

Deno.test("parseSyncML: XML 特殊字元 unescape", () => {
  const xml = `<SyncML>
  <SyncHdr>
    <SessionID>1</SessionID><MsgID>1</MsgID>
    <Target><LocURI>https://x.com/path?a=1&amp;b=2</LocURI></Target>
    <Source><LocURI>DEV</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Status><CmdID>1</CmdID><MsgRef>1</MsgRef><CmdRef>0</CmdRef><Cmd>SyncHdr</Cmd><Data>error: &lt;not found&gt;</Data></Status>
    <Final/>
  </SyncBody>
</SyncML>`;
  const parsed = parseSyncML(xml);
  assertEquals(parsed.header.target, "https://x.com/path?a=1&b=2");
  assertEquals(parsed.statuses[0].data, "error: <not found>");
});

// ============================================================
// buildSyncML
// ============================================================

Deno.test("buildSyncML: 空回應只含 SyncHdr Status + Final", () => {
  const result = buildSyncML({
    sessionId: "1",
    msgId: "1",
    deviceId: "WIN-DEV-001-GUID",
    managementUrl: "https://mdm.example.com/manage/dev-001",
    hdrStatus: { msgRef: "1", data: "200" },
  });

  // 來回解析驗證結構
  const parsed = parseSyncML(result.xml);
  assertEquals(parsed.header.sessionId, "1");
  assertEquals(parsed.header.msgId, "1");
  assertEquals(parsed.header.target, "WIN-DEV-001-GUID");
  assertEquals(parsed.header.source, "https://mdm.example.com/manage/dev-001");
  assertEquals(parsed.statuses.length, 1);
  assertEquals(parsed.statuses[0].cmd, "SyncHdr");
  assertEquals(parsed.statuses[0].data, "200");
  assertEquals(parsed.statuses[0].cmdId, "1");
  assertEquals(parsed.hasFinal, true);

  // 元數據
  assertEquals(result.hdrStatusCmdId, "1");
  assertEquals(result.statusCmdIds, []);
  assertEquals(result.commandCmdIds, []);
});

Deno.test("buildSyncML: 帶 Exec 命令", () => {
  const result = buildSyncML({
    sessionId: "2",
    msgId: "1",
    deviceId: "DEV",
    managementUrl: "https://mdm/manage/d",
    hdrStatus: { msgRef: "1", data: "200" },
    commands: [
      {
        cmdId: "ignored",
        verb: "Exec",
        target: "./Device/Vendor/MSFT/RemoteWipe/doWipe",
      },
    ],
  });

  // 命令在 XML 中正確序列化
  const hasExec = result.xml.includes("<Exec>");
  const hasTarget = result.xml.includes(
    "./Device/Vendor/MSFT/RemoteWipe/doWipe"
  );
  assertEquals(hasExec, true);
  assertEquals(hasTarget, true);

  // CmdID 由 buildSyncML 自動分配（hdrStatus=1, exec=2）
  const cmdIdMatch = result.xml.match(/<Exec>\s*<CmdID>(\d+)<\/CmdID>/);
  assertExists(cmdIdMatch);
  assertEquals(cmdIdMatch[1], "2");
  // 元數據對齊 XML 中的真實值
  assertEquals(result.commandCmdIds, ["2"]);
});

Deno.test("buildSyncML: 帶 Replace 命令含 Format/Data", () => {
  const result = buildSyncML({
    sessionId: "3",
    msgId: "1",
    deviceId: "DEV",
    managementUrl: "https://mdm/m",
    hdrStatus: { msgRef: "1", data: "200" },
    commands: [
      {
        cmdId: "x",
        verb: "Replace",
        target: "./Device/Vendor/MSFT/Policy/Config/Update/AllowAutoUpdate",
        format: "int",
        data: "1",
      },
    ],
  });

  assertEquals(result.xml.includes("<Replace>"), true);
  assertEquals(result.xml.includes("<Data>1</Data>"), true);
  assertEquals(
    result.xml.includes('<Format xmlns="syncml:metinf">int</Format>'),
    true
  );
});

Deno.test("buildSyncML: 特殊字元正確 escape（建好可被 parse 還原）", () => {
  const tricky = "https://x.com/path?a=1&b=2<test>";
  const result = buildSyncML({
    sessionId: "1",
    msgId: "1",
    deviceId: "DEV",
    managementUrl: tricky,
    hdrStatus: { msgRef: "1", data: "200" },
  });
  // XML 中應為 escape 後的字元
  assertEquals(result.xml.includes("&amp;"), true);
  assertEquals(result.xml.includes("&lt;test&gt;"), true);
  // 解析後還原
  const parsed = parseSyncML(result.xml);
  assertEquals(parsed.header.source, tricky);
});

Deno.test("buildSyncML: 多個 Status + 多個命令的 CmdID 連續分配", () => {
  const result = buildSyncML({
    sessionId: "4",
    msgId: "2",
    deviceId: "DEV",
    managementUrl: "https://mdm/m",
    hdrStatus: { msgRef: "2", data: "200" },
    statuses: [
      {
        cmdId: "x",
        msgRef: "2",
        cmdRef: "5",
        cmd: "Alert",
        data: "200",
      },
    ],
    commands: [
      { cmdId: "x", verb: "Get", target: "./DevDetail/SwV" },
      { cmdId: "x", verb: "Exec", target: "./Vendor/MSFT/RemoteWipe/doWipe" },
    ],
  });
  // CmdID 應為 1=SyncHdr Status, 2=Alert Status, 3=Get, 4=Exec
  const ids = [...result.xml.matchAll(/<CmdID>(\d+)<\/CmdID>/g)].map((m) => m[1]);
  assertEquals(ids, ["1", "2", "3", "4"]);
  // 元數據與 XML 中順序對齊
  assertEquals(result.hdrStatusCmdId, "1");
  assertEquals(result.statusCmdIds, ["2"]);
  assertEquals(result.commandCmdIds, ["3", "4"]);
});

Deno.test("buildSyncML: 元數據對齊 XML（多 status + 多 command 完整斷言）", () => {
  // 模擬 command.ts 真實會用到的場景：給多條 inFlight 對映寫入元數據
  const result = buildSyncML({
    sessionId: "9",
    msgId: "3",
    deviceId: "DEV",
    managementUrl: "https://mdm/m",
    hdrStatus: { msgRef: "3", data: "200" },
    statuses: [
      { cmdId: "x", msgRef: "3", cmdRef: "5", cmd: "Alert", data: "200" },
      { cmdId: "x", msgRef: "3", cmdRef: "7", cmd: "Replace", data: "200" },
    ],
    commands: [
      { cmdId: "x", verb: "Get", target: "./A" },
      { cmdId: "x", verb: "Exec", target: "./B" },
      { cmdId: "x", verb: "Replace", target: "./C", data: "v" },
    ],
  });

  // 從 XML 還原各 command 的真實 CmdID，驗證元數據準確
  const parsed = parseSyncML(result.xml);
  // hdrStatus 1 + 2 個業務 status = 3 條 status
  assertEquals(parsed.statuses.length, 3);
  assertEquals(parsed.statuses[1].cmdId, result.statusCmdIds[0]);
  assertEquals(parsed.statuses[2].cmdId, result.statusCmdIds[1]);
  // 從 XML 抓 Get/Exec/Replace 的 CmdID
  const getId = result.xml.match(/<Get>\s*<CmdID>(\d+)<\/CmdID>/)?.[1];
  const execId = result.xml.match(/<Exec>\s*<CmdID>(\d+)<\/CmdID>/)?.[1];
  const replaceId = result.xml.match(/<Replace>\s*<CmdID>(\d+)<\/CmdID>/)?.[1];
  assertEquals(getId, result.commandCmdIds[0]);
  assertEquals(execId, result.commandCmdIds[1]);
  assertEquals(replaceId, result.commandCmdIds[2]);
});
