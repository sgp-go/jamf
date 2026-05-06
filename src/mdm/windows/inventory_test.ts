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
