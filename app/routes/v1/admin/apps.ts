import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  deleteApp,
  getAppById,
  listAppsByTenant,
  toAppDto,
  uploadApp,
} from "~/services/apps.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/apps/*
 *
 * App 安裝包管理：上傳 .msi/.exe/.msix/.mobileconfig，計算 SHA-256，存本地。
 * iOS Custom App 不上傳二進制（走 ABM/ASM 派發），但仍可建 row 記錄 iTunesStoreID。
 */

const appKindSchema = z.enum(["msi", "exe", "msix", "ipa_custom", "mobileconfig"]).openapi({
  description: "msi / exe / msix → Windows；ipa_custom / mobileconfig → Apple",
});

const appSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid().nullable(),
    platform: z.enum(["apple", "windows"]).openapi({
      description: "目標平台",
    }),
    kind: appKindSchema,
    displayName: z.string().openapi({
      description: "應用顯示名稱",
      example: "CoGrow MDM Agent",
    }),
    bundleId: z.string().nullable().openapi({
      description: "Bundle ID（Apple）或 MSI ProductCode（Windows），用於版本比對",
      example: "{A1B2C3D4-5E6F-7A8B-9C0D-E1F2A3B4C5D6}",
    }),
    version: z.string().openapi({
      description: "版本號",
      example: "1.2.0",
    }),
    fileUrl: z.string().nullable().openapi({
      description: "下載路徑（相對），完整 URL = appDownloadBaseUrl + fileUrl",
      example: "/api/v1/apps/xxx/download/agent.msi",
    }),
    fileHash: z.string().nullable().openapi({
      description: "SHA-256 雜湊值（EDA-CSP MsiInstallJob 用於完整性校驗）",
    }),
    fileSizeBytes: z.number().nullable().openapi({
      description: "檔案大小（bytes）",
    }),
    signedBy: z.string().nullable().openapi({
      description: "數位簽名者識別（選填）",
    }),
    installArgs: z.string().nullable().openapi({
      description: "msiexec 額外參數（Windows MSI 專用）",
      example: "/qn /norestart",
    }),
    iTunesStoreId: z.number().nullable().openapi({
      description: "iTunes Store ID（Apple Custom App 專用，走 ABM/ASM 派發）",
    }),
    createdAt: z.string().openapi({ description: "ISO 8601 UTC" }),
    updatedAt: z.string().openapi({ description: "ISO 8601 UTC" }),
  })
  .openapi("App");

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

const tenantAppParam = tenantParam.extend({
  appId: z.string().uuid().openapi({
    param: { name: "appId", in: "path" },
    description: "App UUID",
    example: "b2c3d4e5-6f7a-8b9c-0d1e-f2a3b4c5d6e7",
  }),
});

const security = [{ BearerAuth: [] }];

/**
 * multipart/form-data 上傳。Hono c.req.parseBody() 自動處理。
 * 欄位：
 *   file:         二進制 .msi/.exe/.msix
 *   displayName:  顯示名稱
 *   version:      版本字串
 *   bundleId:     Bundle ID / ProductCode（選填）
 *   kind:         覆寫副檔名推斷（選填）
 *   installArgs:  msiexec 參數（選填）
 *   signedBy:     簽名者識別（選填）
 */
const uploadSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/apps",
  tags: ["應用套件管理"],
  security,
  summary: "上傳 App 安裝包（multipart/form-data）",
  description: [
    "上傳 `.msi` / `.exe` / `.msix` / `.mobileconfig` 安裝包。伺服器自動計算 SHA-256 並存儲到本地。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "上傳後可透過 `POST /admin/.../install-agent` 觸發 EDA-CSP 將 MSI 推送到 Windows 設備。",
    "iOS Custom App 不上傳二進制（走 ABM/ASM 派發），但可建 row 記錄 `iTunesStoreId`。",
  ].join("\n"),
  request: {
    params: tenantParam,
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.any().openapi({ type: "string", format: "binary" }),
            displayName: z.string(),
            version: z.string(),
            bundleId: z.string().optional(),
            kind: appKindSchema.optional(),
            installArgs: z.string().optional(),
            signedBy: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "上傳成功，回傳完整 App 物件（含 fileHash / fileUrl）",
      content: { "application/json": { schema: successSchema(appSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/apps",
  tags: ["應用套件管理"],
  security,
  summary: "列出此 tenant 下所有 App 安裝包",
  description: "回傳指定 tenant 的全部已上傳 App（不分頁）。\n\n**鑑權**：Bearer admin token。",
  request: { params: tenantParam },
  responses: {
    200: {
      description: "App 陣列",
      content: { "application/json": { schema: successSchema(z.array(appSchema)) } },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/apps/{appId}",
  tags: ["應用套件管理"],
  security,
  summary: "取得 App 安裝包詳情",
  description: "回傳單一 App 的完整資訊（含 fileHash、fileSizeBytes 等）。\n\n**鑑權**：Bearer admin token。",
  request: { params: tenantAppParam },
  responses: {
    200: {
      description: "App 物件",
      content: { "application/json": { schema: successSchema(appSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/apps/{appId}",
  tags: ["應用套件管理"],
  security,
  summary: "刪除 App 安裝包（含本地檔案）",
  description: [
    "刪除 App 記錄並移除伺服器上的本地檔案。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：已安裝到設備上的 App 不受影響，但後續設備將無法重新下載此版本。",
  ].join("\n"),
  request: { params: tenantAppParam },
  responses: {
    204: { description: "刪除成功（無回傳 body）" },
    ...commonErrorResponses,
  },
});

export const appsAdminApp = new OpenAPIHono({ defaultHook: validationFailedHook });
appsAdminApp.use("/admin/*", adminAuth());

appsAdminApp.openapi(uploadSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    throw new AppError(400, "missing_file", "Field 'file' is required");
  }
  const displayName = String(body["displayName"] ?? "");
  const version = String(body["version"] ?? "");
  if (!displayName || !version) {
    throw new AppError(400, "missing_metadata", "displayName and version are required");
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const row = await uploadApp({
    tenantId,
    displayName,
    version,
    filename: file.name,
    fileBytes: buf,
    kind: body["kind"] ? (String(body["kind"]) as "msi" | "exe" | "msix") : undefined,
    bundleId: body["bundleId"] ? String(body["bundleId"]) : null,
    installArgs: body["installArgs"] ? String(body["installArgs"]) : null,
    signedBy: body["signedBy"] ? String(body["signedBy"]) : null,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "app.upload",
    resourceType: "app",
    resourceId: row.id,
    payload: {
      displayName,
      version,
      kind: row.kind,
      filename: file.name,
      fileSizeBytes: buf.length,
    },
  });
  return c.json({ ok: true as const, data: toAppDto(row) }, 201);
});

appsAdminApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const rows = await listAppsByTenant(tenantId);
  return c.json({ ok: true as const, data: rows.map((r) => toAppDto(r)) }, 200);
});

appsAdminApp.openapi(detailSpec, async (c) => {
  const { tenantId, appId } = c.req.valid("param");
  const row = await getAppById({ appId, tenantId });
  return c.json({ ok: true as const, data: toAppDto(row) }, 200);
});

appsAdminApp.openapi(deleteSpec, async (c) => {
  const { tenantId, appId } = c.req.valid("param");
  await deleteApp({ appId, tenantId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "app.delete",
    resourceType: "app",
    resourceId: appId,
  });
  return c.body(null, 204);
});
