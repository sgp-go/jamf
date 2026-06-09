import { AGENT_TAGS, AGENT_TAG_GROUPS } from "~/lib/openapi-meta.ts";
import { createBaseApp, finalizeApp, mountAll } from "~/lib/server-kit.ts";
import { agentMounts } from "~/routes/mount.ts";

/**
 * Agent Telemetry 服務入口（拆分階段一）。
 *
 * 範圍：僅 Agent 設備上報端點（/api/v1/tenants/{tid}/agent/*，iOS + Windows 共用）。
 *
 * - **不啟動 Webhook 排程器**：上報觸發的 publishEvent 僅寫 webhook_deliveries，
 *   投遞由 Control 服務的排程器統一處理（共用 DB）。
 * - **上報副作用（LAPS / BitLocker）**：經 agent.ts 的接縫預設「直連」實現，
 *   寫 mdm_commands 隊列由 Control 的 OMA-DM 協議層拉走。物理隔離（無共用 DB）時
 *   改 setAgentReportHooks 注入事件版實現即可。
 *
 * 階段一仍與 Control 服務共用同一個 PostgreSQL；只拆 server 進程。
 */
const app = createBaseApp("CoGrow Agent Telemetry API");

mountAll(app, agentMounts);

finalizeApp(app, {
  title: "CoGrow Agent Telemetry API",
  description: [
    "Agent App 設備上報 API（iOS + Windows 共用）。",
    "路徑以 /api/v1/tenants/{tenantId}/agent 起始。",
    "",
    "**鑑權**：設備帶 `Authorization: Bearer <agent_token>`；",
    "未簽發 token 的設備（過渡期）相容不帶。",
  ].join("\n"),
  tags: AGENT_TAGS,
  tagGroups: AGENT_TAG_GROUPS,
});

const port = Number(process.env.AGENT_PORT ?? 3100);
Deno.serve({ port }, app.fetch);
console.log(`[agent] Server running on http://localhost:${port}`);
console.log(`[agent] API docs:    http://localhost:${port}/docs`);
console.log(`[agent] OpenAPI:     http://localhost:${port}/openapi.json`);
