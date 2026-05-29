import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildReboot,
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
  buildMsiInstall,
  buildMsiUninstall,
  buildMsiStatusQuery,
  buildMsiLastErrorQuery,
  buildMsiLastErrorDescQuery,
  buildWiFiProfile,
  buildWiFiRemove,
  buildPasswordPolicy,
  buildUsbPolicy,
  buildAppLockerPolicy,
  APPLOCKER_SID_EVERYONE,
  buildPersonalization,
  buildPersonalizationStatusQuery,
  buildLockState,
  buildLockAdmxInstall,
} from "./csp.ts";

Deno.test("buildRemoteWipe: 預設 doWipe", () => {
  const cmd = buildRemoteWipe();
  assertEquals(cmd.verb, "Exec");
  assertEquals(cmd.target, "./Device/Vendor/MSFT/RemoteWipe/doWipe");
  assertEquals(cmd.data, undefined);
});

Deno.test("buildReboot: 預設 RebootNow", () => {
  const cmd = buildReboot();
  assertEquals(cmd.verb, "Exec");
  assertEquals(cmd.target, "./Device/Vendor/MSFT/Reboot/RebootNow");
  assertEquals(cmd.data, undefined);
});

Deno.test("buildReboot: ScheduleSingle 帶 ISO 時間", () => {
  const cmd = buildReboot("ScheduleSingle", "2026-06-01T02:00:00Z");
  assertEquals(cmd.target, "./Device/Vendor/MSFT/Reboot/Schedule/Single");
  assertEquals(cmd.format, "chr");
  assertEquals(cmd.data, "2026-06-01T02:00:00Z");
});

Deno.test("buildReboot: ScheduleSingle 無時間參數拋錯", () => {
  assertThrows(() => buildReboot("ScheduleSingle"), Error);
});

