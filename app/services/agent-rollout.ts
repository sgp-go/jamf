import { and, desc, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { agentReports } from "~/db/schema/agent.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
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
 *
 * 兩個查詢、與設備數無關（8000 台不再是 8000 次 findFirst）：
 *   1. 租戶 windows 設備列表（含從未上報的，core query 避免 findMany list 慢）
 *   2. DISTINCT ON (deviceId) … ORDER BY deviceId, reportedAt DESC：一次取每設備最新上報
 * 再於記憶體 map 合併（無上報的設備 → version/time 為 null）。
 */
async function loadDeviceVersions(tenantId: string): Promise<DeviceHealthInput[]> {
  const devices = await db
    .select({ id: mdmDevices.id })
    .from(mdmDevices)
    .where(and(eq(mdmDevices.tenantId, tenantId), eq(mdmDevices.platform, "windows")));

  // 每設備最新上報：DISTINCT ON (deviceId) 取 reportedAt 最大的那筆。命中
  // agent_reports_device_time_idx(deviceId, reportedAt)。
  const latest = await db
    .selectDistinctOn([agentReports.deviceId], {
      deviceId: agentReports.deviceId,
      appVersion: agentReports.appVersion,
      reportedAt: agentReports.reportedAt,
    })
    .from(agentReports)
    .where(eq(agentReports.tenantId, tenantId))
    .orderBy(agentReports.deviceId, desc(agentReports.reportedAt));

  const latestByDevice = new Map(latest.map((r) => [r.deviceId, r]));

  return devices.map((d) => {
    const r = latestByDevice.get(d.id);
    return {
      deviceId: d.id,
      currentVersion: r?.appVersion ?? null,
      lastReportedAt: r?.reportedAt ?? null,
    };
  });
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
