import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { transferDeviceToGroup } from "~/services/devices.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/devices/*
 *
 * Admin 端的設備寫入操作（需 Bearer admin token）。讀取與 tenant 端寫入見
 * /api/v1/tenants/{tenantId}/devices/*（無 admin 鑑權）。
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
  tags: ["設備操作"],
  security,
  summary: "硬轉校：標記新 device_group + 派 Wipe",
  description: [
    "將設備轉移到新的 device group（跨校轉移）。流程：",
    "",
    "1. 更新設備的 `deviceGroupId` 為目標分組",
    "2. 自動派發 Wipe 命令（Apple 走 Jamf / Windows 走自建 MDM）",
    "3. 設備重灌後重新 enroll，自動歸入新分組",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**⚠️ 此操作會遠端擦除設備**，確保已備份學生資料。",
  ].join("\n"),
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: transferBody } } },
  },
  responses: {
    200: {
      description: "轉移已觸發，回傳設備 ID、新分組 ID 及 Wipe 派發結果",
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
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.transfer",
    resourceType: "device",
    resourceId: deviceId,
    payload: { targetDeviceGroupId },
  });
  return c.json({ ok: true as const, data: result }, 200);
});
