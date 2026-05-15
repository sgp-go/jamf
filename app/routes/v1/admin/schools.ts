import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  createSchool,
  deleteSchool,
  getSchool,
  listSchools,
  updateSchool,
} from "~/services/admin/schools.ts";

/**
 * school.kind 的 OpenAPI 文檔描述。
 *
 * 受限於 OpenAPI 3.1 spec，enum 值本身只能是字串、不能附帶 per-value description。
 * 所以這裡把兩個值的語義寫進 field-level description，Scalar UI 會在欄位旁直接顯示。
 */
const KIND_DESCRIPTION = [
  "學校類型：",
  "- `school`：一般學校（最常見，每所學校一筆）",
  "- `headquarters`：行政總部 — **當教育部自己也有一台 Jamf 要管自己的設備時**，用 `headquarters` 表示「這不是一所實體學校，而是教育部行政中心」。",
  "",
  "資料模型上兩者共用同一張 `schools` 表，方便聚合查詢 / 報表，差別只在這個 kind 欄位。",
].join("\n");

const kindSchema = z.enum(["school", "headquarters"]).openapi({
  description: KIND_DESCRIPTION,
  example: "school",
});

const schoolSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    code: z.string(),
    displayName: z.string(),
    kind: kindSchema,
    jamfInstanceId: z.string().uuid().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("School");

const createBody = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .openapi({ description: "tenant 內唯一識別碼，例：guangfu-es", example: "guangfu-es" }),
    displayName: z.string().min(1).max(200).openapi({ example: "光復國小" }),
    kind: kindSchema.default("school"),
    jamfInstanceId: z.string().uuid().nullable().optional().openapi({
      description: "綁定的 Jamf 實例（1:1）；可空，之後再 PATCH 補上",
    }),
  })
  .openapi("CreateSchoolInput");

const updateBody = z
  .object({
    code: z.string().min(1).max(64).optional(),
    displayName: z.string().min(1).max(200).optional(),
    kind: kindSchema.optional(),
    jamfInstanceId: z.string().uuid().nullable().optional(),
  })
  .openapi("UpdateSchoolInput");

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});
const tenantSchoolParam = tenantParam.extend({
  schoolId: z.string().uuid().openapi({ param: { name: "schoolId", in: "path" } }),
});

const security = [{ BearerAuth: [] }];

function toDto(row: {
  id: string;
  tenantId: string;
  code: string;
  displayName: string;
  kind: "school" | "headquarters";
  jamfInstanceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    displayName: row.displayName,
    kind: row.kind,
    jamfInstanceId: row.jamfInstanceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const createSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/schools",
  tags: ["Admin: schools"],
  security,
  summary: "建立學校（可選綁定 Jamf 實例）",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: successSchema(schoolSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/schools",
  tags: ["Admin: schools"],
  security,
  summary: "列出該 tenant 下所有學校（含 headquarters）",
  request: { params: tenantParam },
  responses: {
    200: {
      description: "School list",
      content: { "application/json": { schema: successSchema(z.array(schoolSchema)) } },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/schools/{schoolId}",
  tags: ["Admin: schools"],
  security,
  summary: "取得學校詳情",
  request: { params: tenantSchoolParam },
  responses: {
    200: {
      description: "School",
      content: { "application/json": { schema: successSchema(schoolSchema) } },
    },
    ...commonErrorResponses,
  },
});

const updateSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/schools/{schoolId}",
  tags: ["Admin: schools"],
  security,
  summary: "更新學校（可改名 / 重綁 Jamf / 改 kind）",
  request: {
    params: tenantSchoolParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: successSchema(schoolSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/schools/{schoolId}",
  tags: ["Admin: schools"],
  security,
  summary: "刪除學校（cascade 刪設備）",
  request: { params: tenantSchoolParam },
  responses: {
    204: { description: "Deleted" },
    ...commonErrorResponses,
  },
});

export const schoolsAdminApp = new OpenAPIHono({ defaultHook: validationFailedHook });
schoolsAdminApp.use("/admin/*", adminAuth());

schoolsAdminApp.openapi(createSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await createSchool({ tenantId, ...body });
  return c.json({ ok: true as const, data: toDto(row) }, 201);
});

schoolsAdminApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const rows = await listSchools(tenantId);
  return c.json({ ok: true as const, data: rows.map(toDto) }, 200);
});

schoolsAdminApp.openapi(detailSpec, async (c) => {
  const { tenantId, schoolId } = c.req.valid("param");
  const row = await getSchool({ tenantId, schoolId });
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

schoolsAdminApp.openapi(updateSpec, async (c) => {
  const { tenantId, schoolId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await updateSchool({ tenantId, schoolId, input: body });
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

schoolsAdminApp.openapi(deleteSpec, async (c) => {
  const { tenantId, schoolId } = c.req.valid("param");
  await deleteSchool({ tenantId, schoolId });
  return c.body(null, 204);
});
