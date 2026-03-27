/** SQLite 儲存 - Agent App 回報 + 自建 MDM 資料 */

import { Database } from "jsr:@db/sqlite@0.12";
import type {
  MdmDeviceRow,
  MdmCommandRow,
  DepDeviceRow,
  DepTokenRow,
  MdmMigrationRow,
} from "../mdm/types.ts";

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

  // ---- 自建 MDM 資料表 ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS mdm_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      udid TEXT NOT NULL UNIQUE,
      serial_number TEXT,
      device_name TEXT,
      model TEXT,
      os_version TEXT,
      push_token TEXT,
      push_magic TEXT,
      unlock_token TEXT,
      topic TEXT,
      last_seen_at TEXT,
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      enrollment_status TEXT NOT NULL DEFAULT 'pending',
      enrollment_type TEXT DEFAULT 'dep',
      device_info TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mdm_devices_udid ON mdm_devices(udid);
    CREATE INDEX IF NOT EXISTS idx_mdm_devices_serial ON mdm_devices(serial_number);

    CREATE TABLE IF NOT EXISTS mdm_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_uuid TEXT NOT NULL UNIQUE,
      device_udid TEXT NOT NULL,
      command_type TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      response_payload TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      error_chain TEXT,
      queued_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      responded_at TEXT,
      FOREIGN KEY (device_udid) REFERENCES mdm_devices(udid)
    );
    CREATE INDEX IF NOT EXISTS idx_mdm_commands_device ON mdm_commands(device_udid);
    CREATE INDEX IF NOT EXISTS idx_mdm_commands_status ON mdm_commands(status);

    CREATE TABLE IF NOT EXISTS mdm_dep_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_number TEXT NOT NULL UNIQUE,
      model TEXT,
      description TEXT,
      color TEXT,
      device_family TEXT,
      os TEXT,
      profile_uuid TEXT,
      profile_status TEXT DEFAULT 'empty',
      dep_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dep_devices_serial ON mdm_dep_devices(serial_number);

    CREATE TABLE IF NOT EXISTS mdm_certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_udid TEXT,
      cert_serial TEXT,
      subject TEXT,
      not_before TEXT,
      not_after TEXT,
      certificate_pem TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mdm_dep_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT,
      consumer_key TEXT NOT NULL,
      consumer_secret TEXT NOT NULL,
      access_token TEXT NOT NULL,
      access_secret TEXT NOT NULL,
      token_expiry TEXT,
      org_name TEXT,
      org_email TEXT,
      org_address TEXT,
      last_synced_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mdm_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_number TEXT NOT NULL,
      device_udid TEXT,
      jamf_device_id TEXT,
      jamf_management_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
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

// ============================================================
// 自建 MDM 查詢函式
// ============================================================

