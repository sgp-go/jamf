import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { buildSetManualUnenroll, buildSettingsPageVisibility } from "./csp-experience.ts";

const TARGET =
  "./Device/Vendor/MSFT/Policy/Config/Experience/AllowManualMDMUnenrollment";

Deno.test("buildSetManualUnenroll: 鎖定（allow=false）下發 int 0 Replace", () => {
  const cmd = buildSetManualUnenroll(false);
  assertEquals(cmd.verb, "Replace");
  assertEquals(cmd.target, TARGET);
  assertEquals(cmd.format, "int");
  assertEquals(cmd.data, "0");
});

Deno.test("buildSetManualUnenroll: 解鎖（allow=true）下發 int 1 Replace", () => {
  const cmd = buildSetManualUnenroll(true);
  assertEquals(cmd.verb, "Replace");
  assertEquals(cmd.target, TARGET);
  assertEquals(cmd.format, "int");
  assertEquals(cmd.data, "1");
});

const PAGE_TARGET = "./Device/Vendor/MSFT/Policy/Config/Settings/PageVisibilityList";

Deno.test("buildSettingsPageVisibility: hide 多頁 → 分號連接", () => {
  const cmd = buildSettingsPageVisibility({
    mode: "hide",
    pages: ["recovery", "windowsupdate", "printers"],
  });
  assertEquals(cmd.verb, "Replace");
  assertEquals(cmd.target, PAGE_TARGET);
  assertEquals(cmd.format, "chr");
  assertEquals(cmd.data, "hide:recovery;windowsupdate;printers");
});

Deno.test("buildSettingsPageVisibility: showonly 單頁", () => {
  const cmd = buildSettingsPageVisibility({
    mode: "showonly",
    pages: ["network-wifi"],
  });
  assertEquals(cmd.data, "showonly:network-wifi");
});

Deno.test("buildSettingsPageVisibility: 空 pages 拋錯", () => {
  assertThrows(
    () => buildSettingsPageVisibility({ mode: "hide", pages: [] }),
    Error,
    "pages",
  );
});

Deno.test("buildSettingsPageVisibility: page 含空白拋錯", () => {
  assertThrows(
    () => buildSettingsPageVisibility({ mode: "hide", pages: ["foo bar"] }),
    Error,
    "非法",
  );
});

Deno.test("buildSettingsPageVisibility: page 含分號拋錯（避免破壞分隔結構）", () => {
  assertThrows(
    () => buildSettingsPageVisibility({ mode: "hide", pages: ["recovery;evil"] }),
    Error,
    "非法",
  );
});