Deno.test("buildReboot: ScheduleDailyRecurrent", () => {
  const cmd = buildReboot("ScheduleDailyRecurrent", "02:00:00");
  assertEquals(cmd.target, "./Device/Vendor/MSFT/Reboot/Schedule/DailyRecurrent");
  assertEquals(cmd.data, "02:00:00");
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

// ============================================================
// EnterpriseDesktopAppManagement (.msi 派發)
// ============================================================

const SAMPLE_PRODUCT_ID = "{B91CF9B4-1234-5678-9ABC-DEF012345678}";
const SAMPLE_MSI_URI = "https://cdn.cogrow.com/agents/agent-1.0.0.msi";

Deno.test("buildMsiInstall: Add /DownloadInstall + Format=chr", () => {
  const cmd = buildMsiInstall({
    productId: SAMPLE_PRODUCT_ID,
    productVersion: "1.0.0.0",
    contentUri: SAMPLE_MSI_URI,
    fileHashHex: "abc123def456",
  });
  assertEquals(cmd.verb, "Add");
  assertEquals(cmd.format, "chr");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/EnterpriseDesktopAppManagement/MSI/%7BB91CF9B4-1234-5678-9ABC-DEF012345678%7D/DownloadInstall"
  );
});

Deno.test("buildMsiInstall: MsiInstallJob XML 結構符合 spec", () => {
  const cmd = buildMsiInstall({
    productId: SAMPLE_PRODUCT_ID,
    productVersion: "1.0.0.0",
    contentUri: SAMPLE_MSI_URI,
    fileHashHex: "deadbeef",
  });
  const data = cmd.data ?? "";
  assertEquals(data.startsWith("<MsiInstallJob "), true);
  // id 屬性帶 ProductCode（含大括號）
  assertEquals(
    data.includes(`id="${SAMPLE_PRODUCT_ID}"`),
    true
  );
  assertEquals(
    data.includes(`<Product Version="1.0.0.0">`),
    true
  );
  assertEquals(
    data.includes(`<ContentURL>${SAMPLE_MSI_URI}</ContentURL>`),
    true
  );
  assertEquals(data.includes("<Validation><FileHash>deadbeef</FileHash></Validation>"), true);
  // 預設 enforcement
  assertEquals(data.includes("<CommandLine>/quiet /norestart</CommandLine>"), true);
  assertEquals(data.includes("<TimeOut>10</TimeOut>"), true);
  assertEquals(data.includes("<RetryCount>3</RetryCount>"), true);
  assertEquals(data.includes("<RetryInterval>5</RetryInterval>"), true);
});

Deno.test("buildMsiInstall: 不帶 fileHashHex 時 Validation 元素省略", () => {
  const cmd = buildMsiInstall({
    productId: SAMPLE_PRODUCT_ID,
    productVersion: "1.0.0.0",
    contentUri: SAMPLE_MSI_URI,
  });
  assertEquals((cmd.data ?? "").includes("<Validation>"), false);
});

Deno.test("buildMsiInstall: 自訂 commandLine / timeOut / retry 覆蓋預設", () => {
  const cmd = buildMsiInstall({
    productId: SAMPLE_PRODUCT_ID,
    productVersion: "2.0",
    contentUri: SAMPLE_MSI_URI,
    commandLine: "/passive /norestart ALLUSERS=1",
    timeOutMinutes: 30,
    retryCount: 5,
    retryIntervalMinutes: 2,
  });
  const data = cmd.data ?? "";
  assertEquals(
    data.includes("<CommandLine>/passive /norestart ALLUSERS=1</CommandLine>"),
    true
  );
  assertEquals(data.includes("<TimeOut>30</TimeOut>"), true);
  assertEquals(data.includes("<RetryCount>5</RetryCount>"), true);
  assertEquals(data.includes("<RetryInterval>2</RetryInterval>"), true);
});

Deno.test("buildMsiInstall: ProductCode 自動轉大寫並補大括號", () => {
  const cmd = buildMsiInstall({
    productId: "b91cf9b4-1234-5678-9abc-def012345678", // 小寫、無大括號
    productVersion: "1.0",
    contentUri: SAMPLE_MSI_URI,
  });
  // LocURI 中是 URL encoded 帶大括號
  assertEquals(
    cmd.target.includes("%7BB91CF9B4-1234-5678-9ABC-DEF012345678%7D"),
    true
  );
  // XML id 也應大寫帶括號
  assertEquals(
    (cmd.data ?? "").includes('id="{B91CF9B4-1234-5678-9ABC-DEF012345678}"'),
    true
  );
});

Deno.test("buildMsiInstall: contentUri 含 & 字元應 XML escape", () => {
  const cmd = buildMsiInstall({
    productId: SAMPLE_PRODUCT_ID,
    productVersion: "1.0",
    contentUri: "https://cdn.example.com/file.msi?token=a&sig=b",
  });
  // & 在 <ContentURL> text 內必須 escape
  assertEquals((cmd.data ?? "").includes("token=a&amp;sig=b"), true);
});

Deno.test("buildMsiInstall: installContext=User 路徑改 ./User", () => {
  const cmd = buildMsiInstall({
    productId: SAMPLE_PRODUCT_ID,
    productVersion: "1.0",
    contentUri: SAMPLE_MSI_URI,
    installContext: "User",
  });
  assertEquals(cmd.target.startsWith("./User/Vendor/MSFT/"), true);
});

Deno.test("buildMsiInstall: 非法 ProductCode 拋 TypeError", () => {
  assertThrows(
    () =>
      buildMsiInstall({
        productId: "not-a-guid",
        productVersion: "1.0",
        contentUri: SAMPLE_MSI_URI,
      }),
    TypeError
  );
});

Deno.test("buildMsiUninstall: Exec /{ProductID}/Uninstall", () => {
  const cmd = buildMsiUninstall(SAMPLE_PRODUCT_ID);
  assertEquals(cmd.verb, "Exec");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/EnterpriseDesktopAppManagement/MSI/%7BB91CF9B4-1234-5678-9ABC-DEF012345678%7D/Uninstall"
  );
  assertEquals(cmd.data, undefined);
});

