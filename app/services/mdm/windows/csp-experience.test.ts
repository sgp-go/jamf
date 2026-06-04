import { assertEquals } from "jsr:@std/assert@^1";
import { buildSetManualUnenroll } from "./csp-experience.ts";

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
