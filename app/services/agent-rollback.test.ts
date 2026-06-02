import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  type AutoRollbackDeps,
  autoRollback,
  type RollforwardArtifact,
} from "~/services/agent-rollback.ts";
import type { RolloutHealthResult, RolloutResult } from "~/services/agent-rollout.ts";
import type { RollbackPolicy } from "~/services/agent-rollback-decision.ts";

const policy: RollbackPolicy = { silentRatioThreshold: 0.2, minCohortSize: 10 };

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

const healthResult = (
  upgraded: number,
  silent: number,
  pending = 0,
): RolloutHealthResult => ({
  targetVersion: "1.3.1.0",
  windowMinutes: 30,
  upgraded: ids("up", upgraded),
  silent: ids("si", silent),
  pending: ids("pe", pending),
  neverReported: [],
});

const artifact: RollforwardArtifact = {
  version: "1.3.1.1",
  sha256: "a".repeat(64),
  productCode: "{11111111-1111-1111-1111-111111111111}",
  fileUrl: "/api/v1/apps/rf/download/CoGrowMDMAgent-rollforward-1.3.1.1.msi",
};

/** 記錄各 dep 是否被呼叫 + 呼叫參數，預設健康場景。 */
function makeSpyDeps(health: RolloutHealthResult, over?: Partial<AutoRollbackDeps>) {
  const calls = {
    build: 0,
    registerApp: 0,
    dispatch: 0,
    dispatchDeviceIds: [] as string[],
  };
  const deps: AutoRollbackDeps = {
    getHealth: () => Promise.resolve(health),
    build: (_req) => {
      calls.build++;
      return Promise.resolve(artifact);
    },
    registerApp: (_o) => {
      calls.registerApp++;
      return Promise.resolve("new-app-id");
    },
    dispatch: ({ deviceIds }) => {
      calls.dispatch++;
      calls.dispatchDeviceIds = deviceIds;
      const r: RolloutResult = {
        targetVersion: artifact.version,
        eligible: deviceIds.length,
        selected: deviceIds.length,
        skipped: 0,
        queued: deviceIds.length,
        failed: 0,
        results: deviceIds.map((deviceId) => ({ deviceId, commandIds: ["c1"] })),
      };
      return Promise.resolve(r);
    },
    ...over,
  };
  return { deps, calls };
}

const baseInput = {
  tenantId: "t1",
  appId: "bad-app",
  apiEndpoint: "https://api.cogrow.com/api/agent/v1",
  windowMinutes: 30,
  policy,
  sourceRef: "agent-v1.3.0.0",
  rollforwardVersion: "1.3.1.1",
};

Deno.test("未觸發（健康）：不構建、不註冊、不派發", async () => {
  // upgraded 19 + silent 1 → 5% < 20% → healthy
  const { deps, calls } = makeSpyDeps(healthResult(19, 1));
  const r = await autoRollback(baseInput, deps);
  assertEquals(r.triggered, false);
  assertEquals(r.dryRun, false);
  assertEquals(r.decision.reason, "healthy");
  assertEquals(calls.build, 0);
  assertEquals(calls.registerApp, 0);
  assertEquals(calls.dispatch, 0);
  assertEquals(r.artifact, undefined);
});

Deno.test("dry-run：超閾值但只出計畫，不構建不派發", async () => {
  // upgraded 10 + silent 10 → 50% > 20% → 觸發，但 dryRun
  const { deps, calls } = makeSpyDeps(healthResult(10, 10));
  const r = await autoRollback({ ...baseInput, dryRun: true }, deps);
  assertEquals(r.triggered, false);
  assertEquals(r.dryRun, true);
  assertEquals(r.decision.shouldRollback, true);
  assertEquals(r.plan.targetCount, 20); // silent 10 + upgraded 10
  assertEquals(r.plan.rollforwardVersion, "1.3.1.1");
  assertEquals(calls.build, 0);
  assertEquals(calls.dispatch, 0);
});

Deno.test("觸發：構建→註冊→派發 silent∪upgraded，回傳完整結果", async () => {
  const { deps, calls } = makeSpyDeps(healthResult(5, 15)); // 75% > 20%
  const r = await autoRollback(baseInput, deps);
  assertEquals(r.triggered, true);
  assertEquals(calls.build, 1);
  assertEquals(calls.registerApp, 1);
  assertEquals(calls.dispatch, 1);
  // 派發目標 = silent(15) ∪ upgraded(5)，pending 不在內
  assertEquals(calls.dispatchDeviceIds.length, 20);
  assert(calls.dispatchDeviceIds.includes("si-0"));
  assert(calls.dispatchDeviceIds.includes("up-0"));
  assertEquals(r.rolloutAppId, "new-app-id");
  assertEquals(r.artifact?.version, "1.3.1.1");
  assertEquals(r.rollout?.queued, 20);
});

Deno.test("樣本不足：cohort 不夠不觸發（小批驗證期保護）", async () => {
  // upgraded 3 + silent 4 = 7 < 10 → insufficient_sample
  const { deps, calls } = makeSpyDeps(healthResult(3, 4));
  const r = await autoRollback(baseInput, deps);
  assertEquals(r.triggered, false);
  assertEquals(r.decision.reason, "insufficient_sample");
  assertEquals(calls.dispatch, 0);
});

Deno.test("構建版本與計畫不符 → 拋錯（守住 MajorUpgrade 命門）", async () => {
  const { deps } = makeSpyDeps(healthResult(5, 15), {
    build: () => Promise.resolve({ ...artifact, version: "9.9.9.9" }),
  });
  await assertRejects(
    () => autoRollback(baseInput, deps),
    Error,
    "roll-forward 構建版本",
  );
});

Deno.test("pending 不稀釋：大量 pending 下仍正確觸發並只派壞 build 設備", async () => {
  // upgraded 5 + silent 12（崩潰）+ pending 300 → cohort 17、ratio≈70.6% 觸發
  const { deps, calls } = makeSpyDeps(healthResult(5, 12, 300));
  const r = await autoRollback(baseInput, deps);
  assertEquals(r.triggered, true);
  assertEquals(calls.dispatchDeviceIds.length, 17); // 不含 300 pending
});
