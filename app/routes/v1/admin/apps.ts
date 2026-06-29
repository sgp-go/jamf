import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  deleteApp,
  getAppById,
  getAppLicenseUsage,
  listAppsByTenant,
  toAppDto,
  updateAppMetadata,
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
    category: z.string().nullable().openapi({
      description: "App 分類標籤（如 teaching / system_tools / office）（PRD §5.3）",
      example: "teaching",
    }),
    licenseCount: z.number().int().nullable().openapi({
      description: "**【選填】** 已購買授權數;null = 無限制（PRD §5.3）",
      example: 100,
    }),
    licenseNotes: z.string().nullable().openapi({
      description: "**【選填】** 授權備註（採購合同編號等）",
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
            category: z.string().optional().openapi({
              description: "**【選填】** App 分類（PRD §5.3），如 teaching / system_tools / office",
            }),
            licenseCount: z.string().optional().openapi({
              description: "**【選填】** 已購買授權數（整數字串）；省略視為無限制",
            }),
            licenseNotes: z.string().optional().openapi({
              description: "**【選填】** 授權備註（採購合同編號等）",
            }),
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

const uploadAgentSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/apps/agent",
  tags: ["應用套件管理"],
  security,
  summary: "上傳 CoGrow MDM Agent MSI（自動 set agentAppId）",
  description: [
    "上傳 CoGrow MDM Agent MSI 安裝包。**跟 POST /apps 的差別**：上傳成功後**自動** ",
    "將該 tenant 的 `self_mdm_configs.agentAppId` 指向新 row。新設備 enroll 時 hook ",
    "讀此欄位決定派發哪個 agent，所以「上傳新 agent」=「升級到新版」一次完成，避免",
    "「上傳了但忘記 PATCH /mdm-config」的坑（這正是這個專用端點存在的原因）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**限制**：",
    "- 檔案必須是 `.msi`（其他格式 400）",
    "- tenant 必須已建好 `self_mdm_config`（否則 agentAppId 無處可 set，仍會上傳但 warn）",
    "",
    "**事件**：成功後寫 audit log `action=agent_app.upload`，含新 appId + 舊 agentAppId。",
    "",
    "上傳普通可派發 App（教學軟體、OEM 工具等）請用 `POST /apps`，不要走這個端點，",
    "避免誤切 agent 指針。",
  ].join("\n"),
  request: {
    params: tenantParam,
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.any().openapi({ type: "string", format: "binary", description: "CoGrow MDM Agent MSI 檔案（必須 .msi 後綴）" }),
            displayName: z.string().openapi({ example: "CoGrow MDM Agent" }),
            version: z.string().openapi({ example: "1.4.0.8" }),
            bundleId: z.string().optional().openapi({
              description: "**【選填】** MSI ProductCode（建議帶上，方便版本比對）",
              example: "{176848CB-7917-4829-B158-F18F7585B7DA}",
            }),
            installArgs: z.string().optional().openapi({
              description: "**【選填】** msiexec 額外參數",
              example: "/qn /norestart",
            }),
            signedBy: z.string().optional().openapi({
              description: "**【選填】** 數位簽名者識別",
            }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "上傳成功且 agentAppId 已切到新 app；回傳完整 App 物件",
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
  description: [
    "回傳指定 tenant 的全部已上傳 App（不分頁）。可選 `category` 過濾。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: tenantParam,
    query: z.object({
      category: z.string().optional().openapi({
        param: { name: "category", in: "query" },
        description: "**【選填】** 按分類過濾（PRD §5.3）",
        example: "teaching",
      }),
    }),
  },
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

const patchSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/apps/{appId}",
  tags: ["應用套件管理"],
  security,
  summary: "更新 App metadata（分類 / 授權 / 顯示名等，不動檔案）",
  description: [
    "更新已上傳 App 的 metadata。**不可改檔案**（kind / version / fileHash 等綁定二進制）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**三態語意**：欄位**省略**=不動；傳 `null`=清空；傳值=寫入。",
  ].join("\n"),
  request: {
    params: tenantAppParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              displayName: z.string().min(1).optional(),
              bundleId: z.string().nullable().optional(),
              installArgs: z.string().nullable().optional(),
              signedBy: z.string().nullable().optional(),
              category: z.string().nullable().optional().openapi({
                description: "**【選填】** App 分類;傳 null 清空",
              }),
              licenseCount: z.number().int().nonnegative().nullable().optional().openapi({
                description: "**【選填】** 已購買授權數;傳 null 視為無限制",
              }),
              licenseNotes: z.string().nullable().optional().openapi({
                description: "**【選填】** 授權備註;傳 null 清空",
              }),
            })
            .openapi("UpdateAppInput"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "更新後的 App 物件",
      content: { "application/json": { schema: successSchema(appSchema) } },
    },
    ...commonErrorResponses,
  },
});

