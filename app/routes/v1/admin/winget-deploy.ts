import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  installWingetAppOnDevice,
  uninstallWingetAppOnDevice,
} from "~/services/winget-deploy.ts";

/**
 * winget App 派發 / 卸載 admin API（區別於 app-deploy.ts 走 EDA-CSP 的 MSI 派發）。
 *
 * - `POST /admin/.../devices/{did}/apps/{appId}/winget-install` — 排 `winget_install` 命令並 WNS push 喚醒
 * - `POST /admin/.../devices/{did}/apps/{appId}/winget-uninstall` — 排 `winget_uninstall` 命令並 WNS push 喚醒
 *
 * 命令存 `mdm_commands` 但不走 OMA-DM SyncML 通道（`syncmlVerb=null`），
 * 由 Agent 端透過 `/agent/checkin` pull 拉取（Agent EventLogWatcher 監聽 Event ID 265 觸發）。
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
    description: "App UUID（先 POST /admin/.../apps/winget 上架取得；kind 必須為 winget）",
    example: "5c1234ab-cd56-78ef-9012-3456789abcde",
  }),
});

const installBody = z
  .object({
    scopeOverride: z.enum(["machine", "user"]).optional().openapi({
      description:
        "**【選填】** 預設 `machine`（全機安裝，所有用戶可見）；改 `user` 只裝當前用戶 profile（Agent 跑 LocalSystem 時 `user` 通常無意義）",
    }),
  })
  .openapi("InstallWingetInput");

const responseSchema = z
  .object({
    commandIds: z.array(z.string().uuid()).openapi({
      description:
        "排入 mdm_commands 的命令 IDs（install=1 條 winget_install；uninstall=1 條 winget_uninstall）",
    }),
  })
  .openapi("WingetDeployResult");

const security = [{ BearerAuth: [] }];

const installSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/apps/{appId}/winget-install",
  tags: ["應用派發"],
  security,
  summary: "向設備派發 winget App（不上傳二進制，秒級觸發）",
  description: [
    "排一條 `winget_install` 命令到設備命令隊列並觸發 WNS push 喚醒設備。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**鏈路**：",
    "1. 寫 `mdm_commands(commandType=winget_install)` + `app_assignments(status=pending)`",
    "2. `triggerWnsPush` → Windows OMA-DM client 啟動 session",
    "3. EventLog `DeviceManagement-Enterprise-Diagnostics-Provider/Operational` 寫 Event ID 265",
    "4. Agent `OmaDmEventLogWatcher` 觸發 `/agent/checkin`",
    "5. checkin response 帶 `wingetCommands[]`",
    "6. Agent spawn `winget install --id X --silent --scope machine --accept-source-agreements --accept-package-agreements [--source X]`",
    "7. Agent POST `/agent/winget-result` 回報結果，更新 mdm_commands + app_assignments 狀態",
    "",
    "**約束**：",
    "- 設備必須 `platform=windows`",
    "- App 必須 `kind=winget`（其他 kind 走 `/install` 走 EDA-CSP MSI）",
    "",
    "**事件**：`command.queued` 立即觸發；Agent 回報後 `command.completed`。",
  ].join("\n"),
  request: {
    params: paramsSchema,
    body: { content: { "application/json": { schema: installBody } } },
  },
  responses: {
    202: {
      description: "命令已排入隊列並觸發 WNS push",
      content: { "application/json": { schema: successSchema(responseSchema) } },
    },
    ...commonErrorResponses,
  },
});

const uninstallSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/apps/{appId}/winget-uninstall",
  tags: ["應用派發"],
  security,
  summary: "向設備派發 winget App 卸載命令",
  description: [
    "排一條 `winget_uninstall` 命令並觸發 WNS push。Agent 端執行 ",
    "`winget uninstall --id {wingetId} --silent`。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：不是所有 winget 包都支援 silent uninstall（依 installer manifest 而定）；",
    "失敗 exit code 會回報在 `/agent/winget-result`。",
    "",
    "**事件**：`command.queued` 立即觸發；Agent 回報後 `command.completed`。",
  ].join("\n"),
  request: { params: paramsSchema },
  responses: {
    202: {
      description: "命令已排入隊列並觸發 WNS push",
      content: { "application/json": { schema: successSchema(responseSchema) } },
    },
    ...commonErrorResponses,
  },
});

export const wingetDeployAdminApp = new OpenAPIHono({ defaultHook: validationFailedHook });
wingetDeployAdminApp.use("/admin/*", adminAuth());

wingetDeployAdminApp.openapi(installSpec, async (c) => {
  const { tenantId, deviceId, appId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await installWingetAppOnDevice({
    tenantId,
    deviceId,
    appId,
    scopeOverride: body.scopeOverride,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "app.winget_install",
    resourceType: "device",
    resourceId: deviceId,
    payload: { appId, commandIds: result.commandIds },
  });
  return c.json({ ok: true as const, data: result }, 202);
});

wingetDeployAdminApp.openapi(uninstallSpec, async (c) => {
  const { tenantId, deviceId, appId } = c.req.valid("param");
  const result = await uninstallWingetAppOnDevice({ tenantId, deviceId, appId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "app.winget_uninstall",
    resourceType: "device",
    resourceId: deviceId,
    payload: { appId, commandIds: result.commandIds },
  });
  return c.json({ ok: true as const, data: result }, 202);
});