Deno.test("buildMsiStatusQuery: Get /{ProductID}/Status", () => {
  const cmd = buildMsiStatusQuery(SAMPLE_PRODUCT_ID);
  assertEquals(cmd.verb, "Get");
  assertEquals(cmd.target.endsWith("/Status"), true);
  assertEquals(cmd.data, undefined);
});

Deno.test("buildMsiLastErrorQuery / buildMsiLastErrorDescQuery: Get /LastError(Desc)", () => {
  const err = buildMsiLastErrorQuery(SAMPLE_PRODUCT_ID);
  assertEquals(err.verb, "Get");
  assertEquals(err.target.endsWith("/LastError"), true);

  const desc = buildMsiLastErrorDescQuery(SAMPLE_PRODUCT_ID);
  assertEquals(desc.target.endsWith("/LastErrorDesc"), true);
});

Deno.test("buildMsiUninstall / Status / LastError: User context 切換到 ./User 路徑", () => {
  assertEquals(
    buildMsiUninstall(SAMPLE_PRODUCT_ID, "User").target.startsWith("./User/"),
    true
  );
  assertEquals(
    buildMsiStatusQuery(SAMPLE_PRODUCT_ID, "User").target.startsWith("./User/"),
    true
  );
  assertEquals(
    buildMsiLastErrorQuery(SAMPLE_PRODUCT_ID, "User").target.startsWith("./User/"),
    true
  );
});

// ============================================================
// WiFi Profile
// ============================================================

Deno.test("buildWiFiProfile: open auth 基本結構", () => {
  const cmd = buildWiFiProfile({ ssid: "GuestNet", auth: { type: "open" } });
  assertEquals(cmd.verb, "Add");
  assertEquals(cmd.target, "./Vendor/MSFT/WiFi/Profile/GuestNet/WlanXml");
  assertEquals(cmd.format, "chr");
  // 預設 autoConnect=true（connectionMode=auto），nonBroadcast=false
  assertEquals(cmd.data?.includes("<authentication>open</authentication>"), true);
  assertEquals(cmd.data?.includes("<encryption>none</encryption>"), true);
  assertEquals(cmd.data?.includes("<connectionMode>auto</connectionMode>"), true);
  assertEquals(cmd.data?.includes("<nonBroadcast>false</nonBroadcast>"), true);
  // open 模式無 sharedKey
  assertEquals(cmd.data?.includes("<sharedKey>"), false);
});

Deno.test("buildWiFiProfile: WPA2PSK 含 sharedKey + AES", () => {
  const cmd = buildWiFiProfile({
    ssid: "SchoolWiFi",
    auth: { type: "WPA2PSK", password: "p@ss-w0rd" },
  });
  assertEquals(cmd.data?.includes("<authentication>WPA2PSK</authentication>"), true);
  assertEquals(cmd.data?.includes("<encryption>AES</encryption>"), true);
  assertEquals(cmd.data?.includes("<keyMaterial>p@ss-w0rd</keyMaterial>"), true);
  assertEquals(cmd.data?.includes("<keyType>passPhrase</keyType>"), true);
});

Deno.test("buildWiFiProfile: SSID/密碼含 XML 特殊字元正確 escape", () => {
  const cmd = buildWiFiProfile({
    ssid: "Net <A&B>",
    auth: { type: "WPA2PSK", password: "p&w<x>" },
  });
  // XML 內 escape 防破壞 profile 結構（< > & 轉為實體）
  assertEquals(cmd.data?.includes("Net &lt;A&amp;B&gt;"), true);
  assertEquals(cmd.data?.includes("<keyMaterial>p&amp;w&lt;x&gt;</keyMaterial>"), true);
  // LocURI 路徑 URL-encode（空格變 %20，< 變 %3C）
  assertEquals(cmd.target.includes("Net%20%3CA%26B%3E"), true);
});

Deno.test("buildWiFiProfile: nonBroadcast + autoConnect=false", () => {
  const cmd = buildWiFiProfile({
    ssid: "Hidden",
    auth: { type: "open" },
    autoConnect: false,
    nonBroadcast: true,
  });
  assertEquals(cmd.data?.includes("<connectionMode>manual</connectionMode>"), true);
  assertEquals(cmd.data?.includes("<nonBroadcast>true</nonBroadcast>"), true);
});

