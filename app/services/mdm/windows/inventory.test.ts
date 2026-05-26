import { assertEquals, assert } from "jsr:@std/assert@^1";
import { parseInventoryData, isInventoryResult } from "./inventory.ts";

Deno.test("parseInventoryData: Windows 11 風格 <App ...> 屬性式", () => {
  const xml = `<Results Schema="1.0">
    <App PackageFamilyName="Microsoft.WindowsCalculator_8wekyb3d8bbwe" Version="10.2204.0.0" Name="Calculator" InstallState="2"/>
    <App PackageFamilyName="Microsoft.MicrosoftEdge_8wekyb3d8bbwe" Version="126.0.0" Name="Edge" InstallState="2"/>
  </Results>`;
  const entries = parseInventoryData(xml);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].packageFamilyName, "Microsoft.WindowsCalculator_8wekyb3d8bbwe");
  assertEquals(entries[0].displayName, "Calculator");
  assertEquals(entries[0].version, "10.2204.0.0");
  assertEquals(entries[0].installState, "2");
  assertEquals(entries[1].packageFamilyName, "Microsoft.MicrosoftEdge_8wekyb3d8bbwe");
});

Deno.test("parseInventoryData: 子標籤式（older Windows）", () => {
  const xml = `<Results>
    <Package PackageFamilyName="X.Y_z">
      <Name>App X</Name>
      <Version>1.0.0</Version>
      <InstallState>2</InstallState>
    </Package>
  </Results>`;
  const entries = parseInventoryData(xml);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].displayName, "App X");
  assertEquals(entries[0].version, "1.0.0");
  assertEquals(entries[0].installState, "2");
});

Deno.test("parseInventoryData: PackageDetails 模式 <Package ...> 真機格式（PackageStatus → installState）", () => {
  // 來源：Win10 22H2 真機抓包
  const xml = `<Results>
    <Package PackageFamilyName="Microsoft.Windows.Photos_8wekyb3d8bbwe" PackageFullName="Microsoft.Windows.Photos_2019.19071.12548.0_neutral_~_8wekyb3d8bbwe" Name="Microsoft.Windows.Photos" Version="2019.19071.12548.0" Publisher="CN=Microsoft Corporation" Architecture="Neutral" InstallLocation="C:\\Program Files\\WindowsApps\\foo" PackageStatus="0" IsBundle="1" IsFramework="0"/>
    <Package PackageFamilyName="BadApp_xyz" Name="BadApp" Version="1.0" PackageStatus="65535" IsBundle="0" IsFramework="0"/>
  </Results>`;
  const entries = parseInventoryData(xml);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].packageFamilyName, "Microsoft.Windows.Photos_8wekyb3d8bbwe");
  assertEquals(entries[0].displayName, "Microsoft.Windows.Photos");
  assertEquals(entries[0].version, "2019.19071.12548.0");
  assertEquals(entries[0].installState, "0"); // 真機 PackageStatus=0 表 OK
  assertEquals(entries[1].installState, "65535");
});

Deno.test("parseInventoryData: 缺 PackageFamilyName 的節點被跳過", () => {
  const xml = `<Results>
    <App Name="bogus" Version="1.0"/>
    <App PackageFamilyName="Good_x" Version="2.0"/>
  </Results>`;
  const entries = parseInventoryData(xml);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].packageFamilyName, "Good_x");
});

Deno.test("parseInventoryData: 空字串回空陣列", () => {
  assertEquals(parseInventoryData("").length, 0);
  assertEquals(parseInventoryData("   ").length, 0);
});

Deno.test("isInventoryResult: 正確識別 AppInventoryResults", () => {
  assert(
    isInventoryResult(
      "./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInventoryResults?Filter=Output=Inventory"
    )
  );
  assert(!isInventoryResult("./Device/Vendor/MSFT/RemoteWipe/doWipe"));
});
