import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { installAgentOnDevice } from "~/services/install-agent.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/install-agent
 *
 * 一次性 API：給設備派 Agent App + 注入配置。
 * 內部組合 Registry CSP（寫 HKLM 配置）+ EDA-CSP（派 .msi）+ MSI Status Get。
 *
 * 回傳 agent_token 為一次性 raw 值（DB 只存 sha256 hash），呼叫端應立即妥善
 * 處理（記錄到自家 vault 或傳給 Agent App 開發者用作 dev 測試）。
 */

const paramsSchema = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
  deviceId: z.string().uuid().openapi({ param: { name: "deviceId", in: "path" } }),
});

const requestBody = z
  .object({
    appId: z.string().uuid().openapi({
      description: "上傳到 /admin/.../apps 的 Agent .msi App ID",
    }),
    apiEndpoint: z.string().url().openapi({
      description:
        "Agent App 上報用的 API base URL，注入到設備註冊表。例：https://api.cogrow.com/api/agent/v1",
      example: "https://api.cogrow.com/api/agent/v1",
    }),
    registryPath: z.string().optional().openapi({
      description:
        "自訂註冊表路徑（預設 SOFTWARE/Policies/CoGrowMDM/Agent）。通常不需改",
    }),
  })
  .openapi("InstallAgentInput");

const responseSchema = z
  .object({
    deviceId: z.string().uuid().openapi({
      example: "9d4c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c",
    }),
    agentToken: z.string().openapi({
      example:
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      description:
        "為此 device 簽發的 raw token（hex 64 chars）。**僅此 API 回傳一次**，DB 只存 sha256 hash。",
    }),
    commandIds: z.array(z.string().uuid()).openapi({
      description:
        "排入 mdm_commands 隊列的命令 IDs（msi_install Add + Exec + msi_status_query）",
    }),
  })
  .openapi("InstallAgentResult");

const installAgentSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/install-agent",
  tags: ["Admin: devices"],
  security: [{ BearerAuth: [] }],
  summary: "一鍵派發 Agent App + 注入配置（Registry CSP + EDA-CSP）",
  request: {
    params: paramsSchema,
    body: { content: { "application/json": { schema: requestBody } } },
  },
  responses: {
    202: {
      description: "命令已排入隊列；token 一次性返回，後續無法復原",
      content: { "application/json": { schema: successSchema(responseSchema) } },
    },
    ...commonErrorResponses,
  },
});

export const installAgentAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
installAgentAdminApp.use("/admin/*", adminAuth());

installAgentAdminApp.openapi(installAgentSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await installAgentOnDevice({
    tenantId,
    deviceId,
    appId: body.appId,
    apiEndpoint: body.apiEndpoint,
    registryPath: body.registryPath,
  });
  return c.json({ ok: true as const, data: result }, 202);
});
