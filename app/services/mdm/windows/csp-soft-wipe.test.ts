import { assertEquals } from "jsr:@std/assert@^1";
import {
  buildSoftWipeAdmxInstall,
  buildSoftWipeReset,
  buildSoftWipeTrigger,
  type SoftWipeWhitelist,
} from "./csp-soft-wipe.ts";

Deno.test("buildSoftWipeAdmxInstall: Replace ADMXInstall/CoGrowMDM/Policy/SoftWipePolicy", () => {
  const cmd = buildSoftWipeAdmxInstall();
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/CoGrowMDM/Policy/SoftWipePolicy",
  );
  assertEquals(cmd.format, "chr");
  const xml = cmd.data ?? "";
  assertEquals(xml.includes("SoftWipeState"), true);
  assertEquals(xml.includes("Software\\CoGrow\\Agent\\SoftWipe"), true);
  assertEquals(xml.includes("WhitelistJson"), true);
  assertEquals(xml.includes("WipeId"), true);
});

Deno.test("buildSoftWipeTrigger: Replace 含 enabled + whitelist JSON + wipeId", () => {
  const wl: SoftWipeWhitelist = {
    msiProductCodes: ["{12345678-1234-1234-1234-123456789ABC}"],
    uwpPfns: ["Microsoft.WindowsCalculator_8wekyb3d8bbwe"],
    wingetIds: ["7zip.7zip"],
  };
  const cmd = buildSoftWipeTrigger({ whitelist: wl, wipeId: "wipe-abc-123" });
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Policy/Config/CoGrowMDM~Policy~CoGrowSoftWipe/SoftWipeState",
  );
  assertEquals(cmd.format, "chr");
  const data = cmd.data ?? "";
  assertEquals(data.startsWith("<enabled/>"), true);
  assertEquals(data.includes("WhitelistJson"), true);
  assertEquals(data.includes("WipeId"), true);
  assertEquals(data.includes("wipe-abc-123"), true);
  // JSON 內含全部三類白名單
  assertEquals(data.includes("{12345678-1234-1234-1234-123456789ABC}".replace(/{/g, "{").replace(/}/g, "}")), true);
  assertEquals(data.includes("Microsoft.WindowsCalculator"), true);
  assertEquals(data.includes("7zip.7zip"), true);
});

Deno.test("buildSoftWipeTrigger: whitelist JSON 含 & < 需 escape 到 attribute-safe", () => {
  const wl: SoftWipeWhitelist = {
    msiProductCodes: [],
    uwpPfns: ['Bad<Name&"App'],
    wingetIds: [],
  };
  const cmd = buildSoftWipeTrigger({ whitelist: wl, wipeId: "x" });
  const data = cmd.data ?? "";
  // JSON.stringify 先把 `"` 轉成 `\"`，然後 escapeAttr 把 `<` `&` 轉成 XML entity；
  // 原始 `"` 在 JSON 序列化階段變成 `\"` 進入 XML attribute。
  // 最終 raw text 不應含原始 `<`（會破 XML 結構）
  const attrStart = data.indexOf('WhitelistJson" value="');
  const attrPortion = data.slice(attrStart + 'WhitelistJson" value="'.length);
  const attrEndIdx = attrPortion.indexOf('"/>');
  const rawAttr = attrPortion.slice(0, attrEndIdx);
  assertEquals(rawAttr.includes("<"), false);
  // JSON 內 `<` 被 escape 為 `&lt;`、`&` escape 為 `&amp;`
  assertEquals(rawAttr.includes("Bad&lt;Name&amp;"), true);
});

Deno.test("buildSoftWipeReset: data=<disabled/>", () => {
  const cmd = buildSoftWipeReset();
  assertEquals(cmd.verb, "Replace");
  assertEquals(cmd.data, "<disabled/>");
});

Deno.test("buildSoftWipeTrigger: 空白名單也 work（極端場景，清得最徹底）", () => {
  const cmd = buildSoftWipeTrigger({
    whitelist: { msiProductCodes: [], uwpPfns: [], wingetIds: [] },
    wipeId: "empty-wl",
  });
  const data = cmd.data ?? "";
  // XML attribute 內 `"` 會被 escape，所以查 escaped 版本
  assertEquals(data.includes("&quot;msiProductCodes&quot;:[]"), true);
  assertEquals(data.includes("empty-wl"), true);
});
