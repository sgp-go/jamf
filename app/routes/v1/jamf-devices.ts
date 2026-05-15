import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  commonErrorResponses,
  paginatedSchema,
  paginationQuery,
  successSchema,
} from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { JamfClient } from "~/services/jamf/client.ts";
import { DeviceService } from "~/services/jamf/devices.ts";
import type { CommandPayload, DeviceCommand } from "~/services/jamf/types.ts";

/**
 * /api/v1/tenants/{tenantId}/jamf-instances/{instanceId}/devices/*
 *
 * **DEPRECATED — 改用 device-centric 端點 /api/v1/tenants/{tid}/devices/*。**
 *
 * 這組路由直接以 Jamf 的數字 id 當 path param、強制 caller 知道 Jamf instance，
 * 業務代碼不該再用。保留是因為對 admin 偵錯 / 對比 Jamf 後台原始視角有用，
 * 例如「我們 DB 的設備清單跟 Jamf 後台對得起來嗎？」
 */

const tenantInstanceParams = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
  instanceId: z.string().uuid().openapi({ param: { name: "instanceId", in: "path" } }),
});
const tenantInstanceDeviceParams = tenantInstanceParams.extend({
  id: z
    .string()
    .regex(/^\d+$/, "id must be a numeric Jamf device id")
    .openapi({
      param: { name: "id", in: "path" },
      example: "42",
    }),
});

const summarySchema = z
  .object({
    id: z.string().openapi({ example: "42" }),
    name: z.string().nullable(),
    serialNumber: z.string().nullable(),
    managementId: z.string().nullable(),
  })
  .openapi("JamfDeviceSummary");

const lostModeSchema = z
  .object({
    enabled: z.boolean(),
    enforced: z.boolean(),
    message: z.string().nullable(),
    phone: z.string().nullable(),
    footnote: z.string().nullable(),
    enabledAt: z.string().nullable(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        altitude: z.number().nullable(),
        speed: z.number().nullable(),
        course: z.number().nullable(),
        horizontalAccuracy: z.number().nullable(),
        verticalAccuracy: z.number().nullable(),
        timestamp: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("JamfLostMode");

const detailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    serialNumber: z.string(),
    udid: z.string(),
    osVersion: z.string(),
    osBuild: z.string(),
    managed: z.boolean(),
    ipAddress: z.string().nullable(),
    enrollmentMethod: z.string().nullable(),
    lastInventoryUpdate: z.string().nullable(),
    managementId: z.string(),
    groups: z.array(
      z.object({
        groupId: z.string(),
        groupName: z.string(),
        smart: z.boolean(),
      }),
    ),
    hardware: z
      .object({
        model: z.string(),
        modelIdentifier: z.string(),
        batteryLevel: z.number(),
        capacityMb: z.number(),
        availableMb: z.number(),
        percentageUsed: z.number(),
        supervised: z.boolean(),
      })
      .nullable(),
    security: z.unknown().nullable(),
    lostMode: lostModeSchema.nullable(),
    applications: z.array(z.unknown()),
    configurationProfiles: z.array(z.unknown()),
  })
  .openapi("JamfDeviceDetail");

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
    command: z.enum(VALID_COMMANDS).openapi({ example: "DEVICE_LOCK" }),
    lostModeMessage: z.string().optional(),
    lostModePhone: z.string().optional(),
    lostModeFootnote: z.string().optional(),
  })
  .openapi("JamfCommandRequest");

const commandResultSchema = z
  .object({
    command: z.string(),
    result: z.unknown(),
  })
  .openapi("JamfCommandResult");

const appLockResultSchema = z
  .object({ action: z.enum(["enabled", "disabled"]) })
  .openapi("AppLockResult");

// ============================================================
// Routes
// ============================================================

const listRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/jamf-instances/{instanceId}/devices",
  tags: ["Admin: jamf raw view"],
  deprecated: true,
  summary: "列出 Jamf 實例下的設備",
  request: { params: tenantInstanceParams, query: paginationQuery },
  responses: {
    200: {
      description: "設備清單",
      content: { "application/json": { schema: paginatedSchema(summarySchema) } },
    },
    ...commonErrorResponses,
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/jamf-instances/{instanceId}/devices/{id}",
  tags: ["Admin: jamf raw view"],
  deprecated: true,
  summary: "取得設備詳情（v2 detail + Classic Lost Mode）",
  request: { params: tenantInstanceDeviceParams },
  responses: {
    200: {
      description: "設備詳情",
      content: { "application/json": { schema: successSchema(detailSchema) } },
    },
    ...commonErrorResponses,
  },
});

