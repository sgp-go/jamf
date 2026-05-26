import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildRemoteWipe,
  buildMsixInstall,
  buildMsixInstallAddNode,
  buildMsixUpdate,
  buildUpdateScan,
  buildAppInventoryConfig,
  buildAppInventoryFetch,
  buildMsixUninstall,
  buildSetPollInterval,
  buildRegistrySet,
  buildRegistrySetBatch,
  buildRegistryGet,
  buildRegistryDelete,
} from "./csp.ts";

Deno.test("buildRemoteWipe: 預設 doWipe", () => {
  const cmd = buildRemoteWipe();
  assertEquals(cmd.verb, "Exec");
  assertEquals(cmd.target, "./Device/Vendor/MSFT/RemoteWipe/doWipe");
  assertEquals(cmd.data, undefined);
});

Deno.test("buildRemoteWipe: 三種動作各對應獨立 CSP 路徑", () => {
  assertEquals(
    buildRemoteWipe("doWipeProtected").target,
    "./Device/Vendor/MSFT/RemoteWipe/doWipeProtected"
  );
  assertEquals(
    buildRemoteWipe("doWipePersistProvisionedData").target,
    "./Device/Vendor/MSFT/RemoteWipe/doWipePersistProvisionedData"
  );
});

Deno.test("buildMsixInstallAddNode: Add node ./AppInstallation/{PFN} + Format=node", () => {
  const cmd = buildMsixInstallAddNode("AspiraMDM.Demo_cmnaf4m6btwng");
  assertEquals(cmd.verb, "Add");
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/AspiraMDM.Demo_cmnaf4m6btwng"
  );
  assertEquals(cmd.format, "node");
  assertEquals(cmd.data, undefined);
});

Deno.test("buildMsixInstall: HostedInstall 路徑 + Format=xml", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
    contentUri: "https://cdn.example.com/calc.msixbundle",
    hashHex: "abc123",
  });
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/Microsoft.WindowsCalculator_8wekyb3d8bbwe/HostedInstall"
  );
  assertEquals(cmd.verb, "Exec");
  assertEquals(cmd.format, "xml");
});

Deno.test("buildMsixInstall: Data 是 <Application PackageUri=...> 自閉合 (XSD 真實格式)", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "X.Y_z",
    contentUri: "https://cdn.example.com/x.msix",
  });
  const data = cmd.data ?? "";
  assertEquals(
    data,
    '<Application PackageUri="https://cdn.example.com/x.msix" />'
  );
  // 預設無 DeploymentOptions / Dependencies
  assertEquals(data.includes("DeploymentOptions"), false);
  assertEquals(data.includes("Dependencies"), false);
});

Deno.test("buildMsixInstall: install option 折成 DeploymentOptions 位掩碼", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "X.Y_z",
    contentUri: "https://cdn/x.msix",
    forceUpdateToAnyVersion: true, // 0x40
    forceApplicationShutdown: true, // 0x01
    deferRegistration: true, // 0x80
  });
  const data = cmd.data ?? "";
  // 0x40 | 0x01 | 0x80 = 193
  assertEquals(data.includes('DeploymentOptions="193"'), true);
  // 不再有獨立子元素
  assertEquals(data.includes("<ForceUpdateToAnyVersion>"), false);
  assertEquals(data.includes("<ForceApplicationShutdown>"), false);
});

Deno.test("buildMsixInstall: dependencyUris 生成 Dependencies/Dependency 子元素", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "X.Y_z",
    contentUri: "https://cdn/x.msix",
    dependencyUris: ["https://cdn/dep1.msix", "https://cdn/dep2.msix"],
  });
  const data = cmd.data ?? "";
  assertEquals(data.includes("<Dependencies>"), true);
  assertEquals(
    data.includes('<Dependency PackageUri="https://cdn/dep1.msix" />'),
    true
  );
  assertEquals(
    data.includes('<Dependency PackageUri="https://cdn/dep2.msix" />'),
    true
  );
  assertEquals(data.endsWith("</Application>"), true);
});

