import { assertEquals } from "jsr:@std/assert@1";
import { escapeCsvField, toCsvRow } from "./csv.ts";

Deno.test("escapeCsvField: 一般字串原樣輸出", () => {
  assertEquals(escapeCsvField("device.lock"), "device.lock");
});

Deno.test("escapeCsvField: null / undefined 輸出空字串", () => {
  assertEquals(escapeCsvField(null), "");
  assertEquals(escapeCsvField(undefined), "");
});

Deno.test("escapeCsvField: 含逗號加引號包裹", () => {
  assertEquals(escapeCsvField("a,b"), '"a,b"');
});

Deno.test("escapeCsvField: 含引號轉義為雙引號", () => {
  assertEquals(escapeCsvField('say "hi"'), '"say ""hi"""');
});

Deno.test("escapeCsvField: 含換行加引號包裹", () => {
  assertEquals(escapeCsvField("line1\nline2"), '"line1\nline2"');
});

Deno.test("escapeCsvField: 公式注入前綴單引號（= + - @ 開頭）", () => {
  assertEquals(escapeCsvField("=SUM(A1)"), "'=SUM(A1)");
  assertEquals(escapeCsvField("+1234"), "'+1234");
  assertEquals(escapeCsvField("-cmd"), "'-cmd");
  assertEquals(escapeCsvField("@user"), "'@user");
});

Deno.test("escapeCsvField: 公式注入 + 含逗號同時處理", () => {
  assertEquals(escapeCsvField("=A1,B1"), `"'=A1,B1"`);
});

Deno.test("escapeCsvField: 數字轉字串", () => {
  assertEquals(escapeCsvField(42), "42");
});

Deno.test("toCsvRow: 組合多欄位", () => {
  assertEquals(
    toCsvRow(["id-1", "admin:1.2.3.4", 'a,"b"', null]),
    'id-1,admin:1.2.3.4,"a,""b""",',
  );
});
