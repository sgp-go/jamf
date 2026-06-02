import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { getLatestAgentReport } from "~/services/agent.ts";
import { installAgentOnDevice } from "~/services/install-agent.ts";
import {
  applySelection,
  type DeviceVersion,
  partitionByVersion,
  type RolloutSelection,
} from "~/services/agent-rollout-selection.ts";

export type { RolloutSelection } from "~/services/agent-rollout-selection.ts";

/**
 * Agent 灰度發佈：選候選設備子集，逐個走 installAgentOnDevice 派新版 MSI。
 *
 * 起因（[[windows-agent-update-delivery]] §4）：一個 DI-bug build 一次推 8000 台 =
 * 全體崩潰循環。更新必須分批：先推一小批 → 健康驗證觀察（2c）→ 再放量。
 *
 * 候選 = 租戶下 windows 設備中「當前版本 != 目標版本」者；本批 = 候選按 selection
 * 取子集（純邏輯見 agent-rollout-selection.ts）。逐批調用（count→percentage→更大）
 * 靠候選自然收斂覆蓋全量，升級成功的設備自動退出候選，不重複派發。
 */

export interface RolloutInput {
  tenantId: string;
  appId: string;
  apiEndpoint: string;
  selection: RolloutSelection;
}

export interface RolloutDeviceResult {
  deviceId: string;
  commandIds?: string[];
  error?: string;
}

export interface RolloutResult {
  targetVersion: string;
  /** 候選數（當前版本 != 目標版本） */
  eligible: number;
  /** 本批實際選中派發數 */
  selected: number;
  /** 已是目標版本、跳過數 */
  skipped: number;
  queued: number;
  failed: number;
  results: RolloutDeviceResult[];
}

export async function rolloutAgentVersion(input: RolloutInput): Promise<RolloutResult> {
  // 1. 目標 app + 版本
  const app = await db.query.apps.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, input.appId),
  });
  if (!app) throw new AppError(404, "app_not_found", "Agent app not found");
  if (app.tenantId !== null && app.tenantId !== input.tenantId) {
    throw new AppError(403, "forbidden", "App belongs to another tenant");
  }
  if (app.platform !== "windows") {
    throw new AppError(
      400,
      "unsupported_app_kind",
      "Rollout currently only supports Windows agent apps",
    );
  }
  const targetVersion = app.version;

  // 2. 租戶 windows 設備（core query 避免 findMany list 慢，見 devices.ts 註記）
  const devices = await db
    .select({ id: mdmDevices.id })
    .from(mdmDevices)
    .where(and(eq(mdmDevices.tenantId, input.tenantId), eq(mdmDevices.platform, "windows")));

  // 3. 各設備當前 agent 版本（最新上報）。灰度子集規模有限，逐台 findFirst 可接受。
  const deviceVersions: DeviceVersion[] = [];
  for (const d of devices) {
    const latest = await getLatestAgentReport({ tenantId: input.tenantId, deviceId: d.id });
    deviceVersions.push({ deviceId: d.id, currentVersion: latest?.appVersion ?? null });
  }

  // 4. 分區 + 選本批
  const { eligible, skipped } = partitionByVersion(deviceVersions, targetVersion);
  const selected = applySelection(eligible, input.selection);

  // 5. 逐個派發（單台失敗記入 results 不中斷整批）
  const results: RolloutDeviceResult[] = [];
  for (const deviceId of selected) {
    try {
      const r = await installAgentOnDevice({
        tenantId: input.tenantId,
        deviceId,
        appId: input.appId,
        apiEndpoint: input.apiEndpoint,
      });
      results.push({ deviceId, commandIds: r.commandIds });
    } catch (e) {
      results.push({ deviceId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    targetVersion,
    eligible: eligible.length,
    selected: selected.length,
    skipped: skipped.length,
    queued: results.filter((r) => r.commandIds).length,
    failed: results.filter((r) => r.error).length,
    results,
  };
}
