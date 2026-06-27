import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { commonErrorResponses, errorSchema, successSchema } from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  createTenant,
  deleteTenant,
  getTenant,
  listTenants,
  updateTenant,
} from "~/services/admin/tenants.ts";
import { AppError } from "~/lib/errors.ts";

/**
 * Tenant 概念說明 — 寫在 schema description，Scalar 會渲染在「Tenant」型別頁面上方。
 *
 * 三個關鍵屬性：
 * 1. 買單方：對應簽合約 / 計費的單位
 * 2. 資料隔離邊界：所有 query 第一個 WHERE 都是 tenant_id = ?
 * 3. 業務範圍上限：tenant 下的device group、Jamf、設備、命令一律不會洩漏到別的 tenant
 */
const TENANT_DESCRIPTION = [
  "**租戶（Tenant）= 買單方 / 合約主體 / 資料隔離邊界。**",
  "",
  "對應到台灣教育情境最常見的兩種模式：",
  "",
  "| 採購模式 | tenant 對應 |",
  "|---|---|",
  "| 教育部統購統管（常見） | 1 tenant = 1 教育部，底下掛 N 所device group |",
  "| 單校自購（少數） | 1 tenant = 1 所device group |",
  "| 多教育部都是客戶 | N tenant，彼此完全隔離 |",
  "",
  "資料隔離保證：所有後端 query 都以 `tenant_id` 為第一條件，跨 tenant 完全看不到對方的device group、設備、命令歷史、上報資料。",
].join("\n");

const tenantSchema = z
  .object({
    id: z.string().uuid().openapi({
      description: "系統內部唯一識別碼（自動產生的 UUID）。建立後不可更動，用於所有 API 路徑。",
    }),
    slug: z.string().openapi({
      description:
        "URL 友好的短代號，全系統唯一。建議格式：小寫英數 + dash / underscore。建立後**強烈不建議再改**（會破壞既有 URL 引用與外部系統對應）。",
      example: "taipei-edu",
    }),
    displayName: z.string().openapi({
      description: "對外顯示名稱，admin UI / 報表 / 通知信會用。可隨時更動。",
      example: "台北市教育部",
    }),
    isActive: z.boolean().openapi({
      description:
        "啟用旗標。設為 `false` 後該 tenant 下所有業務 API 都會被拒絕，但資料保留（軟停用，相對於 DELETE 的硬刪除）。",
    }),
    createdAt: z.string().openapi({ description: "ISO 8601 UTC 時間戳記" }),
    updatedAt: z.string().openapi({ description: "ISO 8601 UTC 時間戳記" }),
  })
  .openapi("Tenant", { description: TENANT_DESCRIPTION });

const createBody = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase alphanumeric with - or _")
      .openapi({
        description:
          "URL 友好的短代號，需 tenant 全域唯一。**建立後幾乎不應再改**。\n\n命名建議：機構英文縮寫 + 地區，例：`taipei-edu`、`taichung-edu`、`new-taipei-edu`。",
        example: "taipei-edu",
      }),
    displayName: z.string().min(1).max(200).openapi({
      description: "對外顯示用，可中文，可隨時改。",
      example: "台北市教育部",
    }),
  })
  .openapi("CreateTenantInput");

const updateBody = z
  .object({
    displayName: z.string().min(1).max(200).optional().openapi({
      description: "更改顯示名稱（slug 不可改）",
    }),
    isActive: z.boolean().optional().openapi({
      description:
        "軟停用 / 重新啟用 tenant。生產環境**永遠優先用本欄位停用，而非 DELETE**。",
    }),
  })
  .openapi("UpdateTenantInput");

const idParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "從 `POST /admin/tenants` 回應或 `GET /admin/tenants` 列表取得",
  }),
});

const security = [{ BearerAuth: [] }];

