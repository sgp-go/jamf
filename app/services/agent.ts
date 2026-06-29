import { createHash } from "node:crypto";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { agentReports, deviceUsageStats } from "~/db/schema/agent.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { touchDeviceLastSeen } from "~/services/mdm/devices.ts";
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
  token?: string | null;
}): Promise<{ id: string; agentTokenHash: string | null }> {
  // 路徑 1：token-first（install-agent 簽發後 row 上 hash 唯一，比 serial 更可靠）。
  // Windows ppkg enrollment 寫的 row 一開始沒 serial_number；token 才能精確命中。
  if (opts.token) {
    const tokenHash = createHash("sha256").update(opts.token).digest("hex");
    const byToken = await db.query.mdmDevices.findFirst({
      where: (t, { and: andOp, eq: eqOp }) =>
        andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.agentTokenHash, tokenHash)),
      columns: { id: true, agentTokenHash: true, serialNumber: true, udid: true },
    });
    if (byToken) {
      // backfill：row 缺 serial / udid 時順手補上，下次 serial-only lookup 也走得通。
      const patch: { serialNumber?: string; udid?: string } = {};
      if (!byToken.serialNumber) patch.serialNumber = opts.serialNumber;
      if (!byToken.udid && opts.udid) patch.udid = opts.udid;
      if (Object.keys(patch).length > 0) {
        await db.update(mdmDevices).set({ ...patch, updatedAt: new Date() })
          .where(eq(mdmDevices.id, byToken.id));
      }
      return { id: byToken.id, agentTokenHash: byToken.agentTokenHash };
    }
    // token 給了但匹配不到 → 不 fallback insert（避免 silent 創建空 row 隱藏鑑權問題），
    // 走下面 serial 路徑或留給 authorize 拋 401。
  }

  // 路徑 2：(tenantId, serialNumber) 查
  const existing = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.serialNumber, opts.serialNumber)),
    columns: { id: true, agentTokenHash: true },
  });
  if (existing) return existing;

  // 路徑 3：fallback insert platform=apple agent_only（iOS BYOD 場景）
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
  await touchDeviceLastSeen(input.deviceId);
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

// ============================================================
// GPS 上報(PRD §5.2 Lost Mode + §5.7 地理位置 Inventory)
// ============================================================
//
// Agent 上報 GPS 位置;設備一筆最新值(無歷史)。Lost Mode 啟用時 Agent 走高頻
// 上報(由 Agent C# Watcher 控制,後端只接收)。

export interface AgentGpsInput {
  deviceId: string;
  tenantId: string;
  latitude: number;
  longitude: number;
  /** GPS / WiFi triangulation 誤差半徑(米);null 表示未知 */
  accuracyMeters?: number | null;
  /** 設備本地取位置的時間;省略則用 server now() */
  capturedAt?: Date | string | null;
}

export async function updateDeviceGps(input: AgentGpsInput): Promise<{
  deviceId: string;
  latitude: string;
  longitude: string;
  accuracyMeters: number | null;
  capturedAt: string;
}> {
  if (input.latitude < -90 || input.latitude > 90) {
    throw new AppError(400, "invalid_latitude", "latitude must be in [-90, 90]");
  }
  if (input.longitude < -180 || input.longitude > 180) {
    throw new AppError(400, "invalid_longitude", "longitude must be in [-180, 180]");
  }
  const capturedAt = input.capturedAt
    ? input.capturedAt instanceof Date
      ? input.capturedAt
      : new Date(input.capturedAt)
    : new Date();
  if (Number.isNaN(capturedAt.getTime())) {
    throw new AppError(400, "invalid_captured_at", "capturedAt is not a valid date");
  }
  const [row] = await db
    .update(mdmDevices)
    .set({
      lastGpsLatitude: String(input.latitude),
      lastGpsLongitude: String(input.longitude),
      lastGpsAccuracyMeters: input.accuracyMeters ?? null,
      lastGpsAt: capturedAt,
    })
    .where(
      and(
        eq(mdmDevices.id, input.deviceId),
        eq(mdmDevices.tenantId, input.tenantId),
      ),
    )
    .returning({
      id: mdmDevices.id,
      lat: mdmDevices.lastGpsLatitude,
      lon: mdmDevices.lastGpsLongitude,
      acc: mdmDevices.lastGpsAccuracyMeters,
      at: mdmDevices.lastGpsAt,
    });
  if (!row) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  return {
    deviceId: row.id,
    latitude: row.lat!,
    longitude: row.lon!,
    accuracyMeters: row.acc,
    capturedAt: row.at!.toISOString(),
  };
}

export async function getDeviceGps(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<{
  deviceId: string;
  latitude: string | null;
  longitude: string | null;
  accuracyMeters: number | null;
  capturedAt: string | null;
}> {
  const row = await db
    .select({
      id: mdmDevices.id,
      lat: mdmDevices.lastGpsLatitude,
      lon: mdmDevices.lastGpsLongitude,
      acc: mdmDevices.lastGpsAccuracyMeters,
      at: mdmDevices.lastGpsAt,
    })
    .from(mdmDevices)
    .where(
      and(eq(mdmDevices.id, opts.deviceId), eq(mdmDevices.tenantId, opts.tenantId)),
    )
    .limit(1);
  if (row.length === 0) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  const r = row[0];
  return {
    deviceId: r.id,
    latitude: r.lat,
    longitude: r.lon,
    accuracyMeters: r.acc,
    capturedAt: r.at?.toISOString() ?? null,
  };
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