Deno.test("buildWiFiRemove: Delete + URL-encoded SSID 路徑", () => {
  const cmd = buildWiFiRemove("Net With Space");
  assertEquals(cmd.verb, "Delete");
  assertEquals(cmd.target, "./Vendor/MSFT/WiFi/Profile/Net%20With%20Space");
  assertEquals(cmd.data, undefined);
});

// ============================================================
// 密碼政策（Policy CSP DeviceLock）
// ============================================================

Deno.test("buildPasswordPolicy: enabled=true → 反邏輯 data=0", () => {
  const cmds = buildPasswordPolicy({ enabled: true });
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/DeviceLock/DevicePasswordEnabled",
  );
  assertEquals(cmds[0].format, "int");
  assertEquals(cmds[0].data, "0"); // MS 反邏輯：0=enabled
});

Deno.test("buildPasswordPolicy: enabled=false → data=1（停用密碼）", () => {
  const cmds = buildPasswordPolicy({ enabled: false });
  assertEquals(cmds[0].data, "1");
});

Deno.test("buildPasswordPolicy: 多字段一次設置產出多條 Replace", () => {
  const cmds = buildPasswordPolicy({
    minLength: 8,
    complexity: 3,
    allowSimple: false,
    maxFailedAttempts: 5,
    maxInactivityMinutes: 10,
    history: 5,
    expirationDays: 90,
  });
  assertEquals(cmds.length, 7);
  // 每條都是 Policy CSP DeviceLock Replace int
  for (const c of cmds) {
    assertEquals(c.verb, "Replace");
    assertEquals(c.format, "int");
    assertEquals(
      c.target.startsWith("./Device/Vendor/MSFT/Policy/Config/DeviceLock/"),
      true,
    );
  }
  // 抽查欄位映射
  const findByTarget = (suffix: string) =>
    cmds.find((c) => c.target.endsWith(suffix));
  assertEquals(findByTarget("/MinDevicePasswordLength")?.data, "8");
  assertEquals(findByTarget("/MinDevicePasswordComplexCharacters")?.data, "3");
  assertEquals(findByTarget("/AllowSimpleDevicePassword")?.data, "0");
  assertEquals(findByTarget("/MaxInactivityTimeDeviceLock")?.data, "10");
});

Deno.test("buildPasswordPolicy: 空 input 回空陣列", () => {
  assertEquals(buildPasswordPolicy({}).length, 0);
});

// ============================================================
// USB 存儲管控（Policy CSP Storage）
// ============================================================

Deno.test("buildUsbPolicy: denyWriteAccess=true → data=1", () => {
  const cmds = buildUsbPolicy({ denyWriteAccess: true });
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Storage/RemovableDiskDenyWriteAccess",
  );
  assertEquals(cmds[0].format, "int");
  assertEquals(cmds[0].data, "1");
});

Deno.test("buildUsbPolicy: 讀寫都禁 + 空 input 行為", () => {
  const both = buildUsbPolicy({ denyWriteAccess: true, denyReadAccess: true });
  assertEquals(both.length, 2);
  assertEquals(both[0].data, "1");
  assertEquals(both[1].data, "1");
  assertEquals(
    both[1].target,
    "./Device/Vendor/MSFT/Policy/Config/Storage/RemovableDiskDenyReadAccess",
  );

  assertEquals(buildUsbPolicy({}).length, 0);
});

// ============================================================
// AppLocker
// ============================================================

