/** SQLite 儲存 - Agent App 回報的裝置狀態歷史 */

import { Database } from "jsr:@db/sqlite@0.12";

const DB_PATH = "data/agent_reports.db";

let db: Database;

export function getDb(): Database {
  if (!db) {
    // 確保 data 目錄存在
    try {
      Deno.mkdirSync("data", { recursive: true });
    } catch {
      // 目錄已存在
    }
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      serial_number TEXT NOT NULL,
      battery_level INTEGER,
      storage_available_mb INTEGER,
      storage_total_mb INTEGER,
      network_type TEXT,
      network_ssid TEXT,
      screen_brightness REAL,
      os_version TEXT,
      app_version TEXT,
      extra_data TEXT,
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reports_device_id ON agent_reports(device_id);
    CREATE INDEX IF NOT EXISTS idx_reports_serial ON agent_reports(serial_number);
    CREATE INDEX IF NOT EXISTS idx_reports_time ON agent_reports(reported_at DESC);

    CREATE TABLE IF NOT EXISTS device_usage_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      session_id TEXT,
      date TEXT NOT NULL,
      total_minutes INTEGER NOT NULL DEFAULT 0,
      pickup INTEGER NOT NULL DEFAULT 0,
      max_continuous INTEGER NOT NULL DEFAULT 0,
      time_stats TEXT,
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(device_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_device_id ON device_usage_stats(device_id);
    CREATE INDEX IF NOT EXISTS idx_usage_date ON device_usage_stats(date);
  `);
}

// Agent 回報的狀態資料
export interface AgentReport {
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

// 儲存的報告記錄
export interface AgentReportRow {
  id: number;
  device_id: string;
  serial_number: string;
  battery_level: number | null;
  storage_available_mb: number | null;
  storage_total_mb: number | null;
  network_type: string | null;
  network_ssid: string | null;
  screen_brightness: number | null;
  os_version: string | null;
  app_version: string | null;
  extra_data: string | null;
  reported_at: string;
  created_at: string;
}

/** 儲存 Agent 回報 */
export function saveReport(report: AgentReport): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO agent_reports (
      device_id, serial_number, battery_level,
      storage_available_mb, storage_total_mb,
      network_type, network_ssid, screen_brightness,
      os_version, app_version, extra_data, reported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    report.deviceId,
    report.serialNumber,
    report.batteryLevel ?? null,
    report.storageAvailableMb ?? null,
    report.storageTotalMb ?? null,
    report.networkType ?? null,
    report.networkSsid ?? null,
    report.screenBrightness ?? null,
    report.osVersion ?? null,
    report.appVersion ?? null,
    report.extraData ? JSON.stringify(report.extraData) : null,
    report.reportedAt ?? new Date().toISOString()
  );
  return db.lastInsertRowId;
}

/** 查詢裝置的回報歷史 */
export function getReports(
  deviceId: string,
  opts?: { limit?: number; offset?: number }
): AgentReportRow[] {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  return db
    .prepare(
      `SELECT * FROM agent_reports WHERE device_id = ?
       ORDER BY reported_at DESC LIMIT ? OFFSET ?`
    )
    .all(deviceId, limit, offset) as AgentReportRow[];
}

/** 取得裝置最新一筆回報 */
export function getLatestReport(
  deviceId: string
): AgentReportRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM agent_reports WHERE device_id = ?
       ORDER BY reported_at DESC LIMIT 1`
    )
    .get(deviceId) as AgentReportRow | undefined;
}

// ---- 使用時長統計 ----

export interface UsageStatsReport {
  deviceId: string;
  sessionId?: string;
  stats: UsageStatItem[];
}

export interface UsageStatItem {
  date: string;
  totalMinutes: number;
  pickup: number;
  maxContinuous: number;
  timeStats?: { hour: number; minutes: number }[];
}

export interface UsageStatsRow {
  id: number;
  device_id: string;
  session_id: string | null;
  date: string;
  total_minutes: number;
  pickup: number;
  max_continuous: number;
  time_stats: string | null;
  reported_at: string;
  created_at: string;
}

/** 儲存/更新使用時長統計（同裝置同日 UPSERT） */
export function saveUsageStats(report: UsageStatsReport): number[] {
  const db = getDb();
  const ids: number[] = [];
  const stmt = db.prepare(`
    INSERT INTO device_usage_stats (
      device_id, session_id, date, total_minutes,
      pickup, max_continuous, time_stats, reported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, date) DO UPDATE SET
      total_minutes = excluded.total_minutes,
      pickup = excluded.pickup,
      max_continuous = excluded.max_continuous,
      time_stats = excluded.time_stats,
      reported_at = excluded.reported_at
  `);

  for (const item of report.stats) {
    stmt.run(
      report.deviceId,
      report.sessionId ?? null,
      item.date,
      item.totalMinutes,
      item.pickup,
      item.maxContinuous,
      item.timeStats ? JSON.stringify(item.timeStats) : null,
      new Date().toISOString()
    );
    ids.push(db.lastInsertRowId);
  }
  return ids;
}

/** 查詢裝置使用時長（支援日期篩選） */
export function getUsageStats(
  deviceId: string,
  opts?: { date?: string; startDate?: string; endDate?: string; limit?: number }
): UsageStatsRow[] {
  const db = getDb();
  let sql = "SELECT * FROM device_usage_stats WHERE device_id = ?";
  const params: (string | number)[] = [deviceId];

  if (opts?.date) {
    sql += " AND date = ?";
    params.push(opts.date);
  } else {
    if (opts?.startDate) {
      sql += " AND date >= ?";
      params.push(opts.startDate);
    }
    if (opts?.endDate) {
      sql += " AND date <= ?";
      params.push(opts.endDate);
    }
  }

  sql += " ORDER BY date DESC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  return db.prepare(sql).all(...params) as UsageStatsRow[];
}
