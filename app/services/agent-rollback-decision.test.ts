import { assertEquals } from "jsr:@std/assert@^1";
import {
  decideRollback,
  type RollbackPolicy,
} from "~/services/agent-rollback-decision.ts";

const policy: RollbackPolicy = { silentRatioThreshold: 0.2, minCohortSize: 10 };

/** 造 n 個假設備 id（前綴區分類別，斷言可讀）。 */
const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

const health = (
  upgraded: number,
  silent: number,
  pending = 0,
  neverReported = 0,
) => ({
  upgraded: ids("up", upgraded),
  silent: ids("si", silent),
  pending: ids("pe", pending),
  neverReported: ids("nr", neverReported),
});

Deno.test("觸發：silent 比例超閾值（cohort=upgraded+silent）", () => {
  // 20 取得更新：upgraded 15 + silent 5 → 5/20 = 25% > 20% → 觸發
  const d = decideRollback(health(15, 5), policy);
  assertEquals(d.shouldRollback, true);
  assertEquals(d.reason, "silent_ratio_exceeded");
  assertEquals(d.cohortSize, 20);
  assertEquals(d.silentCount, 5);
  assertEquals(d.silentRatio, 0.25);
});

Deno.test("健康：silent 比例恰好等於閾值不觸發（嚴格大於）", () => {
  // upgraded 16 + silent 4 → 4/20 = 20% == 閾值，不 > → 健康
  const d = decideRollback(health(16, 4), policy);
  assertEquals(d.shouldRollback, false);
  assertEquals(d.reason, "healthy");
  assertEquals(d.silentRatio, 0.2);
});

Deno.test("健康：silent 比例低於閾值", () => {
  const d = decideRollback(health(19, 1), policy); // 1/20 = 5%
  assertEquals(d.shouldRollback, false);
  assertEquals(d.reason, "healthy");
});

Deno.test("樣本不足：cohort < minCohortSize 即使全 silent 也不判定", () => {
  // 5 台全 silent = 100%，但 cohort 5 < 10 → insufficient_sample（防小批誤判）
  const d = decideRollback(health(0, 5), policy);
  assertEquals(d.shouldRollback, false);
  assertEquals(d.reason, "insufficient_sample");
  assertEquals(d.cohortSize, 5);
  assertEquals(d.silentRatio, 1);
});

Deno.test("樣本不足：pending/neverReported 不計入 cohort（不撐起樣本數）", () => {
  // 取得更新只有 upgraded 6 + silent 2 = 8 < 10，pending 100 不該讓它過樣本門檻
  const d = decideRollback(health(6, 2, 100, 50), policy);
  assertEquals(d.cohortSize, 8);
  assertEquals(d.reason, "insufficient_sample");
});

Deno.test("⭐ pending 不稀釋比例：灰度進行中大量 pending 不該掩蓋壞 build", () => {
  // 升級批 upgraded 5 + silent 10（崩潰），另有 200 台 pending 尚未輪到。
  // 若把 pending 算進分母 → 10/215 ≈ 4.6% 漏判；正確分母只算 cohort 15 → 10/15 ≈ 66.7% 觸發
  const d = decideRollback(health(5, 10, 200), policy);
  assertEquals(d.shouldRollback, true);
  assertEquals(d.reason, "silent_ratio_exceeded");
  assertEquals(d.cohortSize, 15);
  assertEquals(Number(d.silentRatio.toFixed(4)), 0.6667);
});

Deno.test("回滾目標 = silent ∪ upgraded（壞 build 設備全換），不含 pending/never", () => {
  const d = decideRollback(health(3, 12, 5, 5), policy);
  assertEquals(d.shouldRollback, true);
  // silent 在前、upgraded 在後
  assertEquals(d.targetDeviceIds, [...ids("si", 12), ...ids("up", 3)]);
  assertEquals(d.targetDeviceIds.length, 15);
});

Deno.test("空 cohort：無任何取得更新的設備 → ratio 0、樣本不足", () => {
  const d = decideRollback(health(0, 0, 30, 10), policy);
  assertEquals(d.cohortSize, 0);
  assertEquals(d.silentRatio, 0);
  assertEquals(d.reason, "insufficient_sample");
  assertEquals(d.targetDeviceIds, []);
});

Deno.test("閾值回顯在決策中（供告警上下文）", () => {
  const d = decideRollback(health(15, 5), { silentRatioThreshold: 0.3, minCohortSize: 5 });
  // 25% < 30% → 健康，但 threshold 必須回顯為 0.3
  assertEquals(d.shouldRollback, false);
  assertEquals(d.threshold, 0.3);
});
