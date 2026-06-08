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
import { bitlockerAdminApp } from "~/routes/v1/admin/bitlocker.ts";
import { lapsAdminApp } from "~/routes/v1/admin/laps.ts";
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
app.route("/api/v1", lapsAdminApp);
app.route("/api/v1", bitlockerAdminApp);

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
    // ── 公開 API（設備端 / Agent App）──
    { name: "設備查詢與操作", description: "設備列表 / 詳情 / 命令派送 / 遙測 / App Lock / 解除納管，操作員統一視角" },
    { name: "Agent 上報", description: "Agent App 上報設備健康狀態 + 螢幕使用時長統計（iOS / Windows 共用）" },
    { name: "應用下載", description: "App 安裝包下載（公開端點，SHA-256 校驗，供 MDM EDA-CSP 拉取 MSI / MSIX）" },

    // ── 租戶初始化 ──
    { name: "租戶管理", description: "租戶生命週期（CRUD）+ MDM 基礎配置（publicBaseUrl / appDownloadBaseUrl / CA 憑證）" },
    { name: "設備分組", description: "設備分組 CRUD（操作員可見性邊界 + 批次派送單位），可選綁定 Jamf 實例" },
    { name: "Jamf 整合", description: "Jamf Pro 整合設定（憑據錄入 / 驗證 / 設備同步），支援多實例" },

    // ── 設備管理 ──
    { name: "設備操作", description: "Admin 設備寫入（transfer 跨校轉移 + Wipe 觸發 + Agent 派發）" },
    { name: "批次註冊", description: "Windows PPKG 批次註冊（customizations.xml 生成，含 WiFi / 本機帳號配置）" },
    { name: "Agent 派發", description: "Agent App 一鍵派發（EDA-CSP 遠端安裝 + 灰度升級 + 健康驗證）" },
    { name: "密碼託管（LAPS）", description: "本機管理員密碼託管 —— 查詢當前密碼 / 手動觸發輪換" },

    // ── 策略與合規 ──
    { name: "配置描述檔", description: "配置描述檔 CRUD + 指派到設備或分組 + 套用狀態追蹤" },
    { name: "策略預設", description: "高層 preset：網站黑名單 / Defender 強制 / Windows Update 策略（自動轉換為 CSP payload）" },
    { name: "合規評估", description: "合規政策即時評估（OS 版本下限 + 離線天數上限）" },

    // ── 平台營運 ──
    { name: "應用套件管理", description: "App 安裝包上傳與管理（MSI / MSIX 二進位 + metadata）" },
    { name: "審計日誌", description: "審計日誌查詢（唯讀；寫入由各端點自動記錄）" },
    { name: "Webhook 監控", description: "Webhook 可觀測性（唯讀）：事件日誌 + 投遞記錄（含重試 / 死信狀態）" },

    // ── 已棄用 ──
    { name: "Jamf 原始視圖（已棄用）", description: "⚠️ 已棄用：請改用統一設備視角端點" },
  ],
  "x-tagGroups": [
    {
      name: "公開 API",
      tags: ["設備查詢與操作", "Agent 上報", "應用下載"],
    },
    {
      name: "租戶初始化",
      tags: ["租戶管理", "設備分組", "Jamf 整合"],
    },
    {
      name: "設備管理",
      tags: ["設備操作", "批次註冊", "Agent 派發", "密碼託管（LAPS）"],
    },
    {
      name: "策略與合規",
      tags: ["配置描述檔", "策略預設", "合規評估"],
    },
    {
      name: "平台營運",
      tags: ["應用套件管理", "審計日誌", "Webhook 監控"],
    },
    {
      name: "已棄用",
      tags: ["Jamf 原始視圖（已棄用）"],
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
