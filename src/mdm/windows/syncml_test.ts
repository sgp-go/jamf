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
  const xml = buildSyncML({
    sessionId: "1",
    msgId: "1",
    deviceId: "WIN-DEV-001-GUID",
    managementUrl: "https://mdm.example.com/manage/dev-001",
    hdrStatus: { msgRef: "1", data: "200" },
  });

  // 來回解析驗證結構
  const parsed = parseSyncML(xml);
  assertEquals(parsed.header.sessionId, "1");
  assertEquals(parsed.header.msgId, "1");
  assertEquals(parsed.header.target, "WIN-DEV-001-GUID");
  assertEquals(parsed.header.source, "https://mdm.example.com/manage/dev-001");
  assertEquals(parsed.statuses.length, 1);
  assertEquals(parsed.statuses[0].cmd, "SyncHdr");
  assertEquals(parsed.statuses[0].data, "200");
  assertEquals(parsed.statuses[0].cmdId, "1");
  assertEquals(parsed.hasFinal, true);
});

Deno.test("buildSyncML: 帶 Exec 命令", () => {
  const xml = buildSyncML({
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
  const hasExec = xml.includes("<Exec>");
  const hasTarget = xml.includes("./Device/Vendor/MSFT/RemoteWipe/doWipe");
  assertEquals(hasExec, true);
  assertEquals(hasTarget, true);

  // CmdID 由 buildSyncML 自動分配（hdrStatus=1, exec=2）
  const cmdIdMatch = xml.match(/<Exec>\s*<CmdID>(\d+)<\/CmdID>/);
  assertExists(cmdIdMatch);
  assertEquals(cmdIdMatch[1], "2");
});

Deno.test("buildSyncML: 帶 Replace 命令含 Format/Data", () => {
  const xml = buildSyncML({
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

  assertEquals(xml.includes("<Replace>"), true);
  assertEquals(xml.includes("<Data>1</Data>"), true);
  assertEquals(
    xml.includes('<Format xmlns="syncml:metinf">int</Format>'),
    true
  );
});

Deno.test("buildSyncML: 特殊字元正確 escape（建好可被 parse 還原）", () => {
  const tricky = "https://x.com/path?a=1&b=2<test>";
  const xml = buildSyncML({
    sessionId: "1",
    msgId: "1",
    deviceId: "DEV",
    managementUrl: tricky,
    hdrStatus: { msgRef: "1", data: "200" },
  });
  // XML 中應為 escape 後的字元
  assertEquals(xml.includes("&amp;"), true);
  assertEquals(xml.includes("&lt;test&gt;"), true);
  // 解析後還原
  const parsed = parseSyncML(xml);
  assertEquals(parsed.header.source, tricky);
});

Deno.test("buildSyncML: 多個 Status + 多個命令的 CmdID 連續分配", () => {
  const xml = buildSyncML({
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
  const ids = [...xml.matchAll(/<CmdID>(\d+)<\/CmdID>/g)].map((m) => m[1]);
  assertEquals(ids, ["1", "2", "3", "4"]);
});
