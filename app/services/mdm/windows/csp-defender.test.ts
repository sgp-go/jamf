import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildDefenderEnforce,
  buildDefenderEnforceAll,
  buildDefenderHealthQuery,
} from "./csp-defender.ts";

Deno.test("buildDefenderEnforce: 空輸入回傳空陣列（不下任何命令）", () => {
  assertEquals(buildDefenderEnforce({}), []);
});

Deno.test("buildDefenderEnforce: realtimeMonitoring=true 對應 AllowRealtimeMonitoring=1 int", () => {
  const cmds = buildDefenderEnforce({ realtimeMonitoring: true });
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Defender/AllowRealtimeMonitoring",
  );
  assertEquals(cmds[0].format, "int");
  assertEquals(cmds[0].data, "1");
});

Deno.test("buildDefenderEnforce: realtimeMonitoring=false 對應 0", () => {
  const cmds = buildDefenderEnforce({ realtimeMonitoring: false });
  assertEquals(cmds[0].data, "0");
});

Deno.test("buildDefenderEnforce: 多個 bool 防護一次寫入", () => {
  const cmds = buildDefenderEnforce({
    behaviorMonitoring: true,
    cloudProtection: true,
    ioavProtection: false,
  });
  assertEquals(cmds.length, 3);
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Defender/AllowBehaviorMonitoring",
  );
  assertEquals(cmds[0].data, "1");
  assertEquals(
    cmds[1].target,
    "./Device/Vendor/MSFT/Policy/Config/Defender/AllowCloudProtection",
  );
  assertEquals(cmds[1].data, "1");
  assertEquals(
    cmds[2].target,
    "./Device/Vendor/MSFT/Policy/Config/Defender/AllowIOAVProtection",
  );
  assertEquals(cmds[2].data, "0");
});

Deno.test("buildDefenderEnforce: networkProtection=1 (block) 對應 EnableNetworkProtection int", () => {
  const cmds = buildDefenderEnforce({ networkProtection: 1 });
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Defender/EnableNetworkProtection",
  );
  assertEquals(cmds[0].format, "int");
  assertEquals(cmds[0].data, "1");
});

Deno.test("buildDefenderEnforce: puaProtection=2 (audit)", () => {
  const cmds = buildDefenderEnforce({ puaProtection: 2 });
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Defender/PUAProtection",
  );
  assertEquals(cmds[0].data, "2");
});

Deno.test("buildDefenderEnforce: submitSamplesConsent=3 (Send all)", () => {
  const cmds = buildDefenderEnforce({ submitSamplesConsent: 3 });
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Defender/SubmitSamplesConsent",
  );
  assertEquals(cmds[0].data, "3");
});

Deno.test("buildDefenderEnforceAll: 7 條全開命令", () => {
  const cmds = buildDefenderEnforceAll();
  assertEquals(cmds.length, 7);
  const targets = cmds.map((c) => c.target);
  assertEquals(targets, [
    "./Device/Vendor/MSFT/Policy/Config/Defender/AllowRealtimeMonitoring",
    "./Device/Vendor/MSFT/Policy/Config/Defender/AllowBehaviorMonitoring",
    "./Device/Vendor/MSFT/Policy/Config/Defender/AllowCloudProtection",
    "./Device/Vendor/MSFT/Policy/Config/Defender/AllowIOAVProtection",
    "./Device/Vendor/MSFT/Policy/Config/Defender/EnableNetworkProtection",
    "./Device/Vendor/MSFT/Policy/Config/Defender/PUAProtection",
    "./Device/Vendor/MSFT/Policy/Config/Defender/SubmitSamplesConsent",
  ]);
  assertEquals(
    cmds.map((c) => c.data),
    ["1", "1", "1", "1", "1", "1", "1"],
  );
});

Deno.test("buildDefenderHealthQuery: 預設套餐含 9 個節點", () => {
  const cmds = buildDefenderHealthQuery();
  assertEquals(cmds.length, 9);
  for (const c of cmds) {
    assertEquals(c.verb, "Get");
    assertEquals(c.target.startsWith("./Device/Vendor/MSFT/Defender/Health/"), true);
  }
});

Deno.test("buildDefenderHealthQuery: ProductStatus LocURI 與 verb=Get", () => {
  const cmds = buildDefenderHealthQuery(["ProductStatus"]);
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Get");
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Defender/Health/ProductStatus",
  );
  // Get 命令不帶 format / data
  assertEquals(cmds[0].format, undefined);
  assertEquals(cmds[0].data, undefined);
});

Deno.test("buildDefenderHealthQuery: 多個自訂節點順序保留", () => {
  const cmds = buildDefenderHealthQuery(["SignatureVersion", "EngineVersion"]);
  assertEquals(
    cmds.map((c) => c.target),
    [
      "./Device/Vendor/MSFT/Defender/Health/SignatureVersion",
      "./Device/Vendor/MSFT/Defender/Health/EngineVersion",
    ],
  );
});

Deno.test("buildDefenderHealthQuery: 空 nodes 拋錯", () => {
  assertThrows(() => buildDefenderHealthQuery([]), Error);
});
