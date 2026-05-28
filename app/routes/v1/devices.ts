import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  commonErrorResponses,
  paginatedSchema,
  paginationQuery,
  successSchema,
} from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  getDeviceFullDetail,
  getDeviceTelemetry,
  listDeviceCommands,
  listDevicesInTenant,
  sendCommandToDevice,
  toggleAppLock,
  unenrollDeviceInTenant,
  updateDeviceInTenant,
} from "~/services/devices.ts";
import type { DeviceCommand } from "~/services/jamf/types.ts";

/**
 * /api/v1/tenants/{tenantId}/devices/*
 *
 * 業務層的 device-centric 端點 — 操作員只看「設備」，不必知道哪台 Jamf。
 * 服務端從 mdm_devices.jamf_instance_id 自動路由。
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});
const tenantDeviceParam = tenantParam.extend({
  deviceId: z.string().uuid().openapi({ param: { name: "deviceId", in: "path" } }),
});
const tenantDeviceGroupParam = tenantParam.extend({
  deviceGroupId: z
    .string()
    .uuid()
    .openapi({ param: { name: "deviceGroupId", in: "path" } }),
});

const deviceItemSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    deviceGroupId: z.string().uuid().nullable(),
    jamfInstanceId: z.string().uuid().nullable(),
    serialNumber: z.string().nullable(),
    udid: z.string().nullable(),
    deviceName: z.string().nullable(),
    model: z.string().nullable(),
    osVersion: z.string().nullable(),
    jamfDeviceId: z.string().nullable(),
    jamfManagementId: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
  })
  .openapi("Device");

const listQuery = paginationQuery.extend({
  deviceGroupId: z.string().uuid().optional(),
  search: z.string().optional().openapi({
    description: "在 serial / device name / udid 模糊比對",
  }),
});

const deviceGroupListQuery = paginationQuery.extend({
  search: z.string().optional(),
});

const VALID_COMMANDS = [
  "DEVICE_LOCK",
  "ERASE_DEVICE",
  "CLEAR_PASSCODE",
  "DEVICE_INFORMATION",
  "RESTART_DEVICE",
  "SHUT_DOWN_DEVICE",
  "ENABLE_LOST_MODE",
  "DISABLE_LOST_MODE",
] as const satisfies readonly DeviceCommand[];

const commandBodySchema = z
  .object({
    command: z.enum(VALID_COMMANDS),
    lostModeMessage: z.string().optional(),
    lostModePhone: z.string().optional(),
    lostModeFootnote: z.string().optional(),
  })
  .openapi("DeviceCommandRequest");

const updateDeviceBody = z
  .object({
    deviceName: z.string().min(1).max(200).optional().openapi({
      description: "重命名設備（Jamf/MDM 本地顯示名）",
      example: "guangfu-es-001",
    }),
    deviceGroupId: z.string().uuid().nullable().optional().openapi({
      description: "轉組；傳 null 移出當前分組",
    }),
  })
  .openapi("UpdateDeviceInput");

const commandHistoryItemSchema = z
  .object({
    commandUuid: z.string(),
    commandType: z.string(),
    status: z.enum([
      "queued",
      "sent",
      "acknowledged",
      "error",
      "not_now",
      "idle",
      "expired",
    ]),
    platform: z.enum(["apple", "windows"]),
    cspPath: z.string().nullable(),
    syncmlVerb: z.string().nullable(),
    errorChain: z.array(z.unknown()).nullable(),
    queuedAt: z.string(),
    sentAt: z.string().nullable(),
    respondedAt: z.string().nullable(),
  })
  .openapi("DeviceCommandHistoryItem");

function toCommandHistoryItem(row: {
  commandUuid: string;
  commandType: string;
  status:
    | "queued"
    | "sent"
    | "acknowledged"
    | "error"
    | "not_now"
    | "idle"
    | "expired";
  platform: "apple" | "windows";
  cspPath: string | null;
  syncmlVerb: string | null;
  errorChain: unknown;
  queuedAt: Date;
  sentAt: Date | null;
  respondedAt: Date | null;
}) {
  return {
    commandUuid: row.commandUuid,
    commandType: row.commandType,
    status: row.status,
    platform: row.platform,
    cspPath: row.cspPath,
    syncmlVerb: row.syncmlVerb,
    errorChain: Array.isArray(row.errorChain) ? row.errorChain : null,
    queuedAt: row.queuedAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    respondedAt: row.respondedAt?.toISOString() ?? null,
  };
}

function toItem(row: {
  id: string;
  tenantId: string;
  deviceGroupId: string | null;
  jamfInstanceId: string | null;
  serialNumber: string | null;
  udid: string | null;
  deviceName: string | null;
  model: string | null;
  osVersion: string | null;
  jamfDeviceId: string | null;
  jamfManagementId: string | null;
  lastSyncedAt: Date | null;
  lastSeenAt: Date | null;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    deviceGroupId: row.deviceGroupId,
    jamfInstanceId: row.jamfInstanceId,
    serialNumber: row.serialNumber,
    udid: row.udid,
    deviceName: row.deviceName,
    model: row.model,
    osVersion: row.osVersion,
    jamfDeviceId: row.jamfDeviceId,
    jamfManagementId: row.jamfManagementId,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  };
}

// ============================================================
// Routes
// ============================================================

const listSpec = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/devices",
  tags: ["Devices"],
  summary: "列出 tenant 內全部設備（跨校）",
  request: { params: tenantParam, query: listQuery },
  responses: {
    200: {
      description: "Device list",
      content: { "application/json": { schema: paginatedSchema(deviceItemSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listByDeviceGroupSpec = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/device-groups/{deviceGroupId}/devices",
  tags: ["Devices"],
  summary: "列出指定 device group 的設備",
  request: { params: tenantDeviceGroupParam, query: deviceGroupListQuery },
  responses: {
    200: {
      description: "Device list",
      content: { "application/json": { schema: paginatedSchema(deviceItemSchema) } },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/devices/{deviceId}",
  tags: ["Devices"],
  summary: "設備詳情（本地 + 即時 Jamf）",
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "Detail",
      content: {
        "application/json": {
          schema: successSchema(
            z.object({
              device: deviceItemSchema,
              jamf: z
                .object({
                  detail: z.unknown(),
                  lostMode: z.unknown().nullable(),
                })
                .nullable(),
              jamfError: z.string().nullable(),
            }),
          ),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const updateSpec = createRoute({
  method: "patch",
  path: "/tenants/{tenantId}/devices/{deviceId}",
  tags: ["Devices"],
  summary: "更新設備（重命名 / 轉組）",
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: updateDeviceBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: successSchema(deviceItemSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/tenants/{tenantId}/devices/{deviceId}",
  tags: ["Devices"],
  summary: "解除設備納管（軟刪：標記 enrollment_status=unenrolled，保留紀錄）",
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "Unenrolled",
      content: { "application/json": { schema: successSchema(deviceItemSchema) } },
    },
    ...commonErrorResponses,
  },
});

const commandSpec = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/devices/{deviceId}/commands",
  tags: ["Devices"],
  summary: "派送管理命令（內部自動找對應 Jamf）",
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: commandBodySchema } } },
  },
  responses: {
    200: {
      description: "Command sent",
      content: {
        "application/json": {
          schema: successSchema(
            z.object({ command: z.string(), result: z.unknown() }),
          ),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const commandHistorySpec = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/devices/{deviceId}/commands",
  tags: ["Devices"],
  summary: "命令歷史（按 queued_at desc 分頁）",
  request: { params: tenantDeviceParam, query: paginationQuery },
  responses: {
    200: {
      description: "Command history",
      content: {
        "application/json": {
          schema: paginatedSchema(commandHistoryItemSchema),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const agentReportItemSchema = z
  .object({
    id: z.string().uuid(),
    batteryLevel: z.number().int().nullable(),
    storageAvailableMb: z.number().int().nullable(),
    storageTotalMb: z.number().int().nullable(),
    networkType: z.string().nullable(),
    networkSsid: z.string().nullable(),
    screenBrightness: z.number().nullable(),
    osVersion: z.string().nullable(),
    appVersion: z.string().nullable(),
    reportedAt: z.string(),
  })
  .openapi("AgentReportItem");

const usageStatItemSchema = z
  .object({
    date: z.string().openapi({ example: "2026-05-28" }),
    totalMinutes: z.number().int(),
    pickup: z.number().int(),
    maxContinuous: z.number().int(),
    timeStats: z.record(z.number()).nullable(),
  })
  .openapi("DeviceUsageStatItem");

const telemetrySchema = z
  .object({
    latestReport: agentReportItemSchema.nullable(),
    usageLastWeek: z.array(usageStatItemSchema),
  })
  .openapi("DeviceTelemetry");

function toAgentReportItem(row: {
  id: string;
  batteryLevel: number | null;
  storageAvailableMb: number | null;
  storageTotalMb: number | null;
  networkType: string | null;
  networkSsid: string | null;
  screenBrightness: number | null;
  osVersion: string | null;
  appVersion: string | null;
  reportedAt: Date;
}) {
  return {
    id: row.id,
    batteryLevel: row.batteryLevel,
    storageAvailableMb: row.storageAvailableMb,
    storageTotalMb: row.storageTotalMb,
    networkType: row.networkType,
    networkSsid: row.networkSsid,
    screenBrightness: row.screenBrightness,
    osVersion: row.osVersion,
    appVersion: row.appVersion,
    reportedAt: row.reportedAt.toISOString(),
  };
}

function toUsageStatItem(row: {
  date: string;
  totalMinutes: number;
  pickup: number;
  maxContinuous: number;
  timeStats: Record<string, number> | null;
}) {
  return {
    date: row.date,
    totalMinutes: row.totalMinutes,
    pickup: row.pickup,
    maxContinuous: row.maxContinuous,
    timeStats: row.timeStats,
  };
}

const telemetrySpec = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/devices/{deviceId}/telemetry",
  tags: ["Devices"],
  summary: "Agent 端 telemetry（最新一筆狀態 + 最近 7 天使用統計）",
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "Telemetry",
      content: { "application/json": { schema: successSchema(telemetrySchema) } },
    },
    ...commonErrorResponses,
  },
});

const enableAppLockSpec = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/devices/{deviceId}/app-lock",
  tags: ["Devices"],
  summary: "啟用單 App 模式",
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "Enabled",
      content: {
        "application/json": {
          schema: successSchema(z.object({ action: z.literal("enabled") })),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const disableAppLockSpec = createRoute({
  method: "delete",
  path: "/tenants/{tenantId}/devices/{deviceId}/app-lock",
  tags: ["Devices"],
  summary: "停用單 App 模式",
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "Disabled",
      content: {
        "application/json": {
          schema: successSchema(z.object({ action: z.literal("disabled") })),
        },
      },
    },
    ...commonErrorResponses,
  },
});

// ============================================================
// Handlers
// ============================================================

export const devicesApp = new OpenAPIHono({ defaultHook: validationFailedHook });

devicesApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const { page, limit, deviceGroupId, search } = c.req.valid("query");

  const { rows, total } = await listDevicesInTenant({
    tenantId,
    deviceGroupId,
    search,
    page,
    limit,
  });
  return c.json(
    {
      ok: true as const,
      data: rows.map(toItem),
      meta: { total, page, limit },
    },
    200,
  );
});

devicesApp.openapi(listByDeviceGroupSpec, async (c) => {
  const { tenantId, deviceGroupId } = c.req.valid("param");
  const { page, limit, search } = c.req.valid("query");
  const { rows, total } = await listDevicesInTenant({
    tenantId,
    deviceGroupId,
    search,
    page,
    limit,
  });
  return c.json(
    {
      ok: true as const,
      data: rows.map(toItem),
      meta: { total, page, limit },
    },
    200,
  );
});

devicesApp.openapi(detailSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const result = await getDeviceFullDetail({ tenantId, deviceId });
  return c.json(
    {
      ok: true as const,
      data: {
        device: toItem(result.device),
        jamf: result.jamf,
        jamfError: result.jamfError,
      },
    },
    200,
  );
});

devicesApp.openapi(updateSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await updateDeviceInTenant({ tenantId, deviceId, input: body });
  return c.json({ ok: true as const, data: toItem(row) }, 200);
});

devicesApp.openapi(deleteSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const row = await unenrollDeviceInTenant({ tenantId, deviceId });
  return c.json({ ok: true as const, data: toItem(row) }, 200);
});

devicesApp.openapi(commandSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await sendCommandToDevice({
    tenantId,
    deviceId,
    payload: {
      commandType: body.command,
      ...(body.lostModeMessage && { lostModeMessage: body.lostModeMessage }),
      ...(body.lostModePhone && { lostModePhone: body.lostModePhone }),
      ...(body.lostModeFootnote && { lostModeFootnote: body.lostModeFootnote }),
    },
  });
  return c.json(
    {
      ok: true as const,
      data: { command: body.command, result },
    },
    200,
  );
});

devicesApp.openapi(commandHistorySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { page, limit } = c.req.valid("query");
  const { rows, total } = await listDeviceCommands({
    tenantId,
    deviceId,
    page,
    limit,
  });
  return c.json(
    {
      ok: true as const,
      data: rows.map(toCommandHistoryItem),
      meta: { total, page, limit },
    },
    200,
  );
});

devicesApp.openapi(telemetrySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { latestReport, usageLastWeek } = await getDeviceTelemetry({
    tenantId,
    deviceId,
  });
  return c.json(
    {
      ok: true as const,
      data: {
        latestReport: latestReport ? toAgentReportItem(latestReport) : null,
        usageLastWeek: usageLastWeek.map(toUsageStatItem),
      },
    },
    200,
  );
});

devicesApp.openapi(enableAppLockSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  await toggleAppLock({ tenantId, deviceId, enable: true });
  return c.json({ ok: true as const, data: { action: "enabled" as const } }, 200);
});

devicesApp.openapi(disableAppLockSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  await toggleAppLock({ tenantId, deviceId, enable: false });
  return c.json({ ok: true as const, data: { action: "disabled" as const } }, 200);
});
