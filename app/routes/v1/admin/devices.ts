import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  hardDeleteDevice,
  redeployDevice,
  retireDevice,
  transferDeviceToGroup,
  updateDeviceInventory,
} from "~/services/devices.ts";
import { listInstalledApps } from "~/services/installed-apps.ts";

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

const retireResultSchema = z
  .object({
    deviceId: z.string().uuid(),
    wipe: z.unknown().openapi({
      description:
        "派發結果。Apple：Jamf API 原始 response；Windows：{commandUuid}",
    }),
  })
  .openapi("DeviceRetireResult");

const redeployResultSchema = z
  .object({
    deviceId: z.string().uuid(),
    wipe: z.unknown().openapi({
      description:
        "派發結果。Apple：Jamf API 原始 response；Windows：{commandUuid}",
    }),
  })
  .openapi("DeviceRedeployResult");

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

const retireSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/retire",
  tags: ["設備操作"],
  security,
  summary: "設備退役：徹底擦除 + 移除 MDM",
  description: [
    "將設備永久退役（畢業淘汰 / 報廢）。流程：",
    "",
    "1. 派預設 doWipe 工廠重置（Apple 走 Jamf / Windows 走自建 MDM）",
    "2. 標記設備 `enrollmentStatus=unenrolled`（軟刪，保留歷史）",
    "",
    "**與轉校的差異**：退役**不保留** PPKG（連 enrollment 一併抹除），設備重置後",
    "**不會**自動回管；轉校保留 PPKG 讓設備自動歸入新分組。",
    "",
    "**與 DELETE 硬刪的差異**：retire 是業務退役流程，保留設備歷史 row；",
    "DELETE 硬刪是救火工具（reset-enrollment.ps1 配對），會 cascade 清掉所有子表。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**⚠️ 此操作會遠端擦除設備且不可逆**，確保已備份資料。",
  ].join("\n"),
  request: {
    params: tenantDeviceParam,
  },
  responses: {
    200: {
      description: "退役已觸發，回傳設備 ID 及 Wipe 派發結果",
      content: { "application/json": { schema: successSchema(retireResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const redeploySpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/redeploy",
  tags: ["設備操作"],
  security,
  summary: "遠端重新部署：Wipe 保留 PPKG，設備自動回同一分組（PRD §5.1）",
  description: [
    "重置設備並自動走完整佈建流程回到**同一** tenant / device_group。適用場景：",
    "",
    "- 設備疑似被本地 admin 惡搞（policy 被拆、Agent 被卸），一鍵刷回乾淨基線",
    "- 學期末統一還原到出廠 PPKG 佈建狀態",
    "- 政策層混亂，回歸出廠 + 自動重跑 enrollment hook",
    "",
    "**流程**：",
    "1. 派 Wipe / `doWipePersistProvisionedData`（Windows）或 ERASE_DEVICE（Apple）",
    "2. **不動** `deviceGroupId`（跟 transfer 唯一差異）",
    "3. 設備重置後 PPKG 保留 → 自動重跑 OOBE → enrollment 落回原 (tenant, device_group)",
    "",
    "**與其他端點差異**：",
    "- vs `/transfer`：redeploy **不改分組**；transfer 換到新 group",
    "- vs `/retire`：redeploy 保留 PPKG 自動回管；retire 徹底 doWipe 不回管",
    "- vs `DELETE`（hardDelete）：redeploy 是業務流程；hardDelete 是救火工具",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**⚠️ 遠端擦除設備**，Windows 設備上使用者資料 / 已裝軟體都會被清除；PPKG 定義的初始帳號 / WiFi / Agent 會自動佈建回來。",
  ].join("\n"),
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "重新部署已觸發，回傳設備 ID 及 Wipe 派發結果",
      content: {
        "application/json": { schema: successSchema(redeployResultSchema) },
      },
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

devicesAdminApp.openapi(retireSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const result = await retireDevice({ tenantId, deviceId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.retire",
    resourceType: "device",
    resourceId: deviceId,
  });
  return c.json({ ok: true as const, data: result }, 200);
});

devicesAdminApp.openapi(redeploySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const result = await redeployDevice({ tenantId, deviceId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.redeploy",
    resourceType: "device",
    resourceId: deviceId,
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

// ── 採購 Inventory（PRD §5.7） ──
// purchaseDate / purchaseVendor / purchasePriceCents / purchaseCurrency / warrantyEndDate

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "must be ISO 8601 date YYYY-MM-DD",
});

const inventoryBody = z
  .object({
    purchaseDate: isoDate.nullable().optional().openapi({
      description: "**【選填】** 採購日期（ISO 8601）；傳 null 清空",
      example: "2025-08-15",
    }),
    purchaseVendor: z.string().max(256).nullable().optional().openapi({
      description: "**【選填】** 採購廠商名稱",
      example: "Lenovo 台灣",
    }),
    purchasePriceCents: z.number().int().nonnegative().nullable().optional().openapi({
      description: "**【選填】** 採購金額（分為單位避免浮點精度誤差，如 TWD 25000.00 = 2500000）",
      example: 2500000,
    }),
    purchaseCurrency: z.string().length(3).nullable().optional().openapi({
      description: "**【選填】** ISO 4217 三字幣別碼（如 TWD / USD）",
      example: "TWD",
    }),
    warrantyEndDate: isoDate.nullable().optional().openapi({
      description: "**【選填】** 保固到期日（ISO 8601）",
      example: "2028-08-14",
    }),
  })
  .openapi("UpdateDeviceInventoryInput");

const inventoryResultSchema = z
  .object({
    id: z.string().uuid(),
    purchaseDate: z.string().nullable(),
    purchaseVendor: z.string().nullable(),
    purchasePriceCents: z.number().int().nullable(),
    purchaseCurrency: z.string().nullable(),
    warrantyEndDate: z.string().nullable(),
  })
  .openapi("DeviceInventoryResult");

const inventorySpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/inventory",
  tags: ["設備操作"],
  security,
  summary: "更新設備採購 Inventory（PRD §5.7 購買資訊管理）",
  description: [
    "更新設備的採購日期、廠商、金額、保固到期日。三態語意：欄位省略=不動;傳 null=清空;傳值=寫入。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**金額單位**：`purchasePriceCents` 以「分」為單位儲存（如 TWD 25,000.00 = 2500000）",
    "避免浮點精度問題;前端顯示時除以 100 並依 `purchaseCurrency` 格式化。",
  ].join("\n"),
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: inventoryBody } } },
  },
  responses: {
    200: {
      description: "更新後的採購欄位",
      content: { "application/json": { schema: successSchema(inventoryResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

devicesAdminApp.openapi(inventorySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const patch = c.req.valid("json");
  const result = await updateDeviceInventory({ tenantId, deviceId, patch });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.update_inventory",
    resourceType: "device",
    resourceId: deviceId,
    payload: patch,
  });
  return c.json({ ok: true as const, data: result }, 200);
});

// ─ Installed MSI / Win32 Apps 查詢（PRD §4.2） ─

const installedAppRowSchema = z
  .object({
    id: z.string().uuid(),
    uninstallKey: z.string(),
    displayName: z.string(),
    displayVersion: z.string().nullable(),
    publisher: z.string().nullable(),
    installDate: z.string().nullable(),
    estimatedSizeKb: z.number().int().nullable(),
    uninstallString: z.string().nullable(),
    lastSyncedAt: z.string(),
  })
  .openapi("InstalledWin32App");

const installedAppsSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/installed-apps",
  tags: ["設備操作"],
  security,
  summary: "查詢設備 MSI / Win32 已裝軟體清單（PRD §4.2 App 安裝清單）",
  description: [
    "回傳設備 Agent 上次上報的 MSI / Win32 軟體清單（registry Uninstall keys 掃描結果）。",
    "設備從未上報過會回空陣列。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：",
    "- MSIX / UWP 軟體不在此清單（那走 AppInventory CSP pull，用 `mdm_windows_apps` 表）。",
    "- 資料來自 `POST /agent/installed-apps` 上報；Agent 未升到帶此功能版本前清單為空。",
  ].join("\n"),
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "已裝軟體清單（按 displayName 順序）",
      content: {
        "application/json": {
          schema: successSchema(z.array(installedAppRowSchema)),
        },
      },
    },
    ...commonErrorResponses,
  },
});

devicesAdminApp.openapi(installedAppsSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const rows = await listInstalledApps({ tenantId, deviceId });
  const sorted = rows
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return c.json({ ok: true as const, data: sorted }, 200);
});