const licenseUsageSchema = z
  .object({
    appId: z.string().uuid(),
    licenseCount: z.number().int().nullable().openapi({
      description: "已購買授權總數;null = 未設定（視為無限制）",
    }),
    assigned: z.number().int().openapi({
      description: "已派發到的 distinct 設備數（status=pending/installing/installed）",
    }),
    installed: z.number().int().openapi({
      description: "實際安裝完成的 distinct 設備數（status=installed）",
    }),
    overLimit: z.boolean().openapi({
      description: "true=已超出授權數（licenseCount 非 null 且 assigned > licenseCount）",
    }),
    remaining: z.number().int().nullable().openapi({
      description: "剩餘可派發數;licenseCount=null 時為 null",
    }),
  })
  .openapi("AppLicenseUsage");

const licenseUsageSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/apps/{appId}/license-usage",
  tags: ["應用套件管理"],
  security,
  summary: "查詢 App 授權使用情況（PRD §5.3 授權數量管理）",
  description: [
    "回傳該 App 已派發數 / 已安裝數 / 是否超出授權上限。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**計算邏輯**：",
    "- assigned = distinct device_id 數（status IN pending/installing/installed）",
    "- installed = distinct device_id 數（status = installed）",
    "- overLimit = licenseCount 非 null 且 assigned > licenseCount",
    "",
    "**MVP 限制**：scope=device_group 的派發（沒有具體 device_id）目前不計入 assigned。",
  ].join("\n"),
  request: { params: tenantAppParam },
  responses: {
    200: {
      description: "授權使用統計",
      content: { "application/json": { schema: successSchema(licenseUsageSchema) } },
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

// agent 上傳必須註冊在 detailSpec（/apps/{appId}）**之前**，否則 "agent" 字串會被當 UUID 匹配 → 404
appsAdminApp.openapi(uploadAgentSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    throw new AppError(400, "missing_file", "Field 'file' is required");
  }
  if (!file.name.toLowerCase().endsWith(".msi")) {
    throw new AppError(
      400,
      "agent_must_be_msi",
      `Agent upload requires a .msi file (got "${file.name}")`,
    );
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
    kind: "msi",
    bundleId: body["bundleId"] ? String(body["bundleId"]) : null,
    installArgs: body["installArgs"] ? String(body["installArgs"]) : null,
    signedBy: body["signedBy"] ? String(body["signedBy"]) : null,
  });

  // 立刻切 agentAppId 指針（這個端點存在的核心理由）
  // 先讀舊值寫 audit，再 UPDATE。兩次 round trip 換 audit 完整性，值得。
  const { db } = await import("~/db/client.ts");
  const { selfMdmConfigs } = await import("~/db/schema/self-mdm.ts");
  const { eq } = await import("drizzle-orm");
  const before = await db.query.selfMdmConfigs.findFirst({
    where: eq(selfMdmConfigs.tenantId, tenantId),
    columns: { agentAppId: true },
  });
  const previousAgentAppId = before?.agentAppId ?? null;

  let agentAppIdSet: string | null = null;
  if (before) {
    await db
      .update(selfMdmConfigs)
      .set({ agentAppId: row.id })
      .where(eq(selfMdmConfigs.tenantId, tenantId));
    agentAppIdSet = row.id;
  } else {
    // tenant 沒 self_mdm_config（罕見：通常 enrollment 前已建好）。app row 已寫成功，
    // admin 後續可 POST /mdm-config 建配置後再 PATCH agentAppId。
    console.warn(
      `[agent.upload] tenant ${tenantId} 無 self_mdm_config，agentAppId 未 set；app id=${row.id} 已建好`,
    );
  }

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "agent_app.upload",
    resourceType: "app",
    resourceId: row.id,
    payload: {
      displayName,
      version,
      filename: file.name,
      fileSizeBytes: buf.length,
      agentAppIdSet,
      previousAgentAppId,
    },
  });
  return c.json({ ok: true as const, data: toAppDto(row) }, 201);
});

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
  let licenseCount: number | null = null;
  if (body["licenseCount"] != null && String(body["licenseCount"]).length > 0) {
    const n = Number(body["licenseCount"]);
    if (!Number.isInteger(n) || n < 0) {
      throw new AppError(400, "invalid_license_count", "licenseCount must be a non-negative integer");
    }
    licenseCount = n;
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
    category: body["category"] ? String(body["category"]) : null,
    licenseCount,
    licenseNotes: body["licenseNotes"] ? String(body["licenseNotes"]) : null,
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
  const { category } = c.req.valid("query");
  const rows = await listAppsByTenant(tenantId, { category });
  return c.json({ ok: true as const, data: rows.map((r) => toAppDto(r)) }, 200);
});

appsAdminApp.openapi(detailSpec, async (c) => {
  const { tenantId, appId } = c.req.valid("param");
  const row = await getAppById({ appId, tenantId });
  return c.json({ ok: true as const, data: toAppDto(row) }, 200);
});

appsAdminApp.openapi(patchSpec, async (c) => {
  const { tenantId, appId } = c.req.valid("param");
  const patch = c.req.valid("json");
  const updated = await updateAppMetadata({ tenantId, appId, patch });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "app.update",
    resourceType: "app",
    resourceId: appId,
    payload: patch,
  });
  return c.json({ ok: true as const, data: toAppDto(updated) }, 200);
});

appsAdminApp.openapi(licenseUsageSpec, async (c) => {
  const { tenantId, appId } = c.req.valid("param");
  const usage = await getAppLicenseUsage({ tenantId, appId });
  return c.json({ ok: true as const, data: usage }, 200);
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
