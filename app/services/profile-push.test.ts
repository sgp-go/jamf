import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { parseWindowsProfilePayload } from "./profile-push.ts";
import { AppError } from "~/lib/errors.ts";

Deno.test("parseWindowsProfilePayload: 完整 csps 正常解析", () => {
  const csps = parseWindowsProfilePayload({
    csps: [
      {
        path: "./Device/Vendor/MSFT/Policy/Config/DeviceLock/MinDevicePasswordLength",
        verb: "Replace",
        format: "int",
        data: "8",
      },
      { path: "./Device/Vendor/MSFT/RemoteWipe/doWipe", verb: "Exec" },
    ],
  });
  assertEquals(csps.length, 2);
  assertEquals(csps[0].verb, "Replace");
  assertEquals(csps[0].format, "int");
  assertEquals(csps[0].data, "8");
  assertEquals(csps[1].verb, "Exec");
  assertEquals(csps[1].format, undefined);
  assertEquals(csps[1].data, undefined);
});

Deno.test("parseWindowsProfilePayload: null / 非物件 → 400", () => {
  assertThrows(() => parseWindowsProfilePayload(null), AppError);
  assertThrows(() => parseWindowsProfilePayload("string"), AppError);
  assertThrows(() => parseWindowsProfilePayload(42), AppError);
});

Deno.test("parseWindowsProfilePayload: 缺 csps → 400", () => {
  assertThrows(
    () => parseWindowsProfilePayload({}),
    AppError,
    "non-empty array",
  );
});

Deno.test("parseWindowsProfilePayload: csps 不是陣列 → 400", () => {
  assertThrows(
    () => parseWindowsProfilePayload({ csps: "not array" }),
    AppError,
    "non-empty array",
  );
});

Deno.test("parseWindowsProfilePayload: 空陣列 → 400", () => {
  assertThrows(
    () => parseWindowsProfilePayload({ csps: [] }),
    AppError,
    "non-empty array",
  );
});

Deno.test("parseWindowsProfilePayload: csp 缺 path → 400", () => {
  assertThrows(
    () => parseWindowsProfilePayload({ csps: [{ verb: "Replace" }] }),
    AppError,
    "path required",
  );
});

Deno.test("parseWindowsProfilePayload: csp 缺 verb → 400", () => {
  assertThrows(
    () => parseWindowsProfilePayload({ csps: [{ path: "./x" }] }),
    AppError,
    "verb required",
  );
});

Deno.test("parseWindowsProfilePayload: csp verb 不在白名單 → 400", () => {
  assertThrows(
    () => parseWindowsProfilePayload({ csps: [{ path: "./x", verb: "Patch" }] }),
    AppError,
    "verb required",
  );
});

Deno.test("parseWindowsProfilePayload: csp format 不在白名單 → 400", () => {
  assertThrows(
    () =>
      parseWindowsProfilePayload({
        csps: [{ path: "./x", verb: "Replace", format: "blob" }],
      }),
    AppError,
    "format",
  );
});

Deno.test("parseWindowsProfilePayload: csp data 非 string → 400", () => {
  assertThrows(
    () =>
      parseWindowsProfilePayload({
        csps: [{ path: "./x", verb: "Replace", data: 42 }],
      }),
    AppError,
    "data must be string",
  );
});

Deno.test("parseWindowsProfilePayload: 全 verb 白名單接受", () => {
  for (const verb of ["Add", "Replace", "Exec", "Get", "Delete"]) {
    const csps = parseWindowsProfilePayload({ csps: [{ path: "./x", verb }] });
    assertEquals(csps[0].verb, verb);
  }
});

Deno.test("parseWindowsProfilePayload: 全 format 白名單接受", () => {
  for (const format of ["int", "chr", "xml", "b64", "node"]) {
    const csps = parseWindowsProfilePayload({
      csps: [{ path: "./x", verb: "Replace", format }],
    });
    assertEquals(csps[0].format, format);
  }
});