/** 新增或更新 MDM 裝置（Authenticate 時建立，TokenUpdate 時更新） */
export function upsertMdmDevice(
  udid: string,
  fields: Partial<{
    serialNumber: string;
    deviceName: string;
    model: string;
    osVersion: string;
    pushToken: string;
    pushMagic: string;
    unlockToken: string;
    topic: string;
    enrollmentStatus: string;
    enrollmentType: string;
    deviceInfo: string;
  }>
): void {
  const db = getDb();
  const now = new Date().toISOString();

  // 先嘗試取得現有記錄
  const existing = db
    .prepare("SELECT id FROM mdm_devices WHERE udid = ?")
    .get(udid);

  if (existing) {
    const sets: string[] = ["updated_at = ?"];
    const params: (string | null)[] = [now];

    if (fields.serialNumber !== undefined) {
      sets.push("serial_number = ?");
      params.push(fields.serialNumber);
    }
    if (fields.deviceName !== undefined) {
      sets.push("device_name = ?");
      params.push(fields.deviceName);
    }
    if (fields.model !== undefined) {
      sets.push("model = ?");
      params.push(fields.model);
    }
    if (fields.osVersion !== undefined) {
      sets.push("os_version = ?");
      params.push(fields.osVersion);
    }
    if (fields.pushToken !== undefined) {
      sets.push("push_token = ?");
      params.push(fields.pushToken);
    }
    if (fields.pushMagic !== undefined) {
      sets.push("push_magic = ?");
      params.push(fields.pushMagic);
    }
    if (fields.unlockToken !== undefined) {
      sets.push("unlock_token = ?");
      params.push(fields.unlockToken);
    }
    if (fields.topic !== undefined) {
      sets.push("topic = ?");
      params.push(fields.topic);
    }
    if (fields.enrollmentStatus !== undefined) {
      sets.push("enrollment_status = ?");
      params.push(fields.enrollmentStatus);
    }
    if (fields.deviceInfo !== undefined) {
      sets.push("device_info = ?");
      params.push(fields.deviceInfo);
    }

    sets.push("last_seen_at = ?");
    params.push(now);

    params.push(udid);
    db.prepare(`UPDATE mdm_devices SET ${sets.join(", ")} WHERE udid = ?`).run(
      ...params
    );
  } else {
    db.prepare(
      `INSERT INTO mdm_devices (
        udid, serial_number, device_name, model, os_version,
        push_token, push_magic, unlock_token, topic,
        enrollment_status, enrollment_type, last_seen_at,
        enrolled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      udid,
      fields.serialNumber ?? null,
      fields.deviceName ?? null,
      fields.model ?? null,
      fields.osVersion ?? null,
      fields.pushToken ?? null,
      fields.pushMagic ?? null,
      fields.unlockToken ?? null,
      fields.topic ?? null,
      fields.enrollmentStatus ?? "pending",
      fields.enrollmentType ?? "dep",
      now,
      now,
      now,
      now
    );
  }
}

/** 取得 MDM 裝置 */
export function getMdmDevice(udid: string): MdmDeviceRow | undefined {
  return getDb()
    .prepare("SELECT * FROM mdm_devices WHERE udid = ?")
    .get(udid) as MdmDeviceRow | undefined;
}

/** 列出所有 MDM 裝置 */
export function listMdmDevices(): MdmDeviceRow[] {
  return getDb()
    .prepare("SELECT * FROM mdm_devices ORDER BY updated_at DESC")
    .all() as MdmDeviceRow[];
}

/** 排入 MDM 命令 */
export function queueMdmCommand(
  commandUuid: string,
  deviceUdid: string,
  commandType: string,
  requestPayload: string
): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO mdm_commands (command_uuid, device_udid, command_type, request_payload)
     VALUES (?, ?, ?, ?)`
  ).run(commandUuid, deviceUdid, commandType, requestPayload);
  return db.lastInsertRowId;
}

/** 取得裝置下一筆待執行命令 */
export function getNextQueuedCommand(
  deviceUdid: string
): MdmCommandRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM mdm_commands
       WHERE device_udid = ? AND status = 'queued'
       ORDER BY queued_at ASC LIMIT 1`
    )
    .get(deviceUdid) as MdmCommandRow | undefined;
}

/** 更新命令狀態 */
export function updateMdmCommand(
  commandUuid: string,
  fields: {
    status: string;
    responsePayload?: string;
    errorChain?: string;
  }
): void {
  const db = getDb();
  const now = new Date().toISOString();

  if (fields.status === "sent") {
    db.prepare(
      "UPDATE mdm_commands SET status = ?, sent_at = ? WHERE command_uuid = ?"
    ).run(fields.status, now, commandUuid);
  } else {
    db.prepare(
      `UPDATE mdm_commands SET status = ?, response_payload = ?,
       error_chain = ?, responded_at = ? WHERE command_uuid = ?`
    ).run(
      fields.status,
      fields.responsePayload ?? null,
      fields.errorChain ?? null,
      now,
      commandUuid
    );
  }
}

/** 查詢裝置命令歷史 */
export function listMdmCommands(
  deviceUdid: string,
  opts?: { limit?: number }
): MdmCommandRow[] {
  const limit = opts?.limit ?? 50;
  return getDb()
    .prepare(
      `SELECT * FROM mdm_commands WHERE device_udid = ?
       ORDER BY queued_at DESC LIMIT ?`
    )
    .all(deviceUdid, limit) as MdmCommandRow[];
}

// ---- DEP Token ----

/** 儲存 DEP Token */
export function saveDepToken(token: {
  serverName?: string;
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
  tokenExpiry?: string;
  orgName?: string;
  orgEmail?: string;
  orgAddress?: string;
}): number {
  const db = getDb();
  // 停用舊的 token
  db.prepare(
    "UPDATE mdm_dep_tokens SET is_active = 0, updated_at = ? WHERE is_active = 1"
  ).run(new Date().toISOString());

  db.prepare(
    `INSERT INTO mdm_dep_tokens (
      server_name, consumer_key, consumer_secret,
      access_token, access_secret, token_expiry,
      org_name, org_email, org_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token.serverName ?? null,
    token.consumerKey,
    token.consumerSecret,
    token.accessToken,
    token.accessSecret,
    token.tokenExpiry ?? null,
    token.orgName ?? null,
    token.orgEmail ?? null,
    token.orgAddress ?? null
  );
  return db.lastInsertRowId;
}

