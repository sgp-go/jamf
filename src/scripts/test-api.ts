/** Jamf API 連通性測試指令碼 */

import { JamfClient, DeviceService } from "../jamf/mod.ts";
import type { JamfProVersion } from "../jamf/types.ts";

async function main() {
  console.log("=== Jamf API 連通性測試 ===\n");

  // 1. 初始化客戶端
  console.log("1. 初始化 API 客戶端...");
  const client = new JamfClient();
  console.log("   ✅ 客戶端建立成功\n");

  // 2. 測試認證
  console.log("2. 測試認證 - 取得 Jamf Pro 版本...");
  const version = await client.get<JamfProVersion>("/api/v1/jamf-pro-version");
  console.log(`   ✅ Jamf Pro 版本: ${version.version}\n`);

  // 3. 取得裝置列表
  console.log("3. 取得行動裝置列表...");
  const devices = new DeviceService(client);
  const deviceList = await devices.listMobileDevices();
  console.log(`   ✅ 共 ${deviceList.totalCount} 臺裝置\n`);

  for (const d of deviceList.results) {
    console.log(`   📱 ${d.name || "(未命名)"} | SN: ${d.serialNumber} | ID: ${d.id}`);
  }

  if (deviceList.results.length === 0) {
    console.log("   ⚠️ 沒有已註冊的裝置\n");
    return;
  }

  // 4. 取得第一臺裝置詳情
  const first = deviceList.results[0];
  console.log(`\n4. 取得裝置詳情 (${first.serialNumber})...`);
  const detail = await devices.getMobileDevice(first.id);
  const ios = detail.ios;

  console.log(`   ✅ 裝置詳情:`);
  console.log(`   名稱:     ${detail.name}`);
  console.log(`   序號:     ${detail.serialNumber}`);
  console.log(`   系統:     iPadOS ${detail.osVersion} (${detail.osBuild})`);
  console.log(`   受管:     ${detail.managed}`);
  console.log(`   IP:       ${detail.ipAddress}`);

  if (ios) {
    console.log(`   型號:     ${ios.model}`);
    console.log(`   電池:     ${ios.batteryLevel}%`);
    console.log(`   儲存:     ${ios.availableMb}MB / ${ios.capacityMb}MB (已用 ${ios.percentageUsed}%)`);
    console.log(`   監管:     ${ios.supervised}`);
    console.log(`   App 數量: ${ios.applications.length}`);
    console.log(`   設定描述檔: ${ios.configurationProfiles.map((p) => p.displayName).join(", ")}`);
  }

  // 5. 顯示裝置分組
  if (detail.groups.length > 0) {
    console.log(`   分組:     ${detail.groups.map((g) => g.groupName).join(", ")}`);
  }

  console.log("\n=== 測試完成 ===");
}

main().catch((err) => {
  console.error("❌ 測試失敗:", err);
  Deno.exit(1);
});
