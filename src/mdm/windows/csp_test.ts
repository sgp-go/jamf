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
