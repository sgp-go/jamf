/**
 * 自動回滾 CLI：查灰度健康 → 決策（silent 超閾值？）→（觸發時）構建 roll-forward + 灰度派發。
 *
 * 設計見 brain/wiki/agent-rollback-strategy.md §5「自動回滾觸發」。編排見
 * app/services/agent-rollback.ts。
 *
 * 兩種跑法：
 *   1. dry-run（預設安全檔，純本地可跑）：只查健康 + 出決策 + 印計畫，不構建不派發。
 *      deno task auto-rollback --tenant <id> --app <id> --source-ref agent-v1.2.0.0 \
 *        --rollforward-version 1.3.1.1 --endpoint https://api.cogrow.com/api/agent/v1 --dry-run
 *   2. --execute：實構建 + 註冊 + 派發。構建來源二選一：
 *      - --manifest <path>（首選）：用 CI（agent-rollforward.yml workflow）產出的 manifest，
 *        不依賴本地 pwsh/git。CI 構建 → 下載 manifest（+ 上傳 MSI 託管回填 fileUrl）→ 此處派發。
 *      - 不給 --manifest：spawn 本地 pwsh build-rollforward.ps1（須 git+pwsh+WiX；
 *        真機是 git archive 拷貝無 .git，worktree 會失敗 → 用 CI/--manifest）。
 *      建議排程定時 dry-run 告警、人工確認後再 --execute。
 *
 * 退出碼：0=健康/已派發；3=觸發回滾（dry-run，待人工放行）；1=錯誤。
 */

import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import {
  autoRollback,
  type AutoRollbackInput,
  makeDefaultDeps,
} from "~/services/agent-rollback.ts";

const flags = parseArgs(Deno.args, {
  string: [
    "tenant",
    "app",
    "endpoint",
    "source-ref",
    "rollforward-version",
    "window-minutes",
    "silent-threshold",
    "min-cohort",
    "cert-thumbprint",
    "manifest",
  ],
  boolean: ["dry-run", "execute"],
  default: {
    "window-minutes": "30",
    "silent-threshold": "0.2",
    "min-cohort": "10",
    "dry-run": true,
  },
});

function required(name: string, val: string | undefined): string {
  if (!val) {
    console.error(`❌ 缺必填參數 --${name}`);
    Deno.exit(1);
  }
  return val;
}

// --execute 顯式關閉 dry-run；否則一律 dry-run（安全預設）
const dryRun = flags.execute ? false : true;

const input: AutoRollbackInput = {
  tenantId: required("tenant", flags.tenant),
  appId: required("app", flags.app),
  apiEndpoint: required("endpoint", flags.endpoint),
  sourceRef: required("source-ref", flags["source-ref"]),
  rollforwardVersion: required("rollforward-version", flags["rollforward-version"]),
  windowMinutes: Number(flags["window-minutes"]),
  policy: {
    silentRatioThreshold: Number(flags["silent-threshold"]),
    minCohortSize: Number(flags["min-cohort"]),
  },
  dryRun,
};

const deps = makeDefaultDeps({
  manifestPath: flags.manifest,
  certThumbprint: flags["cert-thumbprint"],
});

const r = await autoRollback(input, deps);
const { decision, health, plan } = r;

console.log("==== 自動回滾評估 ====");
console.log(`目標(壞)版本   : ${health.targetVersion}`);
console.log(`靜默窗口       : ${health.windowMinutes} min`);
console.log(
  `健康分類       : upgraded=${health.upgraded.length} silent=${health.silent.length} ` +
    `pending=${health.pending.length} neverReported=${health.neverReported.length}`,
);
console.log(
  `同期(分母)     : ${decision.cohortSize}（upgraded+silent，排除 pending/never）`,
);
console.log(
  `silent 比例    : ${(decision.silentRatio * 100).toFixed(1)}%（閾值 ${
    (decision.threshold * 100).toFixed(0)
  }%）`,
);
console.log(`決策           : ${decision.reason} → shouldRollback=${decision.shouldRollback}`);

if (!decision.shouldRollback) {
  console.log(`\n✅ 不回滾（${decision.reason}）。`);
  Deno.exit(0);
}

console.log("\n==== 回滾計畫 ====");
console.log(`源碼(好版本)   : ${plan.sourceRef}`);
console.log(`roll-forward   : ${plan.rollforwardVersion}（須 > 壞版本）`);
console.log(`派發目標       : ${plan.targetCount} 台（silent ∪ upgraded）`);

if (r.dryRun) {
  console.log(
    "\n⚠️ dry-run：未構建未派發。確認無誤後：CI 跑 agent-rollforward.yml 產 manifest，" +
      "下載後加 --execute --manifest <path> 實跑（或在有 git+pwsh+WiX 的機器 --execute 直接本地構建）。",
  );
  Deno.exit(3); // 與健康(0) 區分，供排程告警
}

console.log("\n==== 已執行 ====");
console.log(`roll-forward app : ${r.rolloutAppId}`);
console.log(`構建版本/雜湊    : ${r.artifact?.version} / ${r.artifact?.sha256}`);
console.log(
  `派發結果         : selected=${r.rollout?.selected} queued=${r.rollout?.queued} ` +
    `failed=${r.rollout?.failed}`,
);
console.log("\n✅ 回滾已派發。隔窗口後再跑 --dry-run 確認 silent 收斂。");
Deno.exit(0);
