import { assertEquals } from "jsr:@std/assert@^1";
import {
  applySelection,
  type DeviceVersion,
  partitionByVersion,
} from "~/services/agent-rollout-selection.ts";

const dv = (deviceId: string, currentVersion: string | null): DeviceVersion => ({
  deviceId,
  currentVersion,
});

Deno.test("partitionByVersion: 已是目標版本→skipped，其餘（含 null）→eligible", () => {
  const { eligible, skipped } = partitionByVersion(
    [dv("a", "1.0.0"), dv("b", "2.0.0"), dv("c", null), dv("d", "2.0.0")],
    "2.0.0",
  );
  assertEquals(eligible, ["a", "c"]);
  assertEquals(skipped, ["b", "d"]);
});

Deno.test("partitionByVersion: 全部已升級→eligible 空（灰度收斂終態）", () => {
  const { eligible, skipped } = partitionByVersion(
    [dv("a", "2.0.0"), dv("b", "2.0.0")],
    "2.0.0",
  );
  assertEquals(eligible, []);
  assertEquals(skipped, ["a", "b"]);
});

Deno.test("applySelection count: 取候選前 N", () => {
  assertEquals(
    applySelection(["a", "b", "c", "d"], { mode: "count", count: 2 }),
    ["a", "b"],
  );
});

Deno.test("applySelection count: N 超過候選數→全取", () => {
  assertEquals(applySelection(["a", "b"], { mode: "count", count: 10 }), ["a", "b"]);
});

Deno.test("applySelection count: N=0→空（不派）", () => {
  assertEquals(applySelection(["a", "b"], { mode: "count", count: 0 }), []);
});

Deno.test("applySelection percentage: ceil(len×pct%)", () => {
  // 10 台 × 25% = 2.5 → ceil 3
  assertEquals(
    applySelection(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      { mode: "percentage", percent: 25 },
    ),
    ["a", "b", "c"],
  );
});

Deno.test("applySelection percentage: 100%→全量", () => {
  assertEquals(
    applySelection(["a", "b", "c"], { mode: "percentage", percent: 100 }),
    ["a", "b", "c"],
  );
});

Deno.test("applySelection percentage: >100 夾為 100（全量）", () => {
  assertEquals(applySelection(["a", "b"], { mode: "percentage", percent: 999 }), ["a", "b"]);
});

Deno.test("applySelection deviceIds: 候選與指定列表交集（不在候選的指定設備自動跳過）", () => {
  // eligible 已排除已升級設備；指定 [a,c,x]，x 不在候選 → 只派 a,c
  assertEquals(
    applySelection(["a", "b", "c"], { mode: "deviceIds", deviceIds: ["a", "c", "x"] }),
    ["a", "c"],
  );
});
