import { assertEquals } from "jsr:@std/assert";
import { mergeTimeStats, mergeUsage } from "~/services/usage-merge.ts";

const item = (over: Partial<Parameters<typeof mergeUsage>[1]> = {}) => ({
  date: "2026-06-01",
  totalMinutes: 100,
  pickup: 10,
  maxContinuous: 40,
  ...over,
});

Deno.test("mergeUsage: 無既有行時直接採用上報值，無 anomaly", () => {
  const { merged, anomalies } = mergeUsage(null, item());
  assertEquals(merged.totalMinutes, 100);
  assertEquals(merged.pickup, 10);
  assertEquals(merged.maxContinuous, 40);
  assertEquals(anomalies, []);
});

Deno.test("mergeUsage: 上報值更大時更新，無 anomaly（正常累計增長）", () => {
  const existing = { totalMinutes: 100, pickup: 10, maxContinuous: 40 };
  const { merged, anomalies } = mergeUsage(
    existing,
    item({ totalMinutes: 150, pickup: 14, maxContinuous: 55 }),
  );
  assertEquals(merged.totalMinutes, 150);
  assertEquals(merged.pickup, 14);
  assertEquals(merged.maxContinuous, 55);
  assertEquals(anomalies, []);
});

Deno.test("mergeUsage: 回退被擋（取 max）並記 anomaly（疑似篡改少報）", () => {
  const existing = { totalMinutes: 200, pickup: 18, maxContinuous: 60 };
  const { merged, anomalies } = mergeUsage(
    existing,
    item({ totalMinutes: 50, pickup: 3, maxContinuous: 10 }),
  );
  // max 合併：不降低已記錄量
  assertEquals(merged.totalMinutes, 200);
  assertEquals(merged.pickup, 18);
  assertEquals(merged.maxContinuous, 60);
  // 三個欄位都回退 → 三條 anomaly
  assertEquals(anomalies.length, 3);
  assertEquals(
    anomalies.find((a) => a.field === "totalMinutes"),
    { date: "2026-06-01", field: "totalMinutes", previous: 200, reported: 50 },
  );
});

Deno.test("mergeUsage: 部分欄位回退只記該欄位", () => {
  const existing = { totalMinutes: 100, pickup: 10, maxContinuous: 40 };
  const { merged, anomalies } = mergeUsage(
    existing,
    item({ totalMinutes: 120, pickup: 8, maxContinuous: 45 }),
  );
  assertEquals(merged.totalMinutes, 120); // 增長正常
  assertEquals(merged.pickup, 10); // 回退被擋
  assertEquals(merged.maxContinuous, 45);
  assertEquals(anomalies.length, 1);
  assertEquals(anomalies[0].field, "pickup");
});

Deno.test("mergeTimeStats: 逐小時取 max 合併", () => {
  const merged = mergeTimeStats(
    { "8": 50, "9": 60 },
    { "9": 40, "10": 30 }, // hour 9 回退（40<60）→ 取 60；新增 hour 10
  );
  assertEquals(merged, { "8": 50, "9": 60, "10": 30 });
});

Deno.test("mergeTimeStats: 兩邊皆空回 null", () => {
  assertEquals(mergeTimeStats(null, null), null);
  assertEquals(mergeTimeStats(undefined, {}), null);
});
