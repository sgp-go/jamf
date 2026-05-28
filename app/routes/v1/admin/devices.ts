import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { transferDeviceToGroup } from "~/services/devices.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/devices/*
 *
 * Admin 端的設備寫入操作（需 Bearer admin token）。讀取與 tenant 端寫入見
 * /api/v1/tenants/{tenantId}/devices/*（無 admin 鑑權）。
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});
const tenantDeviceParam = tenantParam.extend({
  deviceId: z.string().uuid().openapi({ param: { name: "deviceId", in: "path" } }),
});

const transferBody = z
  .object({
    targetDeviceGroupId: z.string().uuid().openapi({
      example: "01HXR3K2N9P7Q5MZBV0YQK3J8F",
      description: "目標 device_group_id（必須屬於同一 tenant）",
    }),
  })
  .openapi("DeviceTransferInput");

const transferResultSchema = z
  .object({
    deviceId: z.string().uuid(),
    newDeviceGroupId: z.string().uuid(),
    wipe: z.unknown().openapi({
      description:
        "派發結果。Apple：Jamf API 原始 response；Windows：{commandUuid}",
    }),
  })
  .openapi("DeviceTransferResult");

const security = [{ BearerAuth: [] }];

const transferSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/transfer",
  tags: ["Admin: devices"],
  security,
  summary: "硬轉校：標記新 device_group + 派 Wipe（重 enroll 時自動歸新組）",
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: transferBody } } },
  },
  responses: {
    200: {
      description: "Transfer initiated",
      content: { "application/json": { schema: successSchema(transferResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

export const devicesAdminApp = new OpenAPIHono({ defaultHook: validationFailedHook });
devicesAdminApp.use("/admin/*", adminAuth());

devicesAdminApp.openapi(transferSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { targetDeviceGroupId } = c.req.valid("json");
  const result = await transferDeviceToGroup({
    tenantId,
    deviceId,
    targetDeviceGroupId,
  });
  return c.json({ ok: true as const, data: result }, 200);
});
