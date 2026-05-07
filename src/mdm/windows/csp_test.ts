import { assertEquals } from "jsr:@std/assert@^1";
import {
  buildRemoteWipe,
  buildMsixInstall,
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

Deno.test("buildMsixInstall: PFN 在路徑中 URI-encoded", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
    contentUri: "https://cdn.example.com/calc.msixbundle",
    hashHex: "abc123",
  });
  // 點號保留，底線保留，但路徑被 encode
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInstallation/Microsoft.WindowsCalculator_8wekyb3d8bbwe/StoreInstall"
  );
  assertEquals(cmd.verb, "Exec");
});

Deno.test("buildMsixInstall: Data 含 ContentURL 與 Hash", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "X.Y_z",
    contentUri: "https://cdn.example.com/x.msix",
    hashHex: "deadbeef",
  });
  // Data 是 XML 配置字串
  const data = cmd.data ?? "";
  assertEquals(data.includes('Verb="install"'), true);
  assertEquals(data.includes('LOB="true"'), true);
  assertEquals(data.includes('ContentURL="https://cdn.example.com/x.msix"'), true);
  assertEquals(data.includes("<Hash>deadbeef</Hash>"), true);
});

Deno.test("buildMsixInstall: Store app（非 LOB）省略 LOB attr", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
    contentUri: "https://cdn/c.msix",
    hashHex: "1",
    isLOB: false,
  });
  const data = cmd.data ?? "";
  assertEquals(data.includes("LOB="), false);
  assertEquals(data.includes('Verb="install"'), true);
});

Deno.test("buildMsixInstall: ContentURL 中 & 字元被 escape", () => {
  const cmd = buildMsixInstall({
    packageFamilyName: "X.Y_z",
    contentUri: "https://cdn/x.msix?a=1&b=2",
    hashHex: "x",
  });
  const data = cmd.data ?? "";
  assertEquals(data.includes("&amp;"), true);
  assertEquals(data.includes("&b=2"), false);
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