Deno.test("buildMsixInstall: isLOB=false 拋錯（StoreInstall 未支援）", () => {
  assertThrows(
    () =>
      buildMsixInstall({
        packageFamilyName: "X.Y_z",
        contentUri: "https://cdn/x.msix",
        hashHex: "x",
        isLOB: false,
      }),
    Error,
    "StoreInstall"
  );
});

Deno.test("buildMsixInstall: PackageUri 中 & 字元被 escape", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "X.Y_z",
    contentUri: "https://cdn/x.msix?a=1&b=2",
  });
  const data = cmd.data ?? "";
  assertEquals(data.includes("&amp;"), true);
  assertEquals(/[&](?!amp;|lt;|gt;|quot;|apos;)/.test(data), false);
});

Deno.test("buildMsixUpdate: 自動帶 DeploymentOptions ForceUpdateToAnyVersion 位 (0x40)", () => {
  const cmd = buildMsixUpdate({
    packageFamilyName: "X.Y_z",
    contentUri: "https://cdn/x.msix",
  });
  const data = cmd.data ?? "";
  assertEquals(data.includes('DeploymentOptions="64"'), true); // 0x40 = 64
  assertEquals(cmd.format, "xml");
});

Deno.test("buildUpdateScan: Exec ./Device/.../UpdateScan", () => {
  const cmd = buildUpdateScan();
  assertEquals(cmd.verb, "Exec");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/UpdateScan"
  );
  assertEquals(cmd.data, undefined);
});

Deno.test("buildAppInventoryConfig: 預設 Output=PackageDetails、PackageTypeFilter=Main|Bundle", () => {
  const cmd = buildAppInventoryConfig();
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/AppInventoryQuery"
  );
  assertEquals(cmd.format, "xml");
  // Inventory XML 屬性檢查
  const data = cmd.data ?? "";
  assertEquals(data.includes('Output="PackageDetails"'), true);
  assertEquals(data.includes('PackageTypeFilter="Main|Bundle"'), true);
  // 未指定 Source / Publisher 時不應出現
  assertEquals(data.includes("Source="), false);
  assertEquals(data.includes("Publisher="), false);
});

Deno.test("buildAppInventoryConfig: Source / Publisher / 自訂 Output", () => {
  const cmd = buildAppInventoryConfig({
    output: "PackageNames|RequiresReinstall",
    source: "nonStore",
    packageTypeFilter: "Main",
    publisher: "CN=Aspira",
  });
  const data = cmd.data ?? "";
  assertEquals(data.includes('Output="PackageNames|RequiresReinstall"'), true);
  assertEquals(data.includes('Source="nonStore"'), true);
  assertEquals(data.includes('PackageTypeFilter="Main"'), true);
  assertEquals(data.includes('Publisher="CN=Aspira"'), true);
});

Deno.test("buildAppInventoryFetch: Get AppManagement/AppInventoryResults", () => {
  const cmd = buildAppInventoryFetch();
  assertEquals(cmd.verb, "Get");
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/AppInventoryResults"
  );
});

Deno.test("buildMsixUninstall: Delete + AppStore 路徑", () => {
  const cmd = buildMsixUninstall("Foo.Bar_xyz");
  assertEquals(cmd.verb, "Delete");
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppManagement/AppStore/Foo.Bar_xyz"
  );
});