Deno.test("buildAppLockerPolicy: EXE 路徑 Deny notepad 基本結構", () => {
  const cmd = buildAppLockerPolicy({
    grouping: "default",
    ruleCollection: "EXE",
    rules: [
      {
        type: "path",
        id: "11111111-1111-1111-1111-111111111111",
        name: "Block notepad",
        action: "Deny",
        path: "*\\notepad.exe",
      },
    ],
  });
  assertEquals(cmd.verb, "Add");
  assertEquals(
    cmd.target,
    "./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/Grouping/default/EXE/Policy",
  );
  assertEquals(cmd.format, "chr");
  // LocURI 段名 EXE → XML Type Exe（MS 坑：兩處不同）
  assertEquals(
    cmd.data?.includes('<RuleCollection Type="Exe" EnforcementMode="Enabled">'),
    true,
  );
  assertEquals(cmd.data?.includes('Action="Deny"'), true);
  assertEquals(cmd.data?.includes('Path="*\\notepad.exe"'), true);
  // 預設 SID Everyone
  assertEquals(
    cmd.data?.includes(`UserOrGroupSid="${APPLOCKER_SID_EVERYONE}"`),
    true,
  );
});

Deno.test("buildAppLockerPolicy: LocURI 段名 → XML Type 映射全集", () => {
  const cases: Array<[
    "EXE" | "MSI" | "Script" | "StoreApps" | "DLL",
    string,
  ]> = [
    ["EXE", "Exe"],
    ["MSI", "Msi"],
    ["Script", "Script"],
    ["StoreApps", "Appx"], // 注意 LocURI StoreApps ≠ XML Appx
    ["DLL", "Dll"],
  ];
  for (const [locUri, xmlType] of cases) {
    const cmd = buildAppLockerPolicy({
      grouping: "g",
      ruleCollection: locUri,
      rules: [
        { type: "path", id: "id", name: "n", action: "Allow", path: "*" },
      ],
    });
    assertEquals(
      cmd.target.endsWith(`/${locUri}/Policy`),
      true,
      `LocURI 段名應該是 ${locUri}`,
    );
    assertEquals(
      cmd.data?.includes(`<RuleCollection Type="${xmlType}"`),
      true,
      `${locUri} 應該映射到 XML Type ${xmlType}`,
    );
  }
});

Deno.test("buildAppLockerPolicy: AuditOnly 模式只記錄不阻止", () => {
  const cmd = buildAppLockerPolicy({
    grouping: "g",
    ruleCollection: "EXE",
    enforcementMode: "AuditOnly",
    rules: [{ type: "path", id: "x", name: "x", action: "Deny", path: "*" }],
  });
  assertEquals(
    cmd.data?.includes('EnforcementMode="AuditOnly"'),
    true,
  );
});

Deno.test("buildAppLockerPolicy: FilePublisherRule 微軟所有 EXE 白名單", () => {
  const cmd = buildAppLockerPolicy({
    grouping: "default",
    ruleCollection: "EXE",
    rules: [
      {
        type: "publisher",
        id: "22222222-2222-2222-2222-222222222222",
        name: "Allow Microsoft",
        action: "Allow",
        publisherName:
          "O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
      },
    ],
  });
  assertEquals(cmd.data?.includes("<FilePublisherRule "), true);
  assertEquals(
    cmd.data?.includes('PublisherName="O=Microsoft Corporation, L=Redmond, S=Washington, C=US"'),
    true,
  );
  // 預設 ProductName/BinaryName/Version 都 "*"
  assertEquals(cmd.data?.includes('ProductName="*"'), true);
  assertEquals(cmd.data?.includes('BinaryName="*"'), true);
  assertEquals(
    cmd.data?.includes('LowSection="*" HighSection="*"'),
    true,
  );
});

Deno.test("buildAppLockerPolicy: FilePublisherRule 限定 product + version 範圍", () => {
  const cmd = buildAppLockerPolicy({
    grouping: "g",
    ruleCollection: "EXE",
    rules: [
      {
        type: "publisher",
        id: "id",
        name: "Allow MS Office 16.x+",
        action: "Allow",
        publisherName: "O=Microsoft",
        productName: "MICROSOFT OFFICE",
        binaryName: "WINWORD.EXE",
        versionRange: { low: "16.0.0.0", high: "*" },
      },
    ],
  });
  assertEquals(cmd.data?.includes('ProductName="MICROSOFT OFFICE"'), true);
  assertEquals(cmd.data?.includes('BinaryName="WINWORD.EXE"'), true);
  assertEquals(
    cmd.data?.includes('LowSection="16.0.0.0" HighSection="*"'),
    true,
  );
});

