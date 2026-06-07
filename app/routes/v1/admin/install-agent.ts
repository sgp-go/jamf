import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { installAgentOnDevice } from "~/services/install-agent.ts";
import { getRolloutHealth, rolloutAgentVersion } from "~/services/agent-rollout.ts";

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
  tags: ["Agent 派發"],
  security: [{ BearerAuth: [] }],
  summary: "一鍵派發 Agent App + 注入配置（Registry CSP + EDA-CSP）",
  description: [
    "為指定設備一次性完成 Agent App 部署：",
    "",
    "1. 簽發 `agent_token`（32 bytes hex，DB 僅存 SHA-256 hash）",
    "2. 透過 MSI public property 注入 `DEVICE_ID` / `AGENT_TOKEN` / `API_ENDPOINT` / `TENANT_ID`",
    "3. 排入 EDA-CSP 命令：MsiInstallJob Add → Exec → StatusQuery",
    "4. 自動觸發 LAPS 初始密碼輪換 + ADMX 策略下發",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**⚠️ agent_token 僅此 API 回傳一次**，後續無法從 DB 復原明文。",
  ].join("\n"),
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
  // 不記 agentToken（一次性 raw 值，audit 落表會洩漏）；只記發了哪幾條命令
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.install_agent",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      appId: body.appId,
      apiEndpoint: body.apiEndpoint,
      commandIds: result.commandIds,
    },
  });
  return c.json({ ok: true as const, data: result }, 202);
});

// ============================================================
// 灰度發佈：派 agent 版本到設備子集（分批升級，防壞 build 一次推全量災難）
// ============================================================

const rolloutParamsSchema = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

const rolloutBody = z
  .object({
    appId: z.string().uuid().openapi({
      description: "目標 agent .msi App ID（目標版本來自 app.version）",
    }),
    apiEndpoint: z.string().url().openapi({
      example: "https://api.cogrow.com/api/agent/v1",
    }),
    selection: z
      .discriminatedUnion("mode", [
        z.object({
          mode: z.literal("deviceIds"),
          deviceIds: z.array(z.string().uuid()).min(1),
        }),
        z.object({ mode: z.literal("count"), count: z.number().int().min(1) }),
        z.object({ mode: z.literal("percentage"), percent: z.number().min(1).max(100) }),
      ])
      .openapi({
        description:
          "本批設備選擇：deviceIds 指定 / count 取前 N / percentage 取候選百分比。" +
          "候選 = 租戶 windows 設備中當前版本 != 目標版本者，逐批調用自然收斂。",
      }),
  })
  .openapi("AgentRolloutInput");

const rolloutResponse = z
  .object({
    targetVersion: z.string(),
    eligible: z.number().openapi({ description: "候選數（當前版本 != 目標版本）" }),
    selected: z.number().openapi({ description: "本批選中派發數" }),
    skipped: z.number().openapi({ description: "已是目標版本、跳過數" }),
    queued: z.number(),
    failed: z.number(),
    results: z.array(
      z.object({
        deviceId: z.string(),
        commandIds: z.array(z.string()).optional(),
        error: z.string().optional(),
      }),
    ),
  })
  .openapi("AgentRolloutResult");

const rolloutSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/agent-rollout",
  tags: ["Agent 派發"],
  security: [{ BearerAuth: [] }],
  summary: "灰度派發 Agent 版本到設備子集（分批升級）",
  description: [
    "分批將 Agent App 升級到新版本。支援三種設備選擇模式：",
    "",
    "- `deviceIds`：指定設備 UUID 列表",
    "- `count`：從候選中選前 N 台",
    "- `percentage`：從候選中選百分比",
    "",
    "**候選定義**：tenant 下 Windows 設備中，當前版本 ≠ 目標版本者。逐批調用自然收斂。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**⚠️ 壞 build 上量 = 災難**。建議先用 `deviceIds` 模式推 2-3 台觀察，",
    "確認健康後再用 `percentage` 逐步擴大。",
  ].join("\n"),
  request: {
    params: rolloutParamsSchema,
    body: { content: { "application/json": { schema: rolloutBody } } },
  },
  responses: {
    202: {
      description: "本批命令已排入隊列",
      content: { "application/json": { schema: successSchema(rolloutResponse) } },
    },
    ...commonErrorResponses,
  },
});

installAgentAdminApp.openapi(rolloutSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await rolloutAgentVersion({
    tenantId,
    appId: body.appId,
    apiEndpoint: body.apiEndpoint,
    selection: body.selection,
  });
  // 只記匯總（results 可能含上百台，全記會撐大 audit 行）
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "agent.rollout",
    resourceType: "tenant",
    resourceId: tenantId,
    payload: {
      appId: body.appId,
      targetVersion: result.targetVersion,
      selection: body.selection,
      eligible: result.eligible,
      selected: result.selected,
      skipped: result.skipped,
      queued: result.queued,
      failed: result.failed,
    },
  });
  return c.json({ ok: true as const, data: result }, 202);
});

// ============================================================
// 灰度健康驗證：升級後設備是否還在上報（silent = 失聯告警，運維據此回滾）
// ============================================================

const healthQuerySchema = z.object({
  appId: z.string().uuid().openapi({
    param: { name: "appId", in: "query" },
    description: "目標 agent App ID（健康判定的目標版本來自 app.version）",
  }),
  windowMinutes: z.coerce.number().int().min(1).default(30).openapi({
    param: { name: "windowMinutes", in: "query" },
    description: "上報靜默窗口（分鐘）；曾上報但超此窗口無上報的設備判為 silent",
  }),
});

const healthResponseSchema = z
  .object({
    targetVersion: z.string(),
    windowMinutes: z.number(),
    upgraded: z.array(z.string()).openapi({ description: "已升級到目標版本" }),
    silent: z.array(z.string()).openapi({
      description: "曾上報、現超窗口無上報——升級後失聯告警目標（考慮回滾）",
    }),
    pending: z.array(z.string()).openapi({ description: "未升級但窗口內有上報（進行中）" }),
    neverReported: z.array(z.string()).openapi({ description: "從未上報（可能未裝 agent）" }),
  })
  .openapi("AgentRolloutHealth");

const healthSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/agent-rollout/health",
  tags: ["Agent 派發"],
  security: [{ BearerAuth: [] }],
  summary: "查灰度升級健康狀態（失聯設備 = 回滾告警）",
  description: [
    "檢查灰度升級後設備的健康狀況。按上報狀態分四類：",
    "",
    "- **upgraded**：已升級到目標版本，正常上報",
    "- **silent**：曾上報但超過窗口無上報 — **升級後失聯，考慮回滾**",
    "- **pending**：未升級但窗口內有上報（升級進行中）",
    "- **neverReported**：從未上報（可能未裝 agent）",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: rolloutParamsSchema,
    query: healthQuerySchema,
  },
  responses: {
    200: {
      description: "升級健康分類",
      content: { "application/json": { schema: successSchema(healthResponseSchema) } },
    },
    ...commonErrorResponses,
  },
});

installAgentAdminApp.openapi(healthSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const { appId, windowMinutes } = c.req.valid("query");
  const health = await getRolloutHealth({ tenantId, appId, windowMinutes });
  return c.json({ ok: true as const, data: health }, 200);
});
