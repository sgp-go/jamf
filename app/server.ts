import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { appsAdminApp } from "~/routes/v1/admin/apps.ts";
import { auditAdminApp } from "~/routes/v1/admin/audit.ts";
import { complianceAdminApp } from "~/routes/v1/admin/compliance.ts";
import { deviceGroupsAdminApp } from "~/routes/v1/admin/device-groups.ts";
import { devicesAdminApp } from "~/routes/v1/admin/devices.ts";
import { enrollmentPpkgAdminApp } from "~/routes/v1/admin/enrollment-ppkg.ts";
import { installAgentAdminApp } from "~/routes/v1/admin/install-agent.ts";
import { jamfInstancesAdminApp } from "~/routes/v1/admin/jamf-instances.ts";
import { profilePresetsApp } from "~/routes/v1/admin/profile-presets.ts";
import { profilesAdminApp } from "~/routes/v1/admin/profiles.ts";
import { tenantsAdminApp } from "~/routes/v1/admin/tenants.ts";
import { webhooksAdminApp } from "~/routes/v1/admin/webhooks.ts";
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
app.route("/api/v1", enrollmentPpkgAdminApp);
app.route("/api/v1", profilesAdminApp);
app.route("/api/v1", profilePresetsApp);
app.route("/api/v1", complianceAdminApp);
app.route("/api/v1", auditAdminApp);
app.route("/api/v1", webhooksAdminApp);

// Windows MDM：含跨前綴端點（/EnrollmentServer/* 協議端點 + /api/mdm/win/*），
// mount 在 root。非 OpenAPI 文檔化（SOAP / SyncML 設備協議，非 REST JSON）。
app.route("/", windowsMdm);

// 註冊 BearerAuth security scheme（route 用 `security: [{ BearerAuth: [] }]` 引用）
app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "Admin 端點需 `Authorization: Bearer <admin_token>`",
});

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Jamf Explore API",
    version: "0.2.0-alpha",
    description: [
      "多租戶 Jamf 代理 + 自建 MDM 平台 API。所有路徑以 /api/v1/tenants/{tenantId} 起始。",
      "",
      "**鑑權**：Admin 端點需 `Authorization: Bearer <token>`；Tenant 與 Agent 端點按",
      "tenant 設定（見對接指南）。錯誤一律回 `{ok:false, error:{code, message}}`。",
    ].join("\n"),
    contact: {
      name: "CoGrow API Support",
      email: "support@cogrow.com",
    },
    license: {
      name: "Proprietary — © CoGrow",
    },
  },
  servers: [
    { url: "http://localhost:3000", description: "local dev" },
    {
      url: "https://api-staging.cogrow.com",
      description: "staging（部署後填入實際 URL）",
    },
    {
      url: "https://api.cogrow.com",
      description: "production（部署後填入實際 URL）",
    },
  ],
  tags: [
    { name: "Devices", description: "設備中心端點（list/detail/PATCH/DELETE/commands/telemetry）" },
    { name: "Agent", description: "Agent App 上報（健康狀態 / 使用統計）" },
    { name: "Apps", description: "App 套件下載（公開，hash 校驗）" },
    { name: "Admin: tenants", description: "Tenant 生命週期" },
    { name: "Admin: device groups", description: "Device group CRUD（操作員可見性邊界）" },
    { name: "Admin: devices", description: "Admin 設備寫入（transfer 硬轉校）" },
    { name: "Admin: profiles", description: "配置描述檔 CRUD + assign + status" },
    {
      name: "Admin: profile presets",
      description: "高層 preset 端點：網站黑名單 / Defender 強制 / Update Policy（自動轉 csps payload）",
    },
    { name: "Admin: compliance", description: "合規政策即時評估（OS 版本 + 離線天數）" },
    { name: "Admin: audit", description: "審計日誌查詢（read-only；寫入由各 admin route 自行 logAudit）" },
    {
      name: "Admin: webhooks",
      description: "Webhook 可觀測性（read-only）：event_log（publishEvent 記錄）+ deliveries（投遞 / 重試 / 死信）",
    },
    { name: "Admin: jamf instances", description: "Jamf 整合設定與同步" },
    { name: "Admin: apps", description: "App 套件上傳與管理" },
    { name: "Admin: install-agent", description: "Agent App 一鍵派發" },
    {
      name: "Admin: jamf raw view (DEPRECATED)",
      description: "⚠️ 已棄用：請改用 /api/v1/tenants/{tid}/devices/* 統一設備視角",
    },
  ],
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
