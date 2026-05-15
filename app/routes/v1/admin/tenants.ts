import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  createTenant,
  deleteTenant,
  getTenant,
  listTenants,
  updateTenant,
} from "~/services/admin/tenants.ts";

/**
 * Tenant 概念說明 — 寫在 schema description，Scalar 會渲染在「Tenant」型別頁面上方。
 *
 * 三個關鍵屬性：
 * 1. 買單方：對應簽合約 / 計費的單位
 * 2. 資料隔離邊界：所有 query 第一個 WHERE 都是 tenant_id = ?
 * 3. 業務範圍上限：tenant 下的學校、Jamf、設備、命令一律不會洩漏到別的 tenant
 */
const TENANT_DESCRIPTION = [
  "**租戶（Tenant）= 買單方 / 合約主體 / 資料隔離邊界。**",
  "",
  "對應到台灣教育情境最常見的兩種模式：",
  "",
  "| 採購模式 | tenant 對應 |",
  "|---|---|",
  "| 教育部統購統管（常見） | 1 tenant = 1 教育部，底下掛 N 所學校 |",
  "| 單校自購（少數） | 1 tenant = 1 所學校 |",
  "| 多教育部都是客戶 | N tenant，彼此完全隔離 |",
  "",
  "資料隔離保證：所有後端 query 都以 `tenant_id` 為第一條件，跨 tenant 完全看不到對方的學校、設備、命令歷史、上報資料。",
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
  tags: ["Admin: tenants"],
  security,
  summary: "建立 tenant（onboarding 第一步）",
  description: [
    "建立新 tenant。這是新客戶 onboarding 的**第一步**，接著依序：",
    "",
    "1. `POST /admin/tenants/{tenantId}/jamf-instances` — 錄入各校的 Jamf 憑據（baseUrl / clientId / clientSecret）",
    "2. `POST /admin/tenants/{tenantId}/jamf-instances/{id}/verify` — 真打 OAuth 端點驗證憑據有效",
    "3. `POST /admin/tenants/{tenantId}/schools` — 建立學校並綁定到對應 Jamf 實例（1:1）",
    "4. `POST /admin/tenants/{tenantId}/jamf-instances/{id}/sync-devices` — 從 Jamf 同步設備清單進 `mdm_devices`",
    "",
    "之後操作員就能用 `/api/v1/tenants/{tenantId}/devices/*` 統一視角管理所有學校的設備。",
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
      content: { "application/json": { schema: successSchema(tenantSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listRouteSpec = createRoute({
  method: "get",
  path: "/admin/tenants",
  tags: ["Admin: tenants"],
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
  tags: ["Admin: tenants"],
  security,
  summary: "取得 tenant 詳情",
  description:
    "回傳單一 tenant 的設定。底下的學校、Jamf 實例、設備清單請呼叫各自端點（`/admin/tenants/{tenantId}/schools` 等）。",
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
  tags: ["Admin: tenants"],
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
  tags: ["Admin: tenants"],
  security,
  summary: "硬刪 tenant（cascade，不可逆）",
  description: [
    "**警告：此操作不可逆。** 會 cascade 刪除該 tenant 底下：",
    "",
    "- 全部學校（`schools`）",
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
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

tenantsAdminApp.openapi(deleteRouteSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  await deleteTenant(tenantId);
  return c.body(null, 204);
});