const commandRoute = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/jamf-instances/{instanceId}/devices/{id}/command",
  tags: ["Admin: jamf raw view"],
  deprecated: true,
  summary: "派送管理命令到設備",
  request: {
    params: tenantInstanceDeviceParams,
    body: { content: { "application/json": { schema: commandBodySchema } } },
  },
  responses: {
    200: {
      description: "命令已送出（不代表已執行，需查設備回報）",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const enableAppLockRoute = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/jamf-instances/{instanceId}/devices/{id}/app-lock",
  tags: ["Admin: jamf raw view"],
  deprecated: true,
  summary: "啟用單 App 模式（加入 jamf_instances.app_lock_group_id 群組）",
  request: { params: tenantInstanceDeviceParams },
  responses: {
    200: {
      description: "已加入 group + BlankPush",
      content: { "application/json": { schema: successSchema(appLockResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const disableAppLockRoute = createRoute({
  method: "delete",
  path: "/tenants/{tenantId}/jamf-instances/{instanceId}/devices/{id}/app-lock",
  tags: ["Admin: jamf raw view"],
  deprecated: true,
  summary: "停用單 App 模式（從群組移除）",
  request: { params: tenantInstanceDeviceParams },
  responses: {
    200: {
      description: "已從 group 移除 + BlankPush",
      content: { "application/json": { schema: successSchema(appLockResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ============================================================
// Handlers
// ============================================================

interface JamfV2ListPage {
  totalCount: number;
  results: Array<{
    id: string;
    name: string;
    serialNumber: string;
    managementId: string;
  }>;
}

export const jamfDevicesApp = new OpenAPIHono({ defaultHook: validationFailedHook });

jamfDevicesApp.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
});

jamfDevicesApp.openapi(listRoute, async (c) => {
  const { tenantId, instanceId } = c.req.valid("param");
  const { page, limit } = c.req.valid("query");

  const client = await JamfClient.forInstance({ tenantId, instanceId });
  const svc = new DeviceService(client);
  const upstream = await svc.listMobileDevices({ page: page - 1, pageSize: limit });

  // 強制把 results 型別收斂到 summarySchema 接受的 shape
  const list = upstream as unknown as JamfV2ListPage;

  return c.json(
    {
      ok: true as const,
      data: list.results.map((d) => ({
        id: d.id,
        name: d.name ?? null,
        serialNumber: d.serialNumber ?? null,
        managementId: d.managementId ?? null,
      })),
      meta: { total: list.totalCount, page, limit },
    },
    200,
  );
});

jamfDevicesApp.openapi(detailRoute, async (c) => {
  const { tenantId, instanceId, id } = c.req.valid("param");

  const client = await JamfClient.forInstance({ tenantId, instanceId });
  const svc = new DeviceService(client);

  const [detail, lostMode] = await Promise.all([
    svc.getMobileDevice(id),
    svc.getLostModeStatus(id),
  ]);

  const ios = detail.ios;

  return c.json(
    {
      ok: true as const,
      data: {
        id: detail.id,
        name: detail.name,
        serialNumber: detail.serialNumber,
        udid: detail.udid,
        osVersion: detail.osVersion,
        osBuild: detail.osBuild,
        managed: detail.managed,
        ipAddress: detail.ipAddress ?? null,
        enrollmentMethod: detail.enrollmentMethod ?? null,
        lastInventoryUpdate: detail.lastInventoryUpdateTimestamp ?? null,
        managementId: detail.managementId,
        groups: detail.groups,
        hardware: ios
          ? {
              model: ios.model,
              modelIdentifier: ios.modelIdentifier,
              batteryLevel: ios.batteryLevel,
              capacityMb: ios.capacityMb,
              availableMb: ios.availableMb,
              percentageUsed: ios.percentageUsed,
              supervised: ios.supervised,
            }
          : null,
        security: ios?.security ?? null,
        lostMode,
        applications: ios?.applications ?? [],
        configurationProfiles: ios?.configurationProfiles ?? [],
      },
    },
    200,
  );
});

jamfDevicesApp.openapi(commandRoute, async (c) => {
  const { tenantId, instanceId, id } = c.req.valid("param");
  const body = c.req.valid("json");

  const client = await JamfClient.forInstance({ tenantId, instanceId });
  const svc = new DeviceService(client);

  const detail = await svc.getMobileDevice(id);

  const payload: CommandPayload = { commandType: body.command };
  if (body.lostModeMessage) payload.lostModeMessage = body.lostModeMessage;
  if (body.lostModePhone) payload.lostModePhone = body.lostModePhone;
  if (body.lostModeFootnote) payload.lostModeFootnote = body.lostModeFootnote;

  const result = await svc.sendCommand(detail.managementId, payload);

  return c.json(
    {
      ok: true as const,
      data: { command: body.command, result },
    },
    200,
  );
});

async function resolveAppLockGroup(opts: {
  tenantId: string;
  instanceId: string;
}): Promise<number | null> {
  const { db } = await import("~/db/client.ts");
  const row = await db.query.jamfInstances.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.id, opts.instanceId), eq(t.tenantId, opts.tenantId)),
    columns: { appLockGroupId: true },
  });
  if (!row) {
    throw new AppError(404, "jamf_instance_not_found", "Jamf instance not found");
  }
  return row.appLockGroupId;
}

jamfDevicesApp.openapi(enableAppLockRoute, async (c) => {
  const { tenantId, instanceId, id } = c.req.valid("param");
  const groupId = await resolveAppLockGroup({ tenantId, instanceId });
  const client = await JamfClient.forInstance({ tenantId, instanceId });
  await new DeviceService(client).enableAppLock(id, groupId);
  return c.json({ ok: true as const, data: { action: "enabled" as const } }, 200);
});

jamfDevicesApp.openapi(disableAppLockRoute, async (c) => {
  const { tenantId, instanceId, id } = c.req.valid("param");
  const groupId = await resolveAppLockGroup({ tenantId, instanceId });
  const client = await JamfClient.forInstance({ tenantId, instanceId });
  await new DeviceService(client).disableAppLock(id, groupId);
  return c.json({ ok: true as const, data: { action: "disabled" as const } }, 200);
});