function toDto(row: {
  id: string;
  slug: string;
  displayName: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const createRouteSpec = createRoute({
  method: "post",
  path: "/admin/tenants",
  tags: ["租戶管理"],
  security,
  summary: "建立 tenant（onboarding 第一步）",
  description: [
    "建立新 tenant。這是新客戶 onboarding 的**第一步**，接著依序：",
    "",
    "1. `POST /admin/tenants/{tenantId}/jamf-instances` — 錄入各校的 Jamf 憑據（baseUrl / clientId / clientSecret）",
    "2. `POST /admin/tenants/{tenantId}/jamf-instances/{id}/verify` — 真打 OAuth 端點驗證憑據有效",
    "3. `POST /admin/tenants/{tenantId}/device-groups` — 建立device group並綁定到對應 Jamf 實例（1:1）",
    "4. `POST /admin/tenants/{tenantId}/jamf-instances/{id}/sync-devices` — 從 Jamf 同步設備清單進 `mdm_devices`",
    "",
    "之後操作員就能用 `/api/v1/tenants/{tenantId}/devices/*` 統一視角管理所有device group的設備。",
  ].join("\n"),
  request: {
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: {
      description: "建立成功",
      content: { "application/json": { schema: successSchema(tenantSchema) } },
    },
    409: {
      description: "Slug 已被使用（slug 全域唯一）",
      content: { "application/json": { schema: errorSchema } },
    },
    ...commonErrorResponses,
  },
});

const listRouteSpec = createRoute({
  method: "get",
  path: "/admin/tenants",
  tags: ["租戶管理"],
  security,
  summary: "列出全部 tenants",
  description:
    "回傳系統內所有 tenant。通常只有 superadmin / 平台維運會用；一般客戶端 admin 直接知道自己的 tenantId 就好。",
  responses: {
    200: {
      description: "Tenant list",
      content: { "application/json": { schema: successSchema(z.array(tenantSchema)) } },
    },
    ...commonErrorResponses,
  },
});

const detailRouteSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}",
  tags: ["租戶管理"],
  security,
  summary: "取得 tenant 詳情",
  description:
    "回傳單一 tenant 的設定。底下的device group、Jamf 實例、設備清單請呼叫各自端點（`/admin/tenants/{tenantId}/device-groups` 等）。",
  request: { params: idParam },
  responses: {
    200: {
      description: "Tenant",
      content: { "application/json": { schema: successSchema(tenantSchema) } },
    },
    ...commonErrorResponses,
  },
});

const updateRouteSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}",
  tags: ["租戶管理"],
  security,
  summary: "更新 tenant（部分欄位）",
  description: [
    "可更新 `displayName` 與 `isActive`，**`slug` 與 `id` 一律不可改**。",
    "",
    "停用客戶建議用 `isActive=false`（軟停用，資料保留）而非 DELETE（cascade 不可逆）。",
  ].join("\n"),
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: successSchema(tenantSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteRouteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}",
  tags: ["租戶管理"],
  security,
  summary: "硬刪 tenant（cascade，不可逆）",
  description: [
    "**警告：此操作不可逆。** 會 cascade 刪除該 tenant 底下：",
    "",
    "- 全部 device group（`device_groups`）",
    "- 全部 Jamf 實例（`jamf_instances`）+ token 快取",
    "- 全部 ASM 實例（`asm_instances`）+ DEP token / DEP devices",
    "- 全部設備記錄（`mdm_devices`）",
    "- 全部命令歷史（`mdm_commands`）",
    "- 全部 Agent 上報（`agent_reports` / `device_usage_stats`）",
    "",
    "生產環境**永遠優先用 `PATCH isActive=false`** 軟停用替代。",
  ].join("\n"),
  request: { params: idParam },
  responses: {
    204: { description: "Deleted" },
    ...commonErrorResponses,
  },
});

export const tenantsAdminApp = new OpenAPIHono({ defaultHook: validationFailedHook });
tenantsAdminApp.use("/admin/*", adminAuth());