Deno.test("buildAppLockerPolicy: FilePathRule 含 Exceptions", () => {
  const cmd = buildAppLockerPolicy({
    grouping: "g",
    ruleCollection: "EXE",
    rules: [
      {
        type: "path",
        id: "id",
        name: "Block all in Downloads except installer",
        action: "Deny",
        path: "%USERPROFILE%\\Downloads\\*",
        exceptions: [{ path: "%USERPROFILE%\\Downloads\\official-installer.exe" }],
      },
    ],
  });
  assertEquals(cmd.data?.includes("<Exceptions>"), true);
  assertEquals(
    cmd.data?.includes(
      'Path="%USERPROFILE%\\Downloads\\official-installer.exe"',
    ),
    true,
  );
});

Deno.test("buildAppLockerPolicy: 多規則順序保留", () => {
  const cmd = buildAppLockerPolicy({
    grouping: "g",
    ruleCollection: "EXE",
    rules: [
      { type: "path", id: "a", name: "A", action: "Allow", path: "*" },
      { type: "path", id: "b", name: "B", action: "Deny", path: "*\\bad.exe" },
    ],
  });
  // 第 A 規則出現在 B 之前
  const idxA = cmd.data?.indexOf('Id="a"') ?? -1;
  const idxB = cmd.data?.indexOf('Id="b"') ?? -1;
  assertEquals(idxA > 0 && idxB > idxA, true);
});

Deno.test("buildAppLockerPolicy: name/path 含特殊字元正確 escape", () => {
  const cmd = buildAppLockerPolicy({
    grouping: "g",
    ruleCollection: "EXE",
    rules: [
      {
        type: "path",
        id: "id",
        name: "Block <bad> & \"quote\"",
        action: "Deny",
        path: "*<bad>&\".exe",
      },
    ],
  });
  // escapeAttr 處理 & " <（> 在 XML attr 不嚴格要求，既有 csp.ts 慣例保持）
  assertEquals(
    cmd.data?.includes('Name="Block &lt;bad> &amp; &quot;quote&quot;"'),
    true,
  );
  assertEquals(cmd.data?.includes('Path="*&lt;bad>&amp;&quot;.exe"'), true);
});

Deno.test("buildAppLockerPolicy: grouping URL-encode 進 LocURI", () => {
  const cmd = buildAppLockerPolicy({
    grouping: "school policy",
    ruleCollection: "EXE",
    rules: [{ type: "path", id: "x", name: "x", action: "Allow", path: "*" }],
  });
  assertEquals(
    cmd.target.includes("/Grouping/school%20policy/EXE/"),
    true,
  );
});

// ============================================================
// PersonalizationCSP（桌布 / 鎖屏圖）
// ============================================================

Deno.test("buildPersonalization: 只設桌布 → 單條 Replace", () => {
  const cmds = buildPersonalization({
    desktopImageUrl: "https://cdn.cogrow.com/wallpapers/school.jpg",
  });
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertEquals(
    cmds[0].target,
    "./Vendor/MSFT/Personalization/DesktopImageUrl",
  );
  assertEquals(cmds[0].format, "chr");
  assertEquals(cmds[0].data, "https://cdn.cogrow.com/wallpapers/school.jpg");
});

Deno.test("buildPersonalization: 只設鎖屏 → 單條 Replace", () => {
  const cmds = buildPersonalization({
    lockScreenImageUrl: "C:\\Windows\\Web\\Wallpaper\\lock.jpg",
  });
  assertEquals(cmds.length, 1);
  assertEquals(
    cmds[0].target,
    "./Vendor/MSFT/Personalization/LockScreenImageUrl",
  );
  assertEquals(cmds[0].data, "C:\\Windows\\Web\\Wallpaper\\lock.jpg");
});

