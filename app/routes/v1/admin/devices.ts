import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { hardDeleteDevice, transferDeviceToGroup } from "~/services/devices.ts";

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

const hardDeleteQuery = z.object({
  force: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      param: { name: "force", in: "query" },
      description:
        "**【選填】** 設為 `true` 繞過「設備 5 分鐘內有 checkin」的保護。預設 `false`。",
      example: "false",
    }),
});

const hardDeleteResultSchema = z
  .object({
    deletedDeviceId: z.string().uuid(),
    deletedUdid: z.string().nullable(),
    deletedSerialNumber: z.string().nullable(),
    cascadedRows: z
      .record(z.string(), z.number().int().nonnegative())
      .openapi({
        description:
          "按子表名稱聚合的級聯刪除筆數（mdm_commands / agent_reports / device_usage_stats / mdm_windows_apps / mdm_windows_laps / mdm_windows_bitlocker / profile_assignments / app_assignments）",
        example: {
          mdm_commands: 12,
          agent_reports: 340,
          device_usage_stats: 7,
          mdm_windows_apps: 28,
          mdm_windows_laps: 3,
          mdm_windows_bitlocker: 1,
          profile_assignments: 0,
          app_assignments: 0,
        },
      }),
  })
  .openapi("DeviceHardDeleteResult");

const hardDeleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}",
  tags: ["設備操作"],
  security,
  summary: "硬刪設備 row（救火用，FK cascade 清子表）",
  description: [
    "**⚠️ 不可逆操作。** 將 `mdm_devices` 該 row 物理刪除；所有 FK `onDelete: cascade` 的子表（命令歷史、agent 上報、使用時長、Windows app 庫存、LAPS 密碼歷史、BitLocker recovery key、profile/app assignment）會被資料庫自動級聯清空。`mdm_migrations`（Jamf 遷移歷史）是 `set null`，會保留 audit trail。",
    "",
    "**僅在設備端已用 `reset-enrollment.ps1` 強拆 enrollment、backend 留下孤兒 row 阻止重新 enroll（或污染 admin UI）時使用。**",
    "",
    "常規解除納管請改用軟刪（標 `enrollment_status=unenrolled`），保歷史完整。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**保護**：若 `lastSeenAt` 在 5 分鐘內（設備仍可能活著），回 409。傳 `?force=true` 繞過。",
    "",
    "**事件**：成功後寫 audit log `action=device.hard_delete`。",
  ].join("\n"),
  request: {
    params: tenantDeviceParam,
    query: hardDeleteQuery,
  },
  responses: {
    200: {
      description: "已刪除，回傳被刪 device 識別資訊 + 各子表級聯筆數",
      content: { "application/json": { schema: successSchema(hardDeleteResultSchema) } },
    },
    409: {
      description: "設備 5 分鐘內仍有 checkin，預設拒絕；可加 `?force=true` 繞過",
      content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }) } },
    },
    ...commonErrorResponses,
  },
});

devicesAdminApp.openapi(hardDeleteSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { force } = c.req.valid("query");
  const result = await hardDeleteDevice({
    tenantId,
    deviceId,
    force: force === "true",
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.hard_delete",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      force: force === "true",
      deletedUdid: result.deletedUdid,
      deletedSerialNumber: result.deletedSerialNumber,
      cascadedRows: result.cascadedRows,
    },
  });
  return c.json({ ok: true as const, data: result }, 200);
});
