import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildIESiteZoneAssignment,
  buildBlockedSites,
  buildIESiteZoneClear,
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
