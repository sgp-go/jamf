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

/**
 * /api/v1/tenants/{tenantId}/devices/*
 *
 * 業務層的 device-centric 端點 — 操作員只看「設備」，不必知道哪台 Jamf。
 * 服務端從 mdm_devices.jamf_instance_id 自動路由。
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});
const tenantDeviceParam = tenantParam.extend({
  deviceId: z.string().uuid().openapi({
    param: { name: "deviceId", in: "path" },
    description: "設備 UUID",
    example: "9d4c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c",
  }),
});
const tenantDeviceGroupParam = tenantParam.extend({
  deviceGroupId: z.string().uuid().openapi({
    param: { name: "deviceGroupId", in: "path" },
    description: "設備分組 UUID",
    example: "a1b2c3d4-5e6f-7a8b-9c0d-e1f2a3b4c5d6",
  }),
});

const deviceItemSchema = z
  .object({
    id: z.string().uuid().openapi({ example: "9d4c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c" }),
    tenantId: z.string().uuid().openapi({ example: "6f9c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c" }),
    platform: z.enum(["apple", "windows"]).openapi({
      description: "設備平台（決定命令路由與可用功能集）",
      example: "apple",
    }),
    deviceGroupId: z.string().uuid().nullable().openapi({
      description: "設備分組 ID；null = 未分組",
    }),
    jamfInstanceId: z.string().uuid().nullable(),
    serialNumber: z.string().nullable().openapi({ example: "F2L1234567" }),
    udid: z.string().nullable().openapi({
      example: "00008140-00011C2201D3001C",
      description: "Apple UDID / Windows DeviceID",
    }),
    deviceName: z.string().nullable().openapi({ example: "guangfu-es-001" }),
    model: z.string().nullable().openapi({ example: "iPhone15,3" }),
    osVersion: z.string().nullable().openapi({ example: "17.5" }),
    jamfDeviceId: z.string().nullable(),
    jamfManagementId: z.string().nullable(),
    lastSyncedAt: z.string().nullable().openapi({
      example: "2026-05-28T10:30:00Z",
      description: "ISO 8601 UTC 時間戳",
    }),
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
  // 跨平台中性命令（推薦：Apple / Windows 自動路由）
  "LOCK",
  "WIPE",
  "REBOOT",
  // Jamf 原生命令（Apple-only legacy；Windows 收到 → 400）
  "DEVICE_LOCK",
  "ERASE_DEVICE",
  "CLEAR_PASSCODE",
  "DEVICE_INFORMATION",
  "RESTART_DEVICE",
  "SHUT_DOWN_DEVICE",
  "ENABLE_LOST_MODE",
  "DISABLE_LOST_MODE",
] as const;

const commandBodySchema = z
  .object({
    command: z.enum(VALID_COMMANDS).openapi({
      example: "LOCK",
      description:
        "Cross-platform: LOCK / WIPE / REBOOT (+ ENABLE_LOST_MODE / DISABLE_LOST_MODE). " +
        "On Windows, LOCK == ENABLE_LOST_MODE: writes a lock-state Registry flag (no immediate-lock CSP " +
        "on desktop) that the Agent App watches to show a full-screen lock window with contact info; " +
        "DISABLE_LOST_MODE unlocks. REBOOT is a separate command (no longer used as a LOCK fallback). " +
        "lostModeMessage / lostModePhone are shown on the Windows lock window and passed to Jamf Lost Mode on Apple. " +
        "Jamf-native enums (DEVICE_LOCK, ERASE_DEVICE, RESTART_DEVICE, etc.) only work for Apple devices; " +
        "Windows requests with these return 400.",
    }),
    lostModeMessage: z.string().optional(),
    lostModePhone: z.string().optional(),
    lostModeFootnote: z.string().optional(),
  })
  .openapi("DeviceCommandRequest");

const deviceDetailSchema = z
  .object({
    device: deviceItemSchema,
    jamf: z
      .object({
        detail: z.unknown(),
        lostMode: z.unknown().nullable(),
      })
      .nullable()
      .openapi({
        description: "即時打 Jamf 補的頂層資料；Jamf 失敗時 null + jamfError 含原因",
      }),
    jamfError: z.string().nullable(),
  })
  .openapi("DeviceDetail");

const deviceCommandResultSchema = z
  .object({
    command: z.string().openapi({ example: "WIPE" }),
    result: z.unknown().openapi({
      description: "Apple：Jamf API 原始 response；Windows：{commandUuid}",
    }),
  })
  .openapi("DeviceCommandResult");

const appLockEnabledSchema = z
  .object({ action: z.literal("enabled") })
  .openapi("AppLockEnabledResult");

const appLockDisabledSchema = z
  .object({ action: z.literal("disabled") })
  .openapi("AppLockDisabledResult");

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
    commandUuid: z.string().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    commandType: z.string().openapi({
      example: "LOCK",
      description: "命令類型標籤（如 LOCK / WIPE / REBOOT / RemoteWipe / msi_install）",
    }),
    status: z.enum([
      "queued",
      "sent",
      "acknowledged",
      "error",
      "not_now",
      "idle",
      "expired",
    ]).openapi({
      example: "acknowledged",
      description: "命令生命週期狀態。Windows SyncML Status 200 = acknowledged",
    }),
    platform: z.enum(["apple", "windows"]).openapi({ example: "windows" }),
    cspPath: z.string().nullable().openapi({
      example: "./Device/Vendor/MSFT/RemoteWipe/doWipe",
      description: "Windows CSP 路徑（Apple 為 null）",
    }),
    syncmlVerb: z.string().nullable().openapi({
      example: "Exec",
      description: "SyncML 動詞 Add / Replace / Exec / Get / Delete（Windows）",
    }),
    errorChain: z.array(z.unknown()).nullable(),
    queuedAt: z.string().openapi({ example: "2026-05-28T10:30:00Z" }),
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
  platform: "apple" | "windows";
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
    platform: row.platform,
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
  tags: ["設備查詢與操作"],
  summary: "列出 tenant 內全部設備（跨分組）",
  description: [
    "回傳指定 tenant 下所有設備，支援分頁 + 搜尋 + 按 device group 過濾。",
    "",
    "**鑑權**：無（tenant 端點）。",
    "",
    "操作員只看「設備」統一視角，不必知道底層走 Jamf 還是自建 MDM。",
  ].join("\n"),
  request: { params: tenantParam, query: listQuery },
  responses: {
    200: {
      description: "設備分頁列表",
      content: { "application/json": { schema: paginatedSchema(deviceItemSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listByDeviceGroupSpec = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/device-groups/{deviceGroupId}/devices",
  tags: ["設備查詢與操作"],
  summary: "列出指定分組的設備",
  description: "回傳指定 device group 下的設備（分頁 + 搜尋）。等價於 list 端點加 `deviceGroupId` 過濾。\n\n**鑑權**：無。",
  request: { params: tenantDeviceGroupParam, query: deviceGroupListQuery },
  responses: {
    200: {
      description: "設備分頁列表",
      content: { "application/json": { schema: paginatedSchema(deviceItemSchema) } },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/devices/{deviceId}",
  tags: ["設備查詢與操作"],
  summary: "設備詳情（本地 DB + 即時 Jamf 補充）",
  description: [
    "回傳設備的完整資訊。Apple 設備會即時打 Jamf API 補充詳細欄位（hardware / lostMode 等）。",
    "",
    "**鑑權**：無。",
    "",
    "若 Jamf 查詢失敗，`jamf` 為 `null` 且 `jamfError` 含失敗原因（不影響本地資料回傳）。",
  ].join("\n"),
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "設備詳情物件（含本地 + Jamf 即時資料）",
      content: {
        "application/json": { schema: successSchema(deviceDetailSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const updateSpec = createRoute({
  method: "patch",
  path: "/tenants/{tenantId}/devices/{deviceId}",
  tags: ["設備查詢與操作"],
  summary: "更新設備（重命名 / 轉組）",
  description: "部分更新設備屬性。可修改顯示名稱或調整所屬分組。\n\n**鑑權**：無。",
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: updateDeviceBody } } },
  },
  responses: {
    200: {
      description: "更新後的設備物件",
      content: { "application/json": { schema: successSchema(deviceItemSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/tenants/{tenantId}/devices/{deviceId}",
  tags: ["設備查詢與操作"],
  summary: "解除設備納管（軟刪，保留紀錄）",
  description: [
    "標記設備為 `unenrolled` 狀態（軟刪除），歷史資料保留。",
    "",
    "**鑑權**：無。",
    "",
    "**注意**：此操作僅更新資料庫狀態，不會觸發設備端的 MDM unenroll 流程。",
    "如需完整解除納管，請先派送 unenroll 命令再呼叫此端點。",
  ].join("\n"),
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "更新後的設備物件（enrollment_status=unenrolled）",
      content: { "application/json": { schema: successSchema(deviceItemSchema) } },
    },
    ...commonErrorResponses,
  },
});

const commandSpec = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/devices/{deviceId}/commands",
  tags: ["設備查詢與操作"],
  summary: "派送管理命令（跨平台，自動路由）",
  description: [
    "向設備派送管理命令。Apple 走 Jamf API，Windows 走自建 MDM CSP，自動路由。",
    "",
    "**鑑權**：無。",
    "",
    "**跨平台命令**：`LOCK` / `WIPE` / `REBOOT`（+ `ENABLE_LOST_MODE` / `DISABLE_LOST_MODE`）。",
    "Windows 上 `LOCK` 等價 `ENABLE_LOST_MODE`：寫 Registry flag，Agent App 監聽後顯示鎖屏。",
    "",
    "**Apple 專用命令**：`DEVICE_LOCK` / `ERASE_DEVICE` / `CLEAR_PASSCODE` 等 Jamf 原生命令，",
    "Windows 設備收到會回 400。",
  ].join("\n"),
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: commandBodySchema } } },
  },
  responses: {
    200: {
      description: "命令已派送（Apple: Jamf API response / Windows: commandUuid）",
      content: {
        "application/json": { schema: successSchema(deviceCommandResultSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const commandHistorySpec = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/devices/{deviceId}/commands",
  tags: ["設備查詢與操作"],
  summary: "查詢設備命令歷史（分頁）",
  description: "回傳設備的所有命令記錄（LOCK / WIPE / MSI install 等），按 `queuedAt` 降序排列。\n\n**鑑權**：無。",
  request: { params: tenantDeviceParam, query: paginationQuery },
  responses: {
    200: {
      description: "命令歷史分頁列表",
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
  tags: ["設備查詢與操作"],
  summary: "設備遙測資料（最新狀態 + 近 7 天使用統計）",
  description: [
    "聚合兩項 Agent App 上報資料：",
    "",
    "- **latestReport**：最新一筆設備健康上報（電量 / 儲存 / 網路 / OS 版本）",
    "- **usageLastWeek**：近 7 天每日使用統計（總時長 / 拿起次數 / 最長連續使用）",
    "",
    "**鑑權**：無。",
  ].join("\n"),
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "遙測聚合物件",
      content: { "application/json": { schema: successSchema(telemetrySchema) } },
    },
    ...commonErrorResponses,
  },
});

const enableAppLockSpec = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/devices/{deviceId}/app-lock",
  tags: ["設備查詢與操作"],
  summary: "啟用單 App 模式（Kiosk）",
  description: [
    "啟用設備的單 App 模式（Kiosk）。",
    "",
    "- **Apple**：透過 Jamf 派發 single-app profile",
    "- **Windows**：透過 MDM 動態安裝 Assigned Access profile + InstallProfile 命令",
    "",
    "**鑑權**：無。",
  ].join("\n"),
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "已啟用",
      content: {
        "application/json": { schema: successSchema(appLockEnabledSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const disableAppLockSpec = createRoute({
  method: "delete",
  path: "/tenants/{tenantId}/devices/{deviceId}/app-lock",
  tags: ["設備查詢與操作"],
  summary: "停用單 App 模式（Kiosk）",
  description: [
    "停用設備的單 App 模式。",
    "",
    "- **Apple**：透過 Jamf 移除 single-app profile",
    "- **Windows**：透過 MDM RemoveProfile 命令移除 Assigned Access profile",
    "",
    "**鑑權**：無。",
  ].join("\n"),
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "已停用",
      content: {
        "application/json": { schema: successSchema(appLockDisabledSchema) },
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
    command: body.command,
    ...(body.lostModeMessage && { lostModeMessage: body.lostModeMessage }),
    ...(body.lostModePhone && { lostModePhone: body.lostModePhone }),
    ...(body.lostModeFootnote && { lostModeFootnote: body.lostModeFootnote }),
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