tenantsAdminApp.openapi(createRouteSpec, async (c) => {
  const body = c.req.valid("json");
  const row = await createTenant(body);
  if (!row) {
    throw new Error("createTenant returned no row");
  }
  await logAudit({
    ...extractAuditMeta(c),
    tenantId: row.id,
    action: "tenant.create",
    resourceType: "tenant",
    resourceId: row.id,
    payload: { slug: body.slug, displayName: body.displayName },
  });
  return c.json({ ok: true as const, data: toDto(row) }, 201);
});

tenantsAdminApp.openapi(listRouteSpec, async (c) => {
  const rows = await listTenants();
  return c.json({ ok: true as const, data: rows.map(toDto) }, 200);
});

tenantsAdminApp.openapi(detailRouteSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const row = await getTenant(tenantId);
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

tenantsAdminApp.openapi(updateRouteSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await updateTenant(tenantId, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "tenant.update",
    resourceType: "tenant",
    resourceId: tenantId,
    payload: body as Record<string, unknown>,
  });
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

tenantsAdminApp.openapi(deleteRouteSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  // ⚠️ FK cascade 會把本 tenant 的 audit_logs 一起刪。記錄會跟著 tenant 一起消失，
  // 跨 tenant 「誰刪了 tenant」歷史需要另設 platform-level audit（未來 follow-up）。
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "tenant.delete",
    resourceType: "tenant",
    resourceId: tenantId,
  });
  await deleteTenant(tenantId);
  return c.body(null, 204);
});

// ── MDM Config ──────────────────────────────────────────────────────────────

const mdmConfigSchema = z
  .object({
    publicBaseUrl: z.string().openapi({
      description: "MDM 管理通道 URL（公網 HTTPS）。用於 SyncML enrollment / discovery / management 以及 Agent App 上報。",
      example: "https://mdm.school.edu",
    }),
    appDownloadBaseUrl: z.string().nullable().openapi({
      description:
        "文件下載基底 URL（Agent MSI / Push MSIX）。可指向校內 LAN 或 CDN 讓大檔走局域網下載。" +
        "為 null 時回退到 publicBaseUrl（所有流量走同一地址）。",
      example: "http://192.168.1.100:3000",
    }),
    agentAppId: z.string().uuid().nullable().openapi({
      description:
        "**指定本 tenant 的 CoGrow MDM Agent app**（apps.id）。新設備 enroll 完成後 enrollment hook " +
        "自動派發此 app 給設備。為 null 時 hook 會 warn 並跳過 install-agent（避免誤派發任意 MSI）。",
      example: "6015f333-8075-432b-bbea-b7dcbadf0022",
    }),
  })
  .openapi("MdmConfig");

const mdmConfigUpdateBody = z
  .object({
    publicBaseUrl: z.string().url().optional().openapi({
      description: "MDM 管理通道 URL（公網 HTTPS）。",
      example: "https://mdm.school.edu",
    }),
    appDownloadBaseUrl: z.string().url().nullable().optional().openapi({
      description:
        "**【選填】** 文件下載基底 URL。傳 null 清除（回退到 publicBaseUrl）。" +
        "傳 URL 字串設定獨立的下載地址。不傳此欄位則不修改。",
      example: "http://192.168.1.100:3000",
    }),
    agentAppId: z.string().uuid().nullable().optional().openapi({
      description:
        "**【選填】** 指定 enrollment hook 派發的 agent app（apps.id）。傳 null 清除（enrollment 後不自動派發）。" +
        "傳 UUID 設定 / 換 agent 版本。不傳此欄位則不修改。" +
        "**FK 校驗**：UUID 必須對應同 tenant + platform=windows + kind=msi 的 app，否則 409。",
      example: "6015f333-8075-432b-bbea-b7dcbadf0022",
    }),
  })
  .openapi("MdmConfigUpdate");

const createMdmConfigBody = z
  .object({
    publicBaseUrl: z.string().url().openapi({
      description: "MDM 管理通道 URL（公網 HTTPS）。",
      example: "https://mdm.school.edu",
    }),
    appDownloadBaseUrl: z.string().url().nullable().optional().openapi({
      description: "文件下載基底 URL（選填）。為 null 或不傳時回退到 publicBaseUrl。",
      example: "http://192.168.1.100:3000",
    }),
  })
  .openapi("CreateMdmConfig");

const createMdmConfigSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/mdm-config",
  tags: ["租戶管理"],
  security: [{ BearerAuth: [] }],
  summary: "初始化 MDM 配置（自動生成 CA 根憑證）",
  description: [
    "為新租戶建立 MDM 配置。包含：",
    "- 設定 `publicBaseUrl`（必填）和 `appDownloadBaseUrl`（選填）",
    "- 自動生成 per-tenant CA 根憑證（有效期 10 年，用於簽發設備憑證）",
    "",
    "⚠️ 每個租戶只能有一份 MDM 配置（unique constraint）。重複呼叫會回 409。",
    "建立後即可開始生成 PPKG 和接受設備 enrollment。",
  ].join("\n"),
  request: {
    params: z.object({ tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }) }),
    body: { content: { "application/json": { schema: createMdmConfigBody } } },
  },
  responses: {
    201: {
      description: "MDM 配置已建立（含自動生成的 CA）",
      content: { "application/json": { schema: successSchema(mdmConfigSchema) } },
    },
    ...commonErrorResponses,
  },
});

const getMdmConfigSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/mdm-config",
  tags: ["租戶管理"],
  security: [{ BearerAuth: [] }],
  summary: "查詢 MDM 配置（publicBaseUrl / appDownloadBaseUrl）",
  description: [
    "回傳此 tenant 的 MDM URL 配置。",
    "",
    "- **publicBaseUrl**：MDM SyncML 管理通道（enrollment / discovery / management / Agent 上報）。必須是公網可達的 HTTPS。",
    "- **appDownloadBaseUrl**：Agent MSI / Push MSIX 的下載基底 URL。為 `null` 時回退到 `publicBaseUrl`。",
    "",
    "設備下載 MSI 時的完整 URL = `(appDownloadBaseUrl ?? publicBaseUrl) + app.fileUrl`",
    "",
    "**典型場景**：",
    "- 簡單部署：`appDownloadBaseUrl = null`（所有流量走 publicBaseUrl）",
    "- 校內加速：`publicBaseUrl = https://mdm.school.edu`，`appDownloadBaseUrl = http://192.168.1.100:3000`（MSI 走 LAN）",
    "- CDN 分發：`appDownloadBaseUrl = https://cdn.school.edu`",
  ].join("\n"),
  request: { params: z.object({ tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }) }) },
  responses: {
    200: {
      description: "MDM 配置",
      content: { "application/json": { schema: successSchema(mdmConfigSchema) } },
    },
    ...commonErrorResponses,
  },
});

const updateMdmConfigSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/mdm-config",
  tags: ["租戶管理"],
  security: [{ BearerAuth: [] }],
  summary: "更新 MDM 配置（publicBaseUrl / appDownloadBaseUrl）",
  description: [
    "部分更新此 tenant 的 MDM URL 配置。只傳需要修改的欄位。",
    "",
    "**appDownloadBaseUrl 的三種傳法**：",
    "- 不傳（省略欄位）：不修改",
    "- 傳 `null`：清除，回退到 publicBaseUrl",
    "- 傳 URL 字串：設定獨立的文件下載地址",
  ].join("\n"),
  request: {
    params: z.object({ tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }) }),
    body: { content: { "application/json": { schema: mdmConfigUpdateBody } } },
  },
  responses: {
    200: {
      description: "更新後的 MDM 配置",
      content: { "application/json": { schema: successSchema(mdmConfigSchema) } },
    },
    ...commonErrorResponses,
  },
});

