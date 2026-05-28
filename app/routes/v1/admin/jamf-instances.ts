import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  createJamfInstance,
  deleteJamfInstance,
  getJamfInstance,
  listJamfInstances,
  toJamfInstanceDto,
  updateJamfInstance,
  verifyJamfInstance,
} from "~/services/admin/jamf-instances.ts";
import { syncDevicesFromJamf } from "~/services/sync.ts";

const jamfInstanceSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    displayName: z.string(),
    baseUrl: z.string().url(),
    clientId: z.string(),
    clientSecretSuffix: z.string().openapi({
      description: "前置 **** + secret 最後 4 字，僅供確認；完整 secret 不會回傳",
      example: "****cdef",
    }),
    appLockGroupId: z.number().int().nullable(),
    isActive: z.boolean(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("JamfInstance");

const createBody = z
  .object({
    displayName: z.string().min(1).max(200).openapi({ example: "Demo 國小 Jamf" }),
    baseUrl: z
      .string()
      .url()
      .regex(/^https?:\/\//)
      .openapi({ example: "https://demo.jamfcloud.com" }),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).openapi({
      description: "client_credentials grant 的 secret，存入後不可讀回",
    }),
    appLockGroupId: z.number().int().nullable().optional().openapi({
      description: "App Lock 對應的 Static Group ID（Jamf 內部數字），未配置則 app-lock API 會回 409",
    }),
    notes: z.string().nullable().optional(),
  })
  .openapi("CreateJamfInstanceInput");

const updateBody = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    baseUrl: z.string().url().optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    appLockGroupId: z.number().int().nullable().optional(),
    isActive: z.boolean().optional(),
    notes: z.string().nullable().optional(),
  })
  .openapi("UpdateJamfInstanceInput");

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});
const tenantInstanceParam = tenantParam.extend({
  instanceId: z.string().uuid().openapi({ param: { name: "instanceId", in: "path" } }),
});

const security = [{ BearerAuth: [] }];

const createSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/jamf-instances",
  tags: ["Admin: jamf instances"],
  security,
  summary: "新增 Jamf 實例（憑證寫入後不可讀回）",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: successSchema(jamfInstanceSchema) } },
    },
    409: {
      description: "baseUrl 在該 tenant 已存在",
      content: { "application/json": { schema: successSchema(jamfInstanceSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/jamf-instances",
  tags: ["Admin: jamf instances"],
  security,
  summary: "列出該 tenant 下所有 Jamf 實例",
  request: { params: tenantParam },
  responses: {
    200: {
      description: "Jamf instance list",
      content: {
        "application/json": { schema: successSchema(z.array(jamfInstanceSchema)) },
      },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/jamf-instances/{instanceId}",
  tags: ["Admin: jamf instances"],
  security,
  summary: "取得 Jamf 實例詳情",
  request: { params: tenantInstanceParam },
  responses: {
    200: {
      description: "Jamf instance",
      content: { "application/json": { schema: successSchema(jamfInstanceSchema) } },
    },
    ...commonErrorResponses,
  },
});

const updateSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/jamf-instances/{instanceId}",
  tags: ["Admin: jamf instances"],
  security,
  summary: "更新 Jamf 實例（修 clientSecret 或 baseUrl 會自動清除 token cache）",
  request: {
    params: tenantInstanceParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: successSchema(jamfInstanceSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/jamf-instances/{instanceId}",
  tags: ["Admin: jamf instances"],
  security,
  summary: "刪除 Jamf 實例（不影響裝置記錄，但失去管理通道）",
  request: { params: tenantInstanceParam },
  responses: {
    204: { description: "Deleted" },
    ...commonErrorResponses,
  },
});

const verifySpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/jamf-instances/{instanceId}/verify",
  tags: ["Admin: jamf instances"],
  security,
  summary: "用 client_credentials 真打 OAuth token 端點驗證憑證",
  request: { params: tenantInstanceParam },
  responses: {
    200: {
      description: "Token 換到了，配置正確",
      content: {
        "application/json": {
          schema: successSchema(
            z.object({
              expiresIn: z.number().int().openapi({
                example: 3600,
                description: "Jamf OAuth token 有效秒數",
              }),
              scope: z.string().optional().openapi({
                example: "read write",
                description: "Jamf OAuth scope",
              }),
            }).openapi("JamfVerifyResult"),
          ),
        },
      },
    },
    ...commonErrorResponses,
  },
});

export const jamfInstancesAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
jamfInstancesAdminApp.use("/admin/*", adminAuth());

jamfInstancesAdminApp.openapi(createSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await createJamfInstance({ tenantId, ...body });
  return c.json({ ok: true as const, data: toJamfInstanceDto(row) }, 201);
});

jamfInstancesAdminApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const rows = await listJamfInstances(tenantId);
  return c.json({ ok: true as const, data: rows.map(toJamfInstanceDto) }, 200);
});

jamfInstancesAdminApp.openapi(detailSpec, async (c) => {
  const { tenantId, instanceId } = c.req.valid("param");
  const row = await getJamfInstance({ tenantId, instanceId });
  return c.json({ ok: true as const, data: toJamfInstanceDto(row) }, 200);
});

jamfInstancesAdminApp.openapi(updateSpec, async (c) => {
  const { tenantId, instanceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await updateJamfInstance({ tenantId, instanceId, input: body });
  return c.json({ ok: true as const, data: toJamfInstanceDto(row) }, 200);
});

jamfInstancesAdminApp.openapi(deleteSpec, async (c) => {
  const { tenantId, instanceId } = c.req.valid("param");
  await deleteJamfInstance({ tenantId, instanceId });
  return c.body(null, 204);
});

jamfInstancesAdminApp.openapi(verifySpec, async (c) => {
  const { tenantId, instanceId } = c.req.valid("param");
  const result = await verifyJamfInstance({ tenantId, instanceId });
  return c.json({ ok: true as const, data: result }, 200);
});

// ============================================================
// Sync devices
// ============================================================

const syncSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/jamf-instances/{instanceId}/sync-devices",
  tags: ["Admin: jamf instances"],
  security,
  summary: "從該 Jamf 拉全部 mobile devices 同步到 mdm_devices（upsert）",
  request: { params: tenantInstanceParam },
  responses: {
    200: {
      description: "Sync result",
      content: {
        "application/json": {
          schema: successSchema(
            z.object({
              pagesFetched: z.number().int(),
              totalFromJamf: z.number().int(),
              upserted: z.number().int(),
            }),
          ),
        },
      },
    },
    ...commonErrorResponses,
  },
});

jamfInstancesAdminApp.openapi(syncSpec, async (c) => {
  const { tenantId, instanceId } = c.req.valid("param");
  const result = await syncDevicesFromJamf({ tenantId, jamfInstanceId: instanceId });
  return c.json({ ok: true as const, data: result }, 200);
});
