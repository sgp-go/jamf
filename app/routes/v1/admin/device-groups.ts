import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  createDeviceGroup,
  deleteDeviceGroup,
  getDeviceGroup,
  listDeviceGroups,
  updateDeviceGroup,
} from "~/services/admin/device-groups.ts";

/**
 * Device group：tenant 內的設備分組（操作員可見性邊界 + 批次派送單位）。
 * 不含使用者 / 學校 / 班級資料，僅儲存「分組識別 + 顯示名 + 可選 Jamf 綁定」。
 */

const deviceGroupSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    code: z.string(),
    displayName: z.string(),
    jamfInstanceId: z.string().uuid().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("DeviceGroup");

const createBody = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .openapi({
        description: "tenant 內唯一識別碼，例：guangfu-es / hq / dept-marketing",
        example: "guangfu-es",
      }),
    displayName: z.string().min(1).max(200).openapi({ example: "光復國小" }),
    jamfInstanceId: z.string().uuid().nullable().optional().openapi({
      description: "綁定的 Jamf 實例（1:1）；可空，之後再 PATCH 補上",
    }),
  })
  .openapi("CreateDeviceGroupInput");

const updateBody = z
  .object({
    code: z.string().min(1).max(64).optional(),
    displayName: z.string().min(1).max(200).optional(),
    jamfInstanceId: z.string().uuid().nullable().optional(),
  })
  .openapi("UpdateDeviceGroupInput");

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});
const tenantDeviceGroupParam = tenantParam.extend({
  deviceGroupId: z
    .string()
    .uuid()
    .openapi({ param: { name: "deviceGroupId", in: "path" } }),
});

const security = [{ BearerAuth: [] }];

function toDto(row: {
  id: string;
  tenantId: string;
  code: string;
  displayName: string;
  jamfInstanceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    displayName: row.displayName,
    jamfInstanceId: row.jamfInstanceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const createSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/device-groups",
  tags: ["Admin: device groups"],
  security,
  summary: "建立 device group（可選綁定 Jamf 實例）",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: successSchema(deviceGroupSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/device-groups",
  tags: ["Admin: device groups"],
  security,
  summary: "列出該 tenant 下所有 device group",
  request: { params: tenantParam },
  responses: {
    200: {
      description: "Device group list",
      content: {
        "application/json": { schema: successSchema(z.array(deviceGroupSchema)) },
      },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/device-groups/{deviceGroupId}",
  tags: ["Admin: device groups"],
  security,
  summary: "取得 device group 詳情",
  request: { params: tenantDeviceGroupParam },
  responses: {
    200: {
      description: "Device group",
      content: { "application/json": { schema: successSchema(deviceGroupSchema) } },
    },
    ...commonErrorResponses,
  },
});

const updateSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/device-groups/{deviceGroupId}",
  tags: ["Admin: device groups"],
  security,
  summary: "更新 device group（可改名 / 重綁 Jamf）",
  request: {
    params: tenantDeviceGroupParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: successSchema(deviceGroupSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/device-groups/{deviceGroupId}",
  tags: ["Admin: device groups"],
  security,
  summary: "刪除 device group（cascade 將底下設備的 device_group_id 設 null）",
  request: { params: tenantDeviceGroupParam },
  responses: {
    204: { description: "Deleted" },
    ...commonErrorResponses,
  },
});

export const deviceGroupsAdminApp = new OpenAPIHono({ defaultHook: validationFailedHook });
deviceGroupsAdminApp.use("/admin/*", adminAuth());

deviceGroupsAdminApp.openapi(createSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await createDeviceGroup({ tenantId, ...body });
  return c.json({ ok: true as const, data: toDto(row) }, 201);
});

deviceGroupsAdminApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const rows = await listDeviceGroups(tenantId);
  return c.json({ ok: true as const, data: rows.map(toDto) }, 200);
});

deviceGroupsAdminApp.openapi(detailSpec, async (c) => {
  const { tenantId, deviceGroupId } = c.req.valid("param");
  const row = await getDeviceGroup({ tenantId, deviceGroupId });
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

deviceGroupsAdminApp.openapi(updateSpec, async (c) => {
  const { tenantId, deviceGroupId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await updateDeviceGroup({ tenantId, deviceGroupId, input: body });
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

deviceGroupsAdminApp.openapi(deleteSpec, async (c) => {
  const { tenantId, deviceGroupId } = c.req.valid("param");
  await deleteDeviceGroup({ tenantId, deviceGroupId });
  return c.body(null, 204);
});