tenantsAdminApp.openapi(createMdmConfigSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const { db } = await import("~/db/client.ts");
  const { selfMdmConfigs } = await import("~/db/schema/self-mdm.ts");
  const { eq: eqOp } = await import("drizzle-orm");
  const forge = await import("node-forge");
  const { generateCA } = await import("~/services/mdm/crypto.ts");
  const { encryptSecret } = await import("~/lib/secrets.ts");

  const existing = await db.query.selfMdmConfigs.findFirst({
    where: eqOp(selfMdmConfigs.tenantId, tenantId),
    columns: { id: true },
  });
  if (existing) {
    throw new AppError(409, "mdm_config_exists", "此 tenant 已有 MDM 配置，請用 PATCH 更新");
  }

  const ca = generateCA();
  const caCertPem = forge.default.pki.certificateToPem(ca.cert);
  const caKeyPem = forge.default.pki.privateKeyToPem(ca.key);

  const [row] = await db.insert(selfMdmConfigs).values({
    tenantId,
    publicBaseUrl: body.publicBaseUrl,
    appDownloadBaseUrl: body.appDownloadBaseUrl ?? null,
    caCertPem,
    caKeyPemEnc: encryptSecret(caKeyPem),
    isActive: true,
  }).returning({
    publicBaseUrl: selfMdmConfigs.publicBaseUrl,
    appDownloadBaseUrl: selfMdmConfigs.appDownloadBaseUrl,
    agentAppId: selfMdmConfigs.agentAppId,
  });

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "mdm_config.create",
    resourceType: "self_mdm_config",
    resourceId: tenantId,
    payload: { publicBaseUrl: body.publicBaseUrl },
  });

  return c.json({ ok: true as const, data: row }, 201);
});

tenantsAdminApp.openapi(getMdmConfigSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const { db } = await import("~/db/client.ts");
  const { selfMdmConfigs } = await import("~/db/schema/self-mdm.ts");
  const { eq } = await import("drizzle-orm");
  const cfg = await db.query.selfMdmConfigs.findFirst({
    where: eq(selfMdmConfigs.tenantId, tenantId),
    columns: { publicBaseUrl: true, appDownloadBaseUrl: true, agentAppId: true },
  });
  if (!cfg) throw new AppError(404, "mdm_config_not_found", "此 tenant 無 MDM 配置");
  return c.json({ ok: true as const, data: cfg }, 200);
});

tenantsAdminApp.openapi(updateMdmConfigSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const { db } = await import("~/db/client.ts");
  const { selfMdmConfigs } = await import("~/db/schema/self-mdm.ts");
  const { apps } = await import("~/db/schema/apps.ts");
  const { eq, and } = await import("drizzle-orm");

  const updates: Record<string, unknown> = {};
  if (body.publicBaseUrl !== undefined) updates.publicBaseUrl = body.publicBaseUrl;
  if (body.appDownloadBaseUrl !== undefined) updates.appDownloadBaseUrl = body.appDownloadBaseUrl;
  if (body.agentAppId !== undefined) {
    // 校驗 app 屬於同 tenant + windows + msi（避免設成別人的 app 或非 MSI）
    if (body.agentAppId !== null) {
      const ok = await db.query.apps.findFirst({
        where: and(
          eq(apps.id, body.agentAppId),
          eq(apps.tenantId, tenantId),
          eq(apps.platform, "windows"),
          eq(apps.kind, "msi"),
        ),
        columns: { id: true },
      });
      if (!ok) {
        throw new AppError(
          409,
          "agent_app_not_valid",
          `app ${body.agentAppId} 不屬於 tenant ${tenantId} 或非 windows+msi`,
        );
      }
    }
    updates.agentAppId = body.agentAppId;
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, "no_fields", "至少提供一個欄位");
  }

  const [row] = await db
    .update(selfMdmConfigs)
    .set(updates)
    .where(eq(selfMdmConfigs.tenantId, tenantId))
    .returning({
      publicBaseUrl: selfMdmConfigs.publicBaseUrl,
      appDownloadBaseUrl: selfMdmConfigs.appDownloadBaseUrl,
      agentAppId: selfMdmConfigs.agentAppId,
    });

  if (!row) throw new AppError(404, "mdm_config_not_found", "此 tenant 無 MDM 配置");

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "mdm_config.update",
    resourceType: "self_mdm_config",
    resourceId: tenantId,
    payload: updates,
  });

  return c.json({ ok: true as const, data: row }, 200);
});
