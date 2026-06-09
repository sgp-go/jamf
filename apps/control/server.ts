import { CONTROL_TAGS, CONTROL_TAG_GROUPS } from "~/lib/openapi-meta.ts";
import { createBaseApp, finalizeApp, mountAll } from "~/lib/server-kit.ts";
import { controlServiceMounts } from "~/routes/mount.ts";
import { startWebhookScheduler } from "~/services/webhooks/index.ts";

/**
 * MDM Control 服務入口（拆分階段一）。
 *
 * 範圍：MDM Control API（台灣後端調用，/api/v1/*）+ MDM 協議層
 * （設備 OS 直連，/EnrollmentServer/* + /api/mdm/win/*）+ Webhook 投遞排程。
 * 不含 Agent 上報端點（見 apps/agent/server.ts）。
 *
 * 階段一仍與 Agent 服務共用同一個 PostgreSQL；只拆 server 進程。
 */
const app = createBaseApp("CoGrow MDM Control API");

mountAll(app, controlServiceMounts);

finalizeApp(app, {
  title: "CoGrow MDM Control API",
  description: [
    "MDM 控制面 API（台灣後端調用）+ Windows MDM 協議層（設備 OS 直連）。",
    "Control API 路徑以 /api/v1/tenants/{tenantId} 起始。",
    "",
    "**鑑權**：Admin 端點需 `Authorization: Bearer <token>`。",
    "錯誤一律回 `{ok:false, error:{code, message}}`。",
    "",
    "Agent 設備上報端點已拆至獨立的 Agent Telemetry 服務。",
  ].join("\n"),
  tags: CONTROL_TAGS,
  tagGroups: CONTROL_TAG_GROUPS,
});

const port = Number(process.env.PORT ?? 3000);
Deno.serve({ port }, app.fetch);
console.log(`[control] Server running on http://localhost:${port}`);
console.log(`[control] API docs:    http://localhost:${port}/docs`);
console.log(`[control] OpenAPI:     http://localhost:${port}/openapi.json`);

// Webhook 投遞排程器只在 Control 服務跑：Agent 服務 publishEvent 僅寫 DB，
// 由此排程器統一輪詢 webhook_deliveries 推送（共用 DB，與插入方無關）。
startWebhookScheduler();
