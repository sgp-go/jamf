import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildDeviceInstallPolicy,
  buildDeviceInstallPolicyClear,
  COMMON_DEVICE_CLASSES,
} from "./csp-device-install.ts";

const SEP = "";

Deno.test("buildDeviceInstallPolicy: 空輸入回空陣列", () => {
  assertEquals(buildDeviceInstallPolicy({}), []);
});

Deno.test("buildDeviceInstallPolicy: blockedClasses 單 GUID 完整編碼（含 Retroactive=false）", () => {
  const cmds = buildDeviceInstallPolicy({
    blockedClasses: [COMMON_DEVICE_CLASSES.USB],
  });
  assertEquals(cmds.length, 1);
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/DeviceInstallation/PreventInstallationOfMatchingDeviceSetupClasses",
  );
  assertEquals(cmds[0].format, "chr");
  // ⭐ Retroactive 元素永遠存在（即使 false）— ADMX schema 要求
  assertEquals(
    cmds[0].data,
    `<enabled/><data id="DeviceInstall_Classes_Deny_Retroactive" value="false"/><data id="DeviceInstall_Classes_Deny_List" value="1${SEP}{36fc9e60-c465-11cf-8056-444553540000}"/>`,
  );
});

Deno.test("buildDeviceInstallPolicy: applyRetroactive=true 對應 value=\"true\"", () => {
  const cmds = buildDeviceInstallPolicy({
    blockedClasses: [COMMON_DEVICE_CLASSES.USB],
    applyRetroactive: true,
  });
  assertEquals(
    cmds[0].data,
    `<enabled/><data id="DeviceInstall_Classes_Deny_Retroactive" value="true"/><data id="DeviceInstall_Classes_Deny_List" value="1${SEP}{36fc9e60-c465-11cf-8056-444553540000}"/>`,
  );
});

Deno.test("buildDeviceInstallPolicy: 多 GUID index 遞增 + U+F000 分隔", () => {
  const cmds = buildDeviceInstallPolicy({
    blockedClasses: [COMMON_DEVICE_CLASSES.USB, COMMON_DEVICE_CLASSES.BLUETOOTH],
  });
  assertEquals(
    cmds[0].data,
    `<enabled/><data id="DeviceInstall_Classes_Deny_Retroactive" value="false"/><data id="DeviceInstall_Classes_Deny_List" value="1${SEP}{36fc9e60-c465-11cf-8056-444553540000}${SEP}2${SEP}{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}"/>`,
  );
});

Deno.test("buildDeviceInstallPolicy: 無花括號 GUID 自動包上 {}", () => {
  const cmds = buildDeviceInstallPolicy({
    blockedClasses: ["36fc9e60-c465-11cf-8056-444553540000"],
  });
  assertEquals(
    (cmds[0].data ?? "").includes("{36fc9e60-c465-11cf-8056-444553540000}"),
    true,
  );
});

Deno.test("buildDeviceInstallPolicy: blockedHardwareIds 對應 IDs target", () => {
  const cmds = buildDeviceInstallPolicy({
    blockedHardwareIds: ["USB\\Composite", "USB\\Class_FF"],
  });
  assertEquals(cmds.length, 1);
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/DeviceInstallation/PreventInstallationOfMatchingDeviceIDs",
  );
  assertEquals(
    cmds[0].data,
    `<enabled/><data id="DeviceInstall_IDs_Deny_Retroactive" value="false"/><data id="DeviceInstall_IDs_Deny_List" value="1${SEP}USB\\Composite${SEP}2${SEP}USB\\Class_FF"/>`,
  );
});

Deno.test("buildDeviceInstallPolicy: blockRemovableDevices=true 只用 <enabled/> 無 list", () => {
  const cmds = buildDeviceInstallPolicy({ blockRemovableDevices: true });
  assertEquals(cmds.length, 1);
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/DeviceInstallation/PreventInstallationOfRemovableDevices",
  );
  assertEquals(cmds[0].data, `<enabled/>`);
});

Deno.test("buildDeviceInstallPolicy: 三種同時，回 3 條命令", () => {
  const cmds = buildDeviceInstallPolicy({
    blockedClasses: [COMMON_DEVICE_CLASSES.USB],
    blockedHardwareIds: ["USB\\Composite"],
    blockRemovableDevices: true,
  });
  assertEquals(cmds.length, 3);
});

Deno.test("buildDeviceInstallPolicy: 含 U+F000 分隔字元拋錯", () => {
  assertThrows(() =>
    buildDeviceInstallPolicy({
      blockedHardwareIds: [`bad${SEP}injected`],
    })
  );
});

Deno.test("buildDeviceInstallPolicy: GUID 不完整（只有半個花括號）拋錯", () => {
  assertThrows(() =>
    buildDeviceInstallPolicy({
      blockedClasses: ["{incomplete"],
    })
  );
});

Deno.test("buildDeviceInstallPolicyClear: 三 target 都送 <disabled/>", () => {
  const cmds = buildDeviceInstallPolicyClear();
  assertEquals(cmds.length, 3);
  for (const c of cmds) {
    assertEquals(c.verb, "Replace");
    assertEquals(c.data, `<disabled/>`);
  }
  // target 覆蓋三種
  const targets = cmds.map((c) => c.target).sort();
  assertEquals(targets[0].endsWith("PreventInstallationOfMatchingDeviceIDs"), true);
  assertEquals(targets[1].endsWith("PreventInstallationOfMatchingDeviceSetupClasses"), true);
  assertEquals(targets[2].endsWith("PreventInstallationOfRemovableDevices"), true);
});