Deno.test("buildPersonalization: 桌布 + 鎖屏 → 兩條命令", () => {
  const cmds = buildPersonalization({
    desktopImageUrl: "https://x/d.jpg",
    lockScreenImageUrl: "https://x/l.jpg",
  });
  assertEquals(cmds.length, 2);
  assertEquals(cmds[0].target.endsWith("DesktopImageUrl"), true);
  assertEquals(cmds[1].target.endsWith("LockScreenImageUrl"), true);
});

Deno.test("buildPersonalization: 空 input → 空陣列（無副作用）", () => {
  assertEquals(buildPersonalization({}).length, 0);
});

Deno.test("buildPersonalization: data 透傳不 escape（URL 含 & 等也直接傳）", () => {
  // format=chr 由 syncml.ts 統一 escape 嵌入 SyncML <Data>；
  // helper 本身不對 data 做二次 escape
  const cmds = buildPersonalization({
    desktopImageUrl: "https://x/img.jpg?ver=1&size=hd",
  });
  assertEquals(cmds[0].data, "https://x/img.jpg?ver=1&size=hd");
});

Deno.test("buildPersonalizationStatusQuery: 桌布 / 鎖屏 對應正確路徑", () => {
  const desktop = buildPersonalizationStatusQuery("desktop");
  assertEquals(desktop.verb, "Get");
  assertEquals(
    desktop.target,
    "./Vendor/MSFT/Personalization/DesktopImageStatus",
  );

  const lock = buildPersonalizationStatusQuery("lockScreen");
  assertEquals(
    lock.target,
    "./Vendor/MSFT/Personalization/LockScreenImageStatus",
  );
});

// ===== buildLockAdmxInstall / buildLockState（遠端鎖定，ADMX-backed Policy CSP）=====

Deno.test("buildLockAdmxInstall: Add ADMXInstall + format=chr + 內含 LockState ADMX", () => {
  const cmd = buildLockAdmxInstall();
  assertEquals(cmd.verb, "Add");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/CoGrowMDM/Policy/AgentPolicy",
  );
  assertEquals(cmd.format, "chr");
  assertEquals(cmd.data?.includes('<policy name="LockState"'), true);
  assertEquals(cmd.data?.includes('valueName="Enabled"'), true);
  assertEquals(cmd.data?.includes('<text id="EnterMessage" valueName="Message" />'), true);
});

Deno.test("buildLockState: enable → 單條 Set Policy Replace + enabled + message/phone", () => {
  const cmds = buildLockState({
    enabled: true,
    message: "請聯絡 XX 學校",
    phone: "02-1234-5678",
  });
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/CoGrowMDM~Policy~CoGrowLock/LockState",
  );
  assertEquals(cmds[0].format, "chr");
  assertEquals(cmds[0].data?.startsWith("<enabled/>"), true);
  assertEquals(
    cmds[0].data?.includes('<data id="EnterMessage" value="請聯絡 XX 學校"/>'),
    true,
  );
  assertEquals(
    cmds[0].data?.includes('<data id="EnterPhone" value="02-1234-5678"/>'),
    true,
  );
});

Deno.test("buildLockState: disable → 單條 Set Policy Replace + disabled（不含 message/phone）", () => {
  const cmds = buildLockState({ enabled: false });
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/CoGrowMDM~Policy~CoGrowLock/LockState",
  );
  assertEquals(cmds[0].data, "<disabled/>");
  assertEquals(cmds[0].data?.includes("EnterMessage"), false);
});

Deno.test("buildLockState: enable 省略 message/phone → value 空字串", () => {
  const cmds = buildLockState({ enabled: true });
  assertEquals(cmds[0].data?.includes('<data id="EnterMessage" value=""/>'), true);
  assertEquals(cmds[0].data?.includes('<data id="EnterPhone" value=""/>'), true);
});

Deno.test("buildLockState: message/phone 內特殊字元被 escapeAttr 轉義", () => {
  const cmds = buildLockState({ enabled: true, message: 'a"b<c&d', phone: "x" });
  // escapeAttr：& → &amp;、" → &quot;、< → &lt;
  assertEquals(cmds[0].data?.includes('value="a&quot;b&lt;c&amp;d"'), true);
});
