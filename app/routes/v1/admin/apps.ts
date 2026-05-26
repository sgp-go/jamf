import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
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
    platform: z.enum(["apple", "windows"]),
    kind: appKindSchema,
    displayName: z.string(),
    bundleId: z.string().nullable(),
    version: z.string(),
    fileUrl: z.string().nullable(),
    fileHash: z.string().nullable(),
    fileSizeBytes: z.number().nullable(),
    signedBy: z.string().nullable(),
    installArgs: z.string().nullable(),
    iTunesStoreId: z.number().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("App");

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});

const tenantAppParam = tenantParam.extend({
  appId: z.string().uuid().openapi({ param: { name: "appId", in: "path" } }),
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
  tags: ["Admin: apps"],
  security,
  summary: "上傳 App 安裝包（multipart/form-data）",
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
      description: "App uploaded",
      content: { "application/json": { schema: successSchema(appSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/apps",
  tags: ["Admin: apps"],
  security,
  summary: "列出此 tenant 下所有 App",
  request: { params: tenantParam },
  responses: {
    200: {
      description: "Apps",
      content: { "application/json": { schema: successSchema(z.array(appSchema)) } },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/apps/{appId}",
  tags: ["Admin: apps"],
  security,
  summary: "App 詳情",
  request: { params: tenantAppParam },
  responses: {
    200: {
      description: "App",
      content: { "application/json": { schema: successSchema(appSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/apps/{appId}",
  tags: ["Admin: apps"],
  security,
  summary: "刪除 App（含本地檔案）",
  request: { params: tenantAppParam },
  responses: {
    204: { description: "Deleted" },
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
  return c.body(null, 204);
});
