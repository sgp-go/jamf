import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { getLatestAgentReport } from "~/services/agent.ts";
import { installAgentOnDevice } from "~/services/install-agent.ts";
import {
  applySelection,
  assessRolloutHealth,
  type DeviceHealthInput,
  partitionByVersion,
  type RolloutHealth,
  type RolloutSelection,
} from "~/services/agent-rollout-selection.ts";

export type { RolloutSelection } from "~/services/agent-rollout-selection.ts";

/**
 * Agent 灰度發佈 + 升級健康驗證。
 *
 * 起因（[[windows-agent-update-delivery]] §4）：一個 DI-bug build 一次推 8000 台 =
 * 全體崩潰循環。更新必須分批：先推一小批（rolloutAgentVersion）→ 健康驗證觀察
 * （getRolloutHealth：silent = 升級後失聯，告警目標）→ 再放量。
 *
 * 候選 = 租戶下 windows 設備中「當前版本 != 目標版本」者；逐批調用靠候選自然收斂
 * 覆蓋全量，升級成功的設備下次上報版本即等於目標版本，自動退出候選。
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

export interface RolloutHealthResult extends RolloutHealth {
  targetVersion: string;
  windowMinutes: number;
}

/** app 存在性 + 租戶歸屬 + windows 平台校驗，回傳目標版本。 */
async function resolveTargetVersion(tenantId: string, appId: string): Promise<string> {
  const app = await db.query.apps.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, appId),
  });
  if (!app) throw new AppError(404, "app_not_found", "Agent app not found");
  if (app.tenantId !== null && app.tenantId !== tenantId) {
    throw new AppError(403, "forbidden", "App belongs to another tenant");
  }
  if (app.platform !== "windows") {
    throw new AppError(
      400,
      "unsupported_app_kind",
      "Rollout currently only supports Windows agent apps",
    );
  }
  return app.version;
}

/**
 * 租戶 windows 設備 + 各自最新上報的版本/時間。
 * core query 避免 findMany list 慢（見 devices.ts 註記）；逐台 findFirst 取最新上報
 * （灰度子集規模有限，可接受）。
 */
async function loadDeviceVersions(tenantId: string): Promise<DeviceHealthInput[]> {
  const devices = await db
    .select({ id: mdmDevices.id })
    .from(mdmDevices)
    .where(and(eq(mdmDevices.tenantId, tenantId), eq(mdmDevices.platform, "windows")));

  const out: DeviceHealthInput[] = [];
  for (const d of devices) {
    const latest = await getLatestAgentReport({ tenantId, deviceId: d.id });
    out.push({
      deviceId: d.id,
      currentVersion: latest?.appVersion ?? null,
      lastReportedAt: latest?.reportedAt ?? null,
    });
  }
  return out;
}

export async function rolloutAgentVersion(input: RolloutInput): Promise<RolloutResult> {
  const targetVersion = await resolveTargetVersion(input.tenantId, input.appId);
  const deviceVersions = await loadDeviceVersions(input.tenantId);

  const { eligible, skipped } = partitionByVersion(deviceVersions, targetVersion);
  const selected = applySelection(eligible, input.selection);

  // 逐個派發（單台失敗記入 results 不中斷整批）
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

/**
 * 灰度升級健康：對租戶 windows 設備按目標版本 + 上報時間分類。
 * silent（曾上報、現超 windowMinutes 無上報）= 升級後失聯告警目標，運維據此決定回滾。
 */
export async function getRolloutHealth(opts: {
  tenantId: string;
  appId: string;
  windowMinutes: number;
}): Promise<RolloutHealthResult> {
  const targetVersion = await resolveTargetVersion(opts.tenantId, opts.appId);
  const deviceVersions = await loadDeviceVersions(opts.tenantId);
  const health = assessRolloutHealth(
    deviceVersions,
    targetVersion,
    Date.now(),
    opts.windowMinutes,
  );
  return { targetVersion, windowMinutes: opts.windowMinutes, ...health };
}
