import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { installAppOnDevice, uninstallAppOnDevice } from "~/services/app-deploy.ts";

/**
 * 通用 App 派發 / 卸載 admin API（區別於 /install-agent 專屬端點）。
 *
 * - `POST /admin/tenants/{tid}/devices/{did}/apps/{appId}/install` 排 MSI install
 *   命令（Add + Exec + Status）到設備命令隊列，設備下次 OMA-DM session 拉取執行。
 * - `POST /admin/tenants/{tid}/devices/{did}/apps/{appId}/uninstall` 排 MSI
 *   uninstall Exec + Status query。
 *
 * **不簽** agent_token、**不寫** `mdm_devices.agent_app_id`、**不排** ADMX install /
 * LAPS / BitLocker（這些只給 Agent App 一次性流程）。台灣團隊 demo 派發任意 MSI 應用用。
 */

const paramsSchema = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
  deviceId: z.string().uuid().openapi({
    param: { name: "deviceId", in: "path" },
    description: "設備 UUID",
    example: "9d4c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c",
  }),
  appId: z.string().uuid().openapi({
    param: { name: "appId", in: "path" },
    description: "App UUID（先 POST /admin/.../apps 上傳取得）",
    example: "5c1234ab-cd56-78ef-9012-3456789abcde",
  }),
});

const installRequestBody = z
  .object({
    installArgsOverride: z.string().optional().openapi({
      description:
        "**【選填】** 覆寫 app.installArgs（預設 `/quiet /norestart`）。例 `/q ALLUSERS=1`。",
    }),
  })
  .openapi("InstallAppInput");

const responseSchema = z
  .object({
    commandIds: z.array(z.string().uuid()).openapi({
      description:
        "排入 mdm_commands 隊列的命令 IDs；install 含 msi_install Add+Exec+msi_status_query；uninstall 含 msi_uninstall Exec+msi_status_query",
    }),
  })
  .openapi("AppDeployResult");

const security = [{ BearerAuth: [] }];

const installSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/apps/{appId}/install",
  tags: ["應用派發"],
  security,
  summary: "向設備派發 MSI App（不簽 agent_token）",
  description: [
    "排 EDA-CSP `msi_install` Add + Exec + msi_status_query 三條 SyncML 命令進設備命令隊列。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**約束**：",
    "- 設備必須 `platform=windows`",
    "- App 必須 `platform=windows` 且 `kind in (msi, exe)`",
    "- App 必須有 `fileUrl`、`fileHash`、`bundleId`（MSI ProductCode GUID）",
    "",
    "**事件**：每條命令觸發 webhook `command.queued`。",
  ].join("\n"),
  request: {
    params: paramsSchema,
    body: { content: { "application/json": { schema: installRequestBody } } },
  },
  responses: {
    202: {
      description: "命令已排入隊列",
      content: { "application/json": { schema: successSchema(responseSchema) } },
    },
    ...commonErrorResponses,
  },
});

const uninstallSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/apps/{appId}/uninstall",
  tags: ["應用派發"],
  security,
  summary: "向設備派發 MSI App 卸載命令",
  description: [
    "排 EDA-CSP `msi_uninstall` Exec + msi_status_query 兩條 SyncML 命令進設備命令隊列。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "設備執行 `msiexec /x {ProductID} /quiet`（卸載命令行由 OS 決定，不接受額外參數）。",
    "App 必須是該設備上實際裝過的 ProductCode，否則 msiexec 回 1605 (ERROR_UNKNOWN_PRODUCT) 但 SyncML 仍 ack 200。",
    "",
    "**事件**：每條命令觸發 webhook `command.queued`。",
  ].join("\n"),
  request: { params: paramsSchema },
  responses: {
    202: {
      description: "命令已排入隊列",
      content: { "application/json": { schema: successSchema(responseSchema) } },
    },
    ...commonErrorResponses,
  },
});

export const appDeployAdminApp = new OpenAPIHono({ defaultHook: validationFailedHook });
appDeployAdminApp.use("/admin/*", adminAuth());

appDeployAdminApp.openapi(installSpec, async (c) => {
  const { tenantId, deviceId, appId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await installAppOnDevice({
    tenantId,
    deviceId,
    appId,
    installArgsOverride: body.installArgsOverride,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "app.install",
    resourceType: "device",
    resourceId: deviceId,
    payload: { appId, commandIds: result.commandIds },
  });
  return c.json({ ok: true as const, data: result }, 202);
});

appDeployAdminApp.openapi(uninstallSpec, async (c) => {
  const { tenantId, deviceId, appId } = c.req.valid("param");
  const result = await uninstallAppOnDevice({ tenantId, deviceId, appId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "app.uninstall",
    resourceType: "device",
    resourceId: deviceId,
    payload: { appId, commandIds: result.commandIds },
  });
  return c.json({ ok: true as const, data: result }, 202);
});
