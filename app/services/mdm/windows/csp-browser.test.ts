import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildIESiteZoneAssignment,
  buildBlockedSites,
  buildIESiteZoneClear,
  buildEdgeAdmxInstall,
  buildEdgeUrlBlocklist,
  buildEdgeUrlBlocklistClear,
  hostToUrlBlockPattern,
} from "./csp-browser.ts";

const SEP = "";

Deno.test("buildIESiteZoneAssignment: 單一 host 派到 Restricted Sites (Zone 4)", () => {
  const cmd = buildIESiteZoneAssignment({
    sites: [{ host: "example.com", zone: 4 }],
  });
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList",
  );
  assertEquals(cmd.format, "chr");
  assertEquals(cmd.type, "text/plain");
  assertEquals(
    cmd.data,
    `<enabled/><data id="IZ_ZonemapPrompt" value="example.com${SEP}4"/>`,
  );
});

Deno.test("buildIESiteZoneAssignment: 多個 host 用 U+F000 串接 site/zone pair", () => {
  const cmd = buildIESiteZoneAssignment({
    sites: [
      { host: "tiktok.com", zone: 4 },
      { host: "intranet.school", zone: 1 },
      { host: "trusted.example.com", zone: 2 },
    ],
  });
  assertEquals(
    cmd.data,
    `<enabled/><data id="IZ_ZonemapPrompt" value="tiktok.com${SEP}4${SEP}intranet.school${SEP}1${SEP}trusted.example.com${SEP}2"/>`,
  );
});

Deno.test("buildIESiteZoneAssignment: scope=user 走 ./User LocURI", () => {
  const cmd = buildIESiteZoneAssignment({
    sites: [{ host: "x.com", zone: 4 }],
    scope: "user",
  });
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList",
  );
});

Deno.test("buildIESiteZoneAssignment: host 含 & < \" 需 escape (XML attribute safe)", () => {
  const cmd = buildIESiteZoneAssignment({
    sites: [{ host: "a&b<c\"d", zone: 4 }],
  });
  assertEquals(
    cmd.data,
    `<enabled/><data id="IZ_ZonemapPrompt" value="a&amp;b&lt;c&quot;d${SEP}4"/>`,
  );
});

Deno.test("buildIESiteZoneAssignment: 空 sites 陣列拋錯", () => {
  assertThrows(() => buildIESiteZoneAssignment({ sites: [] }), Error);
});

Deno.test("buildIESiteZoneAssignment: host 含 U+F000 分隔字元拋錯", () => {
  assertThrows(
    () =>
      buildIESiteZoneAssignment({
        sites: [{ host: `evil${SEP}injected`, zone: 4 }],
      }),
    Error,
  );
});

Deno.test("buildIESiteZoneAssignment: 非法 zone 拋錯", () => {
  assertThrows(
    () =>
      buildIESiteZoneAssignment({
        // deno-lint-ignore no-explicit-any
        sites: [{ host: "x.com", zone: 5 as any }],
      }),
    Error,
  );
});

Deno.test("buildBlockedSites: hosts 全派到 Zone 4", () => {
  const cmd = buildBlockedSites(["bad1.com", "bad2.net"]);
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.data,
    `<enabled/><data id="IZ_ZonemapPrompt" value="bad1.com${SEP}4${SEP}bad2.net${SEP}4"/>`,
  );
});

Deno.test("buildBlockedSites: scope=user", () => {
  const cmd = buildBlockedSites(["bad.com"], "user");
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList",
  );
});

Deno.test("buildIESiteZoneClear: data=<disabled/>", () => {
  const cmd = buildIESiteZoneClear();
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList",
  );
  assertEquals(cmd.data, "<disabled/>");
});

Deno.test("buildIESiteZoneClear: scope=user", () => {
  const cmd = buildIESiteZoneClear("user");
  assertEquals(
    cmd.target,
    "./User/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList",
  );
});

// ============================================================
// Edge Chromium URLBlocklist（ADMX-backed）
// ============================================================

