import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  getLatestAgentReport,
  listAgentReports,
  listUsageStats,
  resolveAgentDevice,
  saveAgentReport,
  upsertUsageStats,
} from "~/services/agent.ts";

/**
 * /api/v1/tenants/{tenantId}/agent/*
 *
 * Agent App 端只認識自家 serialNumber（與可選 udid），不知道內部 UUID。
 * - POST /report:  body 帶 serialNumber，路由內 resolve / upsert 出 mdm_devices.id
 * - GET  /reports/{serial}, /latest/{serial}, /usage/{serial}: 以 tenant scope 的 serialNumber 查
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});

const tenantSerialParam = tenantParam.extend({
  serialNumber: z.string().min(1).openapi({
    param: { name: "serialNumber", in: "path" },
    example: "F2L1234567",
  }),
});

const reportBody = z
  .object({
    serialNumber: z.string().min(1).openapi({ example: "F2L1234567" }),
    udid: z.string().optional(),
    batteryLevel: z.number().int().min(0).max(100).optional(),
    storageAvailableMb: z.number().int().nonnegative().optional(),
    storageTotalMb: z.number().int().nonnegative().optional(),
    networkType: z.string().optional(),
    networkSsid: z.string().optional(),
    screenBrightness: z.number().min(0).max(1).optional(),
    osVersion: z.string().optional(),
    appVersion: z.string().optional(),
    extraData: z.record(z.unknown()).optional(),
    reportedAt: z.string().datetime().optional(),
  })
  .openapi("AgentReportInput");

const reportItem = z
  .object({
    id: z.string().uuid(),
    batteryLevel: z.number().nullable(),
    storageAvailableMb: z.number().nullable(),
    storageTotalMb: z.number().nullable(),
    networkType: z.string().nullable(),
    networkSsid: z.string().nullable(),
    screenBrightness: z.number().nullable(),
    osVersion: z.string().nullable(),
    appVersion: z.string().nullable(),
    extraData: z.unknown().nullable(),
    reportedAt: z.string(),
  })
  .openapi("AgentReportItem");

const latestReportItem = reportItem
  .extend({
    deviceId: z.string().uuid(),
    serialNumber: z.string().nullable(),
  })
  .openapi("AgentLatestReport");

const usageStatItem = z
  .object({
    date: z.string(),
    totalMinutes: z.number().int().nonnegative(),
    pickup: z.number().int().nonnegative(),
    maxContinuous: z.number().int().nonnegative(),
    timeStats: z.record(z.number()).optional(),
  })
  .openapi("UsageStatItem");

const usageBody = z
  .object({
    serialNumber: z.string().min(1),
    sessionId: z.string().optional(),
    stats: z.array(usageStatItem).min(1),
  })
  .openapi("UsageStatsInput");

const usageRow = z
  .object({
    id: z.string().uuid(),
    date: z.string(),
    totalMinutes: z.number(),
    pickup: z.number(),
    maxContinuous: z.number(),
    timeStats: z.record(z.number()).nullable(),
    reportedAt: z.string(),
  })
  .openapi("UsageStatRow");

const usageQuery = z.object({
  date: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const reportsQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// ============================================================
// Routes
// ============================================================

const reportRoute = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/agent/reports",
  tags: ["Agent"],
  summary: "Agent App 上報設備狀態",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: reportBody } } },
  },
  responses: {
    201: {
      description: "Report saved",
      content: {
        "application/json": {
          schema: successSchema(
            z.object({ reportId: z.string().uuid(), deviceId: z.string().uuid() }),
          ),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const listReportsRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/agent/devices/{serialNumber}/reports",
  tags: ["Agent"],
  summary: "查詢設備上報歷史",
  request: { params: tenantSerialParam, query: reportsQuery },
  responses: {
    200: {
      description: "上報清單",
      content: {
        "application/json": {
          schema: successSchema(
            z.object({
              count: z.number().int().nonnegative(),
              reports: z.array(reportItem),
            }),
          ),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const latestReportRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/agent/devices/{serialNumber}/reports/latest",
  tags: ["Agent"],
  summary: "取得設備最新一筆上報",
  request: { params: tenantSerialParam },
  responses: {
    200: {
      description: "最新上報",
      content: { "application/json": { schema: successSchema(latestReportItem) } },
    },
    ...commonErrorResponses,
  },
});

const usageReportRoute = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/agent/usage",
  tags: ["Agent"],
  summary: "上報設備使用時長（同設備同日 upsert）",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: usageBody } } },
  },
  responses: {
    200: {
      description: "Stats upserted",
      content: {
        "application/json": {
          schema: successSchema(z.object({ savedCount: z.number().int() })),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const listUsageRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/agent/devices/{serialNumber}/usage",
  tags: ["Agent"],
  summary: "查詢設備使用時長",
  request: { params: tenantSerialParam, query: usageQuery },
  responses: {
    200: {
      description: "Usage rows",
      content: {
        "application/json": {
          schema: successSchema(
            z.object({
              count: z.number().int(),
              stats: z.array(usageRow),
            }),
          ),
        },
      },
    },
    ...commonErrorResponses,
  },
});

// ============================================================
// App + handlers
// ============================================================

export const agentApp = new OpenAPIHono({ defaultHook: validationFailedHook });

async function resolveDeviceBySerial(opts: {
  tenantId: string;
  serialNumber: string;
}): Promise<string> {
  const { db } = await import("~/db/client.ts");
  const row = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.serialNumber, opts.serialNumber)),
    columns: { id: true },
  });
  if (!row) {
    throw new AppError(404, "device_not_found", "Device not found in this tenant");
  }
  return row.id;
}

agentApp.openapi(reportRoute, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");

  const device = await resolveAgentDevice({
    tenantId,
    serialNumber: body.serialNumber,
    udid: body.udid ?? null,
  });

  const saved = await saveAgentReport({
    tenantId,
    deviceId: device.id,
    serialNumber: body.serialNumber,
    batteryLevel: body.batteryLevel,
    storageAvailableMb: body.storageAvailableMb,
    storageTotalMb: body.storageTotalMb,
    networkType: body.networkType,
    networkSsid: body.networkSsid,
    screenBrightness: body.screenBrightness,
    osVersion: body.osVersion,
    appVersion: body.appVersion,
    extraData: body.extraData,
    reportedAt: body.reportedAt,
  });

  return c.json(
    { ok: true as const, data: { reportId: saved.id, deviceId: device.id } },
    201,
  );
});

agentApp.openapi(listReportsRoute, async (c) => {
  const { tenantId, serialNumber } = c.req.valid("param");
  const { limit, offset } = c.req.valid("query");

  const deviceId = await resolveDeviceBySerial({ tenantId, serialNumber });
  const rows = await listAgentReports({ tenantId, deviceId, limit, offset });

  return c.json(
    {
      ok: true as const,
      data: {
        count: rows.length,
        reports: rows.map((r) => ({
          id: r.id,
          batteryLevel: r.batteryLevel,
          storageAvailableMb: r.storageAvailableMb,
          storageTotalMb: r.storageTotalMb,
          networkType: r.networkType,
          networkSsid: r.networkSsid,
          screenBrightness: r.screenBrightness,
          osVersion: r.osVersion,
          appVersion: r.appVersion,
          extraData: r.extraData,
          reportedAt: r.reportedAt.toISOString(),
        })),
      },
    },
    200,
  );
});

agentApp.openapi(latestReportRoute, async (c) => {
  const { tenantId, serialNumber } = c.req.valid("param");
  const deviceId = await resolveDeviceBySerial({ tenantId, serialNumber });
  const r = await getLatestAgentReport({ tenantId, deviceId });
  if (!r) {
    throw new AppError(404, "report_not_found", "No reports for this device yet");
  }
  return c.json(
    {
      ok: true as const,
      data: {
        id: r.id,
        deviceId: r.deviceId,
        serialNumber: r.serialNumber,
        batteryLevel: r.batteryLevel,
        storageAvailableMb: r.storageAvailableMb,
        storageTotalMb: r.storageTotalMb,
        networkType: r.networkType,
        networkSsid: r.networkSsid,
        screenBrightness: r.screenBrightness,
        osVersion: r.osVersion,
        appVersion: r.appVersion,
        extraData: r.extraData,
        reportedAt: r.reportedAt.toISOString(),
      },
    },
    200,
  );
});

agentApp.openapi(usageReportRoute, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");

  const device = await resolveAgentDevice({
    tenantId,
    serialNumber: body.serialNumber,
  });

  const { ids } = await upsertUsageStats({
    tenantId,
    deviceId: device.id,
    sessionId: body.sessionId,
    stats: body.stats,
  });

  return c.json({ ok: true as const, data: { savedCount: ids.length } }, 200);
});

agentApp.openapi(listUsageRoute, async (c) => {
  const { tenantId, serialNumber } = c.req.valid("param");
  const q = c.req.valid("query");
  const deviceId = await resolveDeviceBySerial({ tenantId, serialNumber });

  const rows = await listUsageStats({
    tenantId,
    deviceId,
    date: q.date,
    startDate: q.startDate,
    endDate: q.endDate,
    limit: q.limit,
  });

  return c.json(
    {
      ok: true as const,
      data: {
        count: rows.length,
        stats: rows.map((r) => ({
          id: r.id,
          date: r.date,
          totalMinutes: r.totalMinutes,
          pickup: r.pickup,
          maxContinuous: r.maxContinuous,
          timeStats: r.timeStats,
          reportedAt: r.reportedAt.toISOString(),
        })),
      },
    },
    200,
  );
});
