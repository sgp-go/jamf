import { serve } from "@hono/node-server";
import { ALL_TAGS, ALL_TAG_GROUPS } from "~/lib/openapi-meta.ts";
import { createBaseApp, finalizeApp, mountAll } from "~/lib/server-kit.ts";
import { monolithMounts } from "~/routes/mount.ts";
import { startWebhookScheduler } from "~/services/webhooks/index.ts";

/**
 * 單體（monolith）入口：Agent + Control + MDM 協議全掛在一個進程。
 * 當前單部署用此入口；拆分後改用 apps/agent/server.ts 與 apps/control/server.ts。
 *
 * HTTP server 走 @hono/node-server 而非 Deno.serve：
 *   Deno.serve 對 HEAD response 強制覆寫 Content-Length=0（denoland/deno#29086 OPEN），
 *   會破壞 BITS 對 MSI 的 HEAD 探測（拿到 0 就放棄下載），導致 EDA-CSP install 失敗。
 *   @hono/node-server 走 node:http 不經過該 transformation，HEAD header 完整保留。
 *   Runtime 仍是 Deno，只是 HTTP server adapter 換了。
 */
const app = createBaseApp("Jamf Explore API");

mountAll(app, monolithMounts);

finalizeApp(app, {
  title: "Jamf Explore API",
  description: [
    "多租戶 Jamf 代理 + 自建 MDM 平台 API。所有路徑以 /api/v1/tenants/{tenantId} 起始。",
    "",
    "**鑑權**：Admin 端點需 `Authorization: Bearer <token>`；Tenant 與 Agent 端點按",
    "tenant 設定（見對接指南）。錯誤一律回 `{ok:false, error:{code, message}}`。",
  ].join("\n"),
  tags: ALL_TAGS,
  tagGroups: ALL_TAG_GROUPS,
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
  console.log(`API docs:    http://localhost:${info.port}/docs`);
  console.log(`OpenAPI:     http://localhost:${info.port}/openapi.json`);
});

// Webhook 推送排程器：10 秒輪詢 webhook_deliveries 取到期 row 推送
// 失敗 30s/5min/30min 三段退避，超過寫 dead；可用 requeueDelivery 補推
startWebhookScheduler();

export type AppType = typeof app;