Deno.test("buildSetPollInterval: 默認 5 條 Replace 路徑 + ProviderID URL encode", () => {
  const cmds = buildSetPollInterval();
  assertEquals(cmds.length, 5);
  // 每條都是 Replace
  for (const c of cmds) {
    assertEquals(c.verb, "Replace");
    assertEquals(c.target.startsWith(
      "./Vendor/MSFT/DMClient/Provider/MS%20DM%20Server/Poll/"
    ), true);
  }
  // 默認值
  assertEquals(cmds[0].target.endsWith("/IntervalForFirstSetOfRetries"), true);
  assertEquals(cmds[0].format, "int");
  assertEquals(cmds[0].data, "5");
  assertEquals(cmds[1].data, "8"); // NumberOfFirstRetries
  assertEquals(cmds[2].data, "15"); // IntervalForRemainingScheduledRetries
  assertEquals(cmds[3].data, "0"); // NumberOfRemainingScheduledRetries=0=infinite
  assertEquals(cmds[4].format, "bool");
  assertEquals(cmds[4].data, "true"); // PollOnLogin
});

Deno.test("buildSetPollInterval: 自訂 ProviderID + 配置", () => {
  const cmds = buildSetPollInterval({
    intervalFirst: 1,
    countFirst: 3,
    intervalRest: 30,
    pollOnLogin: false,
    providerId: "Custom Provider",
  });
  assertEquals(cmds[0].data, "1");
  assertEquals(cmds[1].data, "3");
  assertEquals(cmds[2].data, "30");
  assertEquals(cmds[4].data, "false");
  assertEquals(
    cmds[0].target.includes("/Provider/Custom%20Provider/Poll/"),
    true
  );
});

// ============================================================
// Registry CSP
// ============================================================

Deno.test("buildRegistrySet: string value 走 Format=chr，路徑反斜杠正規化為斜杠", () => {
  const cmd = buildRegistrySet({
    hive: "HKLM",
    path: "SOFTWARE\\Policies\\CoGrowMDM\\Agent",
    entry: { name: "device_id", type: "string", value: "windows-abc-123" },
  });
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Registry/HKLM/SOFTWARE/Policies/CoGrowMDM/Agent/device_id"
  );
  assertEquals(cmd.format, "chr");
  assertEquals(cmd.data, "windows-abc-123");
});

Deno.test("buildRegistrySet: int value 走 Format=int", () => {
  const cmd = buildRegistrySet({
    hive: "HKLM",
    path: "SOFTWARE/Policies/CoGrowMDM/Agent",
    entry: { name: "report_interval", type: "int", value: 86400 },
  });
  assertEquals(cmd.format, "int");
  assertEquals(cmd.data, "86400");
});

Deno.test("buildRegistrySet: binary value 走 Format=b64 + base64 編碼", () => {
  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const cmd = buildRegistrySet({
    hive: "HKLM",
    path: "SOFTWARE/CoGrow/Agent",
    entry: { name: "raw_blob", type: "binary", value: bytes },
  });
  assertEquals(cmd.format, "b64");
  assertEquals(cmd.data, "3q2+7w==");
});

Deno.test("buildRegistrySet: expandString 等同 string，Format=chr", () => {
  const cmd = buildRegistrySet({
    hive: "HKLM",
    path: "SOFTWARE/CoGrow/Agent",
    entry: { name: "log_dir", type: "expandString", value: "%APPDATA%\\CoGrow" },
  });
  assertEquals(cmd.format, "chr");
  assertEquals(cmd.data, "%APPDATA%\\CoGrow");
});

Deno.test("buildRegistrySet: int 超出 REG_DWORD 範圍應拋 RangeError", () => {
  assertThrows(
    () =>
      buildRegistrySet({
        hive: "HKLM",
        path: "x",
        entry: { name: "v", type: "int", value: -1 },
      }),
    RangeError
  );
  assertThrows(
    () =>
      buildRegistrySet({
        hive: "HKLM",
        path: "x",
        entry: { name: "v", type: "int", value: 0x100000000 },
      }),
    RangeError
  );
});

