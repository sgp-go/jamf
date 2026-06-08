import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { agentReports, deviceUsageStats } from "~/db/schema/agent.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import {
  mergeUsage,
  type UsageAnomaly,
  type UsageStatItemInput,
} from "~/services/usage-merge.ts";

export type { UsageAnomaly, UsageStatItemInput };

/**
 * Agent App 端只認識自己的 serialNumber（與可選的 udid）。
 * 後端用 (tenantId, serialNumber) 唯一鎖定一台 mdm_devices；
 * 找不到時自動 upsert 一筆「未透過 MDM 註冊但有 Agent」的設備記錄，
 * 後續若被 MDM 註冊上來，由 mdm checkin 流程把同一 serial 的 row 合併補欄位。
 */
/**
 * 解析 Agent 上報的 (tenantId, serialNumber) → 找到或建立 mdm_devices row。
 *
 * 同時回傳 agent_token_hash 供 handler 做鑑權判斷：
 *   - null：尚未透過 install-agent 簽發 token（相容 iOS 無 token 上報）
 *   - 非 null：必須帶匹配 Bearer token 否則 401
 *
 * 找不到 row 時自動建立 platform="apple" 的「Agent-only」設備（iOS 場景）。
 * Windows Agent 第一次上報前一定先走 install-agent，row 已存在 + token 已設，
 * 不會走 insert 分支。
 */
export async function resolveAgentDevice(opts: {
  tenantId: string;
  serialNumber: string;
  udid?: string | null;
}): Promise<{ id: string; agentTokenHash: string | null }> {
  const existing = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.serialNumber, opts.serialNumber)),
    columns: { id: true, agentTokenHash: true },
  });
  if (existing) return existing;

  const [created] = await db
    .insert(mdmDevices)
    .values({
      tenantId: opts.tenantId,
      serialNumber: opts.serialNumber,
      udid: opts.udid ?? null,
      platform: "apple",
      enrollmentStatus: "pending",
      enrollmentType: "agent_only",
    })
    .returning({
      id: mdmDevices.id,
      agentTokenHash: mdmDevices.agentTokenHash,
    });
  if (!created) {
    throw new AppError(500, "device_upsert_failed", "Failed to upsert device row");
  }
  return created;
}

export interface AgentReportInput {
  tenantId: string;
  deviceId: string;
  serialNumber: string;
  batteryLevel?: number;
  storageAvailableMb?: number;
  storageTotalMb?: number;
  networkType?: string;
  networkSsid?: string;
  screenBrightness?: number;
  osVersion?: string;
  appVersion?: string;
  extraData?: Record<string, unknown>;
  reportedAt?: string;
}

export async function saveAgentReport(input: AgentReportInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(agentReports)
    .values({
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      serialNumber: input.serialNumber,
      batteryLevel: input.batteryLevel ?? null,
      storageAvailableMb: input.storageAvailableMb ?? null,
      storageTotalMb: input.storageTotalMb ?? null,
      networkType: input.networkType ?? null,
      networkSsid: input.networkSsid ?? null,
      screenBrightness: input.screenBrightness ?? null,
      osVersion: input.osVersion ?? null,
      appVersion: input.appVersion ?? null,
      extraData: input.extraData ?? null,
      reportedAt: input.reportedAt ? new Date(input.reportedAt) : new Date(),
    })
    .returning({ id: agentReports.id });
  if (!row) {
    throw new AppError(500, "report_save_failed", "Failed to save agent report");
  }
  return row;
}

export function listAgentReports(opts: {
  tenantId: string;
  deviceId: string;
  limit: number;
  offset: number;
}) {
  return db
    .select()
    .from(agentReports)
    .where(
      and(
        eq(agentReports.tenantId, opts.tenantId),
        eq(agentReports.deviceId, opts.deviceId),
      ),
    )
    .orderBy(desc(agentReports.reportedAt))
    .limit(opts.limit)
    .offset(opts.offset);
}

export function getLatestAgentReport(opts: { tenantId: string; deviceId: string }) {
  return db.query.agentReports.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.deviceId, opts.deviceId)),
    orderBy: (t, { desc: descOp }) => descOp(t.reportedAt),
  });
}

export interface UsageUpsertResult {
  ids: string[];
  anomalies: UsageAnomaly[];
}

/**
 * 同設備同日 upsert（device_usage_stats unique(device_id, date)）。
 *
 * 防篡改第 2 層（服務端權威）：合併邏輯見 {@link mergeUsage} —— 天內累計單調
 * 只增，max 合併挫敗「改小本地 db 少報」，回退記為 anomaly 供呼叫端告警。
 */
export async function upsertUsageStats(opts: {
  tenantId: string;
  deviceId: string;
  sessionId?: string;
  stats: UsageStatItemInput[];
}): Promise<UsageUpsertResult> {
  const now = new Date();
  const ids: string[] = [];
  const anomalies: UsageAnomaly[] = [];

  for (const item of opts.stats) {
    // 取既有行作單調性基線（findFirst 單條查不受 findMany list 慢問題影響）。
    const existing = await db.query.deviceUsageStats.findFirst({
      where: (t, { and: andOp, eq: eqOp }) =>
        andOp(eqOp(t.deviceId, opts.deviceId), eqOp(t.date, item.date)),
    });

    const { merged, anomalies: rowAnomalies } = mergeUsage(
      existing
        ? {
          totalMinutes: existing.totalMinutes,
          pickup: existing.pickup,
          maxContinuous: existing.maxContinuous,
          timeStats: existing.timeStats as Record<string, number> | null,
        }
        : null,
      item,
    );
    anomalies.push(...rowAnomalies);

    const [row] = await db
      .insert(deviceUsageStats)
      .values({
        tenantId: opts.tenantId,
        deviceId: opts.deviceId,
        sessionId: opts.sessionId ?? null,
        date: item.date,
        ...merged,
        reportedAt: now,
      })
      .onConflictDoUpdate({
        target: [deviceUsageStats.deviceId, deviceUsageStats.date],
        set: { ...merged, reportedAt: now },
      })
      .returning({ id: deviceUsageStats.id });
    if (row) ids.push(row.id);
  }
  return { ids, anomalies };
}

export function listUsageStats(opts: {
  tenantId: string;
  deviceId: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}) {
  const conditions = [
    eq(deviceUsageStats.tenantId, opts.tenantId),
    eq(deviceUsageStats.deviceId, opts.deviceId),
  ];
  if (opts.date) {
    conditions.push(eq(deviceUsageStats.date, opts.date));
  } else {
    if (opts.startDate) conditions.push(gte(deviceUsageStats.date, opts.startDate));
    if (opts.endDate) conditions.push(lte(deviceUsageStats.date, opts.endDate));
  }

  let q = db
    .select()
    .from(deviceUsageStats)
    .where(and(...conditions))
    .orderBy(desc(deviceUsageStats.date))
    .$dynamic();

  if (opts.limit) q = q.limit(opts.limit);

  return q;
}
