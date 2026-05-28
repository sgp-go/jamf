import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { appsAdminApp } from "~/routes/v1/admin/apps.ts";
import { deviceGroupsAdminApp } from "~/routes/v1/admin/device-groups.ts";
import { devicesAdminApp } from "~/routes/v1/admin/devices.ts";
import { installAgentAdminApp } from "~/routes/v1/admin/install-agent.ts";
import { jamfInstancesAdminApp } from "~/routes/v1/admin/jamf-instances.ts";
import { profilesAdminApp } from "~/routes/v1/admin/profiles.ts";
import { tenantsAdminApp } from "~/routes/v1/admin/tenants.ts";
import { agentApp } from "~/routes/v1/agent.ts";
import { appsApp } from "~/routes/v1/apps.ts";
import { devicesApp } from "~/routes/v1/devices.ts";
import { jamfDevicesApp } from "~/routes/v1/jamf-devices.ts";
import windowsMdm from "~/routes/windows-mdm.ts";
import { startWebhookScheduler } from "~/services/webhooks/index.ts";

/**
 * 統一的 validation 失敗 → 標準錯誤信封。
 * zod-openapi 預設會直接讓 handler 拿到 ParseError，這裡攔在 validator hook。
 */
const app = new OpenAPIHono({ defaultHook: validationFailedHook });

app.use("*", logger());
app.use("*", cors());

app.get("/", (c) =>
  c.json({
    name: "Jamf Explore API",
    version: process.env.npm_package_version ?? "0.2.0-alpha",
    docs: "/docs",
    openapi: "/openapi.json",
  }),
);

app.route("/api/v1", devicesApp);
app.route("/api/v1", jamfDevicesApp);
app.route("/api/v1", agentApp);
app.route("/api/v1", appsApp);
app.route("/api/v1", tenantsAdminApp);
app.route("/api/v1", deviceGroupsAdminApp);
app.route("/api/v1", devicesAdminApp);
app.route("/api/v1", jamfInstancesAdminApp);
app.route("/api/v1", appsAdminApp);
app.route("/api/v1", installAgentAdminApp);
app.route("/api/v1", profilesAdminApp);

// Windows MDM：含跨前綴端點（/EnrollmentServer/* 協議端點 + /api/mdm/win/*），
// mount 在 root。非 OpenAPI 文檔化（SOAP / SyncML 設備協議，非 REST JSON）。
app.route("/", windowsMdm);

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Jamf Explore API",
    version: "0.2.0-alpha",
    description:
      "多租戶 Jamf 代理 + 自建 MDM 平台 API。所有路徑以 /api/v1/tenants/{tenantId} 起始。",
  },
  servers: [{ url: "http://localhost:3000", description: "local" }],
});

app.get(
  "/docs",
  apiReference({
    spec: { url: "/openapi.json" },
    theme: "purple",
    pageTitle: "Jamf Explore API Docs",
  }),
);

app.notFound((c) =>
  c.json(
    {
      ok: false as const,
      error: { code: "not_found", message: "Route not found" },
    },
    404,
  ),
);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(
      {
        ok: false as const,
        error: { code: err.code, message: err.message, details: err.details },
      },
      err.status,
    );
  }
  console.error("Unhandled error:", err);
  return c.json(
    {
      ok: false as const,
      error: { code: "internal_error", message: "Internal server error" },
    },
    500,
  );
});

const port = Number(process.env.PORT ?? 3000);
Deno.serve({ port }, app.fetch);
console.log(`Server running on http://localhost:${port}`);
console.log(`API docs:    http://localhost:${port}/docs`);
console.log(`OpenAPI:     http://localhost:${port}/openapi.json`);

// Webhook 推送排程器：10 秒輪詢 webhook_deliveries 取到期 row 推送
// 失敗 30s/5min/30min 三段退避，超過寫 dead；可用 requeueDelivery 補推
startWebhookScheduler();

export type AppType = typeof app;