Deno.test("buildRegistrySet: 型別不匹配應拋 TypeError", () => {
  assertThrows(
    () =>
      buildRegistrySet({
        hive: "HKLM",
        path: "x",
        entry: { name: "v", type: "int", value: "not-a-number" as unknown as number },
      }),
    TypeError
  );
  assertThrows(
    () =>
      buildRegistrySet({
        hive: "HKLM",
        path: "x",
        entry: { name: "v", type: "binary", value: "not-bytes" as unknown as Uint8Array },
      }),
    TypeError
  );
});

Deno.test("buildRegistrySetBatch: 一個 key 多個 value 各自 Replace", () => {
  const cmds = buildRegistrySetBatch({
    hive: "HKLM",
    path: "SOFTWARE/Policies/CoGrowMDM/Agent",
    entries: [
      { name: "device_id", type: "string", value: "windows-001" },
      { name: "agent_token", type: "string", value: "at_secret_xxx" },
      { name: "api_endpoint", type: "string", value: "https://api.cogrow.com/api/agent/v1" },
      { name: "report_interval_min", type: "int", value: 1440 },
    ],
  });
  assertEquals(cmds.length, 4);
  assertEquals(cmds.every((c) => c.verb === "Replace"), true);
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Registry/HKLM/SOFTWARE/Policies/CoGrowMDM/Agent/device_id"
  );
  assertEquals(cmds[3].format, "int");
  assertEquals(cmds[3].data, "1440");
});

Deno.test("buildRegistryGet: 帶 valueName 指向單一 value", () => {
  const cmd = buildRegistryGet({
    hive: "HKLM",
    path: "SOFTWARE/CoGrow/Agent",
    valueName: "device_id",
  });
  assertEquals(cmd.verb, "Get");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Registry/HKLM/SOFTWARE/CoGrow/Agent/device_id"
  );
  assertEquals(cmd.data, undefined);
});

Deno.test("buildRegistryGet: 不帶 valueName 指向整個 key", () => {
  const cmd = buildRegistryGet({
    hive: "HKLM",
    path: "SOFTWARE/CoGrow/Agent",
  });
  assertEquals(cmd.target, "./Device/Vendor/MSFT/Registry/HKLM/SOFTWARE/CoGrow/Agent");
});

Deno.test("buildRegistryDelete: 刪單一 value 與刪整 key 各對應不同 target", () => {
  const single = buildRegistryDelete({
    hive: "HKLM",
    path: "SOFTWARE/CoGrow/Agent",
    valueName: "agent_token",
  });
  assertEquals(single.verb, "Delete");
  assertEquals(
    single.target,
    "./Device/Vendor/MSFT/Registry/HKLM/SOFTWARE/CoGrow/Agent/agent_token"
  );

  const whole = buildRegistryDelete({
    hive: "HKLM",
    path: "SOFTWARE/CoGrow/Agent",
  });
  assertEquals(
    whole.target,
    "./Device/Vendor/MSFT/Registry/HKLM/SOFTWARE/CoGrow/Agent"
  );
});

Deno.test("buildRegistry*: 路徑前後多餘斜杠/反斜杠應去除", () => {
  const cmd = buildRegistrySet({
    hive: "HKLM",
    path: "\\\\SOFTWARE/Policies/CoGrowMDM/Agent/\\",
    entry: { name: "x", type: "string", value: "y" },
  });
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Registry/HKLM/SOFTWARE/Policies/CoGrowMDM/Agent/x"
  );
});

Deno.test("buildRegistry*: HKCU / HKU 等其他 hive 支援", () => {
  const hkcu = buildRegistryGet({
    hive: "HKCU",
    path: "SOFTWARE/Test",
    valueName: "v",
  });
  assertEquals(
    hkcu.target,
    "./Device/Vendor/MSFT/Registry/HKCU/SOFTWARE/Test/v"
  );
  const hku = buildRegistryGet({
    hive: "HKU",
    path: ".DEFAULT/Test",
    valueName: "v",
  });
  assertEquals(
    hku.target,
    "./Device/Vendor/MSFT/Registry/HKU/.DEFAULT/Test/v"
  );
});