Deno.test("hostToUrlBlockPattern: bare host 原樣返回（match host + subdomains）", () => {
  assertEquals(hostToUrlBlockPattern("tiktok.com"), "tiktok.com");
  assertEquals(hostToUrlBlockPattern("mail.example.com"), "mail.example.com");
});

Deno.test("hostToUrlBlockPattern: *. 前綴移除（Chromium 沒此語法，bare host 語意等價）", () => {
  assertEquals(hostToUrlBlockPattern("*.tiktok.com"), "tiktok.com");
});

Deno.test("hostToUrlBlockPattern: 前綴 . 原樣（禁用 subdomain 匹配）", () => {
  assertEquals(hostToUrlBlockPattern(".tiktok.com"), ".tiktok.com");
});

Deno.test("hostToUrlBlockPattern: 含 scheme / path 原樣返回", () => {
  assertEquals(hostToUrlBlockPattern("https://foo.com/bar"), "https://foo.com/bar");
  assertEquals(hostToUrlBlockPattern("mail.example.com/x"), "mail.example.com/x");
});

Deno.test("hostToUrlBlockPattern: 空 host 拋錯", () => {
  assertThrows(() => hostToUrlBlockPattern(""), Error);
  assertThrows(() => hostToUrlBlockPattern("   "), Error);
});

Deno.test("buildEdgeAdmxInstall: Replace ADMXInstall/CoGrowMDM/Policy/EdgePolicy", () => {
  const cmd = buildEdgeAdmxInstall();
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/CoGrowMDM/Policy/EdgePolicy",
  );
  assertEquals(cmd.format, "chr");
  // XML 內容含 URLBlocklistDesc list 元素與 Edge hive key
  const xml = cmd.data ?? "";
  const hasList = xml.includes("URLBlocklistDesc");
  const hasEdgeKey = xml.includes("Software\\Policies\\Microsoft\\Edge");
  assertEquals(hasList, true);
  assertEquals(hasEdgeKey, true);
});

Deno.test("buildEdgeUrlBlocklist: 單一 host 用 bare host 語法", () => {
  const cmd = buildEdgeUrlBlocklist(["tiktok.com"]);
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Policy/Config/CoGrowMDM~Policy~CoGrowEdge/EdgeUrlBlocklist",
  );
  assertEquals(cmd.format, "chr");
  assertEquals(
    cmd.data,
    `<enabled/><data id="URLBlocklistDesc" value="1${SEP}tiktok.com"/>`,
  );
});

Deno.test("buildEdgeUrlBlocklist: 多 host index 遞增 + U+F000 分隔", () => {
  const cmd = buildEdgeUrlBlocklist(["tiktok.com", "*.facebook.com", "youtube.com"]);
  // *.facebook.com 會被正規化為 facebook.com
  assertEquals(
    cmd.data,
    `<enabled/><data id="URLBlocklistDesc" value="1${SEP}tiktok.com${SEP}2${SEP}facebook.com${SEP}3${SEP}youtube.com"/>`,
  );
});

Deno.test("buildEdgeUrlBlocklist: 空 hosts 拋錯", () => {
  assertThrows(() => buildEdgeUrlBlocklist([]), Error);
});

Deno.test("buildEdgeUrlBlocklist: pattern 內含 & < \" 需 escape", () => {
  const cmd = buildEdgeUrlBlocklist([`bad&<host">.com`]);
  assertEquals(
    cmd.data,
    `<enabled/><data id="URLBlocklistDesc" value="1${SEP}bad&amp;&lt;host&quot;>.com"/>`,
  );
});

Deno.test("buildEdgeUrlBlocklistClear: data=<disabled/>", () => {
  const cmd = buildEdgeUrlBlocklistClear();
  assertEquals(cmd.verb, "Replace");
  assertEquals(
    cmd.target,
    "./Device/Vendor/MSFT/Policy/Config/CoGrowMDM~Policy~CoGrowEdge/EdgeUrlBlocklist",
  );
  assertEquals(cmd.data, "<disabled/>");
});
