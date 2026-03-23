/** /api/agent 路由 - 接收 Agent App 狀態回報 */

import { Hono } from "@hono/hono";
import {
  saveReport,
  getReports,
  getLatestReport,
  saveUsageStats,
  getUsageStats,
  type AgentReport,
  type UsageStatsReport,
} from "../db/sqlite.ts";

const agent = new Hono();

/** POST /api/agent/report - Agent App 上報裝置狀態 */
agent.post("/report", async (c) => {
  const body = await c.req.json<AgentReport>();

  // 基本驗證
  if (!body.deviceId || !body.serialNumber) {
    return c.json(
      { error: "deviceId and serialNumber are required" },
      400
    );
  }

  const id = saveReport(body);
  return c.json({ ok: true, reportId: id });
});

/** GET /api/agent/reports/:deviceId - 查詢裝置回報歷史 */
agent.get("/reports/:deviceId", (c) => {
  const deviceId = c.req.param("deviceId");
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);

  const reports = getReports(deviceId, { limit, offset });
  return c.json({
    deviceId,
    count: reports.length,
    reports: reports.map((r) => ({
      id: r.id,
      batteryLevel: r.battery_level,
      storageAvailableMb: r.storage_available_mb,
      storageTotalMb: r.storage_total_mb,
      networkType: r.network_type,
      networkSsid: r.network_ssid,
      screenBrightness: r.screen_brightness,
      osVersion: r.os_version,
      appVersion: r.app_version,
      extraData: r.extra_data ? JSON.parse(r.extra_data) : null,
      reportedAt: r.reported_at,
    })),
  });
});

/** GET /api/agent/latest/:deviceId - 取得裝置最新回報 */
agent.get("/latest/:deviceId", (c) => {
  const deviceId = c.req.param("deviceId");
  const report = getLatestReport(deviceId);

  if (!report) {
    return c.json({ error: "No reports found" }, 404);
  }

  return c.json({
    id: report.id,
    deviceId: report.device_id,
    serialNumber: report.serial_number,
    batteryLevel: report.battery_level,
    storageAvailableMb: report.storage_available_mb,
    storageTotalMb: report.storage_total_mb,
    networkType: report.network_type,
    networkSsid: report.network_ssid,
    screenBrightness: report.screen_brightness,
    osVersion: report.os_version,
    appVersion: report.app_version,
    reportedAt: report.reported_at,
  });
});

/** POST /api/agent/usage - 上報使用時長 */
agent.post("/usage", async (c) => {
  const body = await c.req.json<UsageStatsReport>();

  if (!body.deviceId || !body.stats || body.stats.length === 0) {
    return c.json({ error: "deviceId and stats are required" }, 400);
  }

  const ids = saveUsageStats(body);
  return c.json({ ok: true, savedCount: ids.length });
});

/** GET /api/agent/usage/:deviceId - 查詢使用時長 */
agent.get("/usage/:deviceId", (c) => {
  const deviceId = c.req.param("deviceId");
  const date = c.req.query("date");
  const startDate = c.req.query("startDate");
  const endDate = c.req.query("endDate");
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

  const rows = getUsageStats(deviceId, { date, startDate, endDate, limit });
  return c.json({
    deviceId,
    count: rows.length,
    stats: rows.map((r) => ({
      id: r.id,
      date: r.date,
      totalMinutes: r.total_minutes,
      pickup: r.pickup,
      maxContinuous: r.max_continuous,
      timeStats: r.time_stats ? JSON.parse(r.time_stats) : null,
      reportedAt: r.reported_at,
    })),
  });
});

export default agent;