/** 取得目前啟用的 DEP Token */
export function getActiveDepToken(): DepTokenRow | undefined {
  return getDb()
    .prepare("SELECT * FROM mdm_dep_tokens WHERE is_active = 1 LIMIT 1")
    .get() as DepTokenRow | undefined;
}

/** 更新 DEP Token 的帳戶資訊和同步時間 */
export function updateDepTokenInfo(
  tokenId: number,
  fields: {
    serverName?: string;
    orgName?: string;
    orgEmail?: string;
    orgAddress?: string;
    lastSyncedAt?: string;
  }
): void {
  const db = getDb();
  const sets: string[] = ["updated_at = ?"];
  const params: (string | number | null)[] = [new Date().toISOString()];

  if (fields.serverName !== undefined) {
    sets.push("server_name = ?");
    params.push(fields.serverName);
  }
  if (fields.orgName !== undefined) {
    sets.push("org_name = ?");
    params.push(fields.orgName);
  }
  if (fields.orgEmail !== undefined) {
    sets.push("org_email = ?");
    params.push(fields.orgEmail);
  }
  if (fields.orgAddress !== undefined) {
    sets.push("org_address = ?");
    params.push(fields.orgAddress);
  }
  if (fields.lastSyncedAt !== undefined) {
    sets.push("last_synced_at = ?");
    params.push(fields.lastSyncedAt);
  }

  params.push(tokenId);
  db.prepare(
    `UPDATE mdm_dep_tokens SET ${sets.join(", ")} WHERE id = ?`
  ).run(...params);
}

// ---- DEP 裝置 ----

/** 新增或更新 DEP 裝置 */
export function upsertDepDevice(device: {
  serialNumber: string;
  model?: string;
  description?: string;
  color?: string;
  deviceFamily?: string;
  os?: string;
  profileUuid?: string;
  profileStatus?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO mdm_dep_devices (
      serial_number, model, description, color,
      device_family, os, profile_uuid, profile_status, dep_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(serial_number) DO UPDATE SET
      model = excluded.model,
      description = excluded.description,
      color = excluded.color,
      device_family = excluded.device_family,
      os = excluded.os,
      profile_uuid = COALESCE(excluded.profile_uuid, mdm_dep_devices.profile_uuid),
      profile_status = COALESCE(excluded.profile_status, mdm_dep_devices.profile_status),
      dep_synced_at = excluded.dep_synced_at`
  ).run(
    device.serialNumber,
    device.model ?? null,
    device.description ?? null,
    device.color ?? null,
    device.deviceFamily ?? null,
    device.os ?? null,
    device.profileUuid ?? null,
    device.profileStatus ?? "empty",
    now
  );
}

/** 列出 DEP 裝置 */
export function listDepDevices(): DepDeviceRow[] {
  return getDb()
    .prepare("SELECT * FROM mdm_dep_devices ORDER BY created_at DESC")
    .all() as DepDeviceRow[];
}

/** 更新 DEP 裝置的描述檔分配 */
export function updateDepDeviceProfile(
  serialNumber: string,
  profileUuid: string,
  profileStatus: string
): void {
  getDb()
    .prepare(
      "UPDATE mdm_dep_devices SET profile_uuid = ?, profile_status = ? WHERE serial_number = ?"
    )
    .run(profileUuid, profileStatus, serialNumber);
}

// ---- 遷移 ----

/** 建立遷移記錄 */
export function createMigration(fields: {
  serialNumber: string;
  jamfDeviceId?: string;
  jamfManagementId?: string;
}): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO mdm_migrations (serial_number, jamf_device_id, jamf_management_id)
     VALUES (?, ?, ?)`
  ).run(
    fields.serialNumber,
    fields.jamfDeviceId ?? null,
    fields.jamfManagementId ?? null
  );
  return db.lastInsertRowId;
}

/** 更新遷移狀態 */
export function updateMigrationStatus(
  id: number,
  status: string,
  errorMessage?: string
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const completed = ["dep_enrolled", "failed"].includes(status) ? now : null;

  db.prepare(
    `UPDATE mdm_migrations SET status = ?, error_message = ?, completed_at = ?
     WHERE id = ?`
  ).run(status, errorMessage ?? null, completed, id);
}

/** 列出遷移記錄 */
export function listMigrations(): MdmMigrationRow[] {
  return getDb()
    .prepare("SELECT * FROM mdm_migrations ORDER BY started_at DESC")
    .all() as MdmMigrationRow[];
}
