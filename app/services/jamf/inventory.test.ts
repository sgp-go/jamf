import { assertEquals } from "jsr:@std/assert@^1";
import { parseJamfDate, roundOrNull } from "~/services/jamf/inventory.ts";

Deno.test("parseJamfDate: 有效 ISO 字串回 Date", () => {
  const d = parseJamfDate("2026-04-15T08:54:45.831Z");
  assertEquals(d?.toISOString(), "2026-04-15T08:54:45.831Z");
});

Deno.test("parseJamfDate: null / undefined / 空字串回 null", () => {
  assertEquals(parseJamfDate(null), null);
  assertEquals(parseJamfDate(undefined), null);
  assertEquals(parseJamfDate(""), null);
});

Deno.test("parseJamfDate: 1970 epoch（Jamf 的「無值」表示）回 null", () => {
  assertEquals(parseJamfDate("1970-01-01T00:00:00Z"), null);
});

Deno.test("parseJamfDate: 非法字串回 null", () => {
  assertEquals(parseJamfDate("not-a-date"), null);
});

Deno.test("roundOrNull: null / undefined 回 null", () => {
  assertEquals(roundOrNull(null), null);
  assertEquals(roundOrNull(undefined), null);
});

Deno.test("roundOrNull: 電量 0 是真值不當 null；小數四捨五入", () => {
  assertEquals(roundOrNull(0), 0);
  assertEquals(roundOrNull(15), 15);
  assertEquals(roundOrNull(47486.7), 47487);
});
