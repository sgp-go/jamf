import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  assignProfile,
  createProfile,
  deleteProfile,
  getProfile,
  listProfileAssignments,
  listProfiles,
  unassignProfile,
  updateProfile,
} from "~/services/admin/profiles.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/profiles/*
 *
 * 配置描述檔 CRUD + 指派 + 套用狀態。差異化推送（profile 變更 → 計算增量 →
 * 重推 → 重試）放 W3，本路由只負責 schema-level 寫入查詢。
 */

// ============================================================
// Schemas
// ============================================================

const platformEnum = z.enum(["apple", "windows"]);
const profileStatusEnum = z.enum(["draft", "active", "archived"]);
const assignmentScopeEnum = z.enum(["device_group", "device"]);
const assignmentStatusEnum = z.enum(["pending", "applied", "failed", "removed"]);

const profileSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    platform: platformEnum,
    displayName: z.string(),
    description: z.string().nullable(),
    payload: z.record(z.unknown()),
    status: profileStatusEnum,
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Profile");

const createBody = z
  .object({
    platform: platformEnum,
    displayName: z.string().min(1).max(200),
    description: z.string().nullable().optional(),
    payload: z.record(z.unknown()).openapi({
      description: [
        "**Windows**：`{ csps: [{ path, verb?, format?, data? }, ...] }`",
        "  例：`{ csps: [{ path: \"./Device/Vendor/MSFT/Policy/Config/DeviceLock/MinDevicePasswordLength\", value: 8 }] }`",
        "",
        "**Apple**：`{ payloadContent: [...MDM payload dicts...] }`",
        "  例：`{ payloadContent: [{ PayloadType: \"com.apple.wifi.managed\", SSID_STR: \"School\", ... }] }`",
      ].join("\n"),
      example: {
        csps: [
          {
            path: "./Device/Vendor/MSFT/Policy/Config/DeviceLock/MinDevicePasswordLength",
            value: 8,
          },
          {
            path: "./Device/Vendor/MSFT/Policy/Config/Storage/RemovableDiskDenyWriteAccess",
            value: 1,
          },
        ],
      },
    }),
    status: profileStatusEnum.optional().openapi({
      example: "draft",
      description: "預設 draft（不會被派發）；要派發前改 active",
    }),
  })
  .openapi("CreateProfileInput");

const updateBody = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    payload: z.record(z.unknown()).optional().openapi({
      description: "更新 payload 會將 version 自動 +1（其餘欄位不 bump version）",
    }),
    status: profileStatusEnum.optional(),
  })
  .openapi("UpdateProfileInput");

const assignBody = z
  .object({
    scope: assignmentScopeEnum,
    deviceGroupId: z.string().uuid().optional().openapi({
      description: "scope=device_group 時必填",
    }),
    deviceId: z.string().uuid().optional().openapi({
      description: "scope=device 時必填",
    }),
  })
  .openapi("AssignProfileInput");

const assignmentSchema = z
  .object({
    id: z.string().uuid(),
    profileId: z.string().uuid(),
    scope: assignmentScopeEnum,
    deviceGroupId: z.string().uuid().nullable(),
    deviceId: z.string().uuid().nullable(),
    status: assignmentStatusEnum,
    appliedVersion: z.number().int().nullable(),
    errorMessage: z.string().nullable(),
    assignedAt: z.string(),
    appliedAt: z.string().nullable(),
    removedAt: z.string().nullable(),
  })
  .openapi("ProfileAssignment");

const listQuery = z.object({
  platform: platformEnum.optional(),
  status: profileStatusEnum.optional(),
});

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});
const tenantProfileParam = tenantParam.extend({
  profileId: z.string().uuid().openapi({ param: { name: "profileId", in: "path" } }),
});
const tenantProfileAssignmentParam = tenantProfileParam.extend({
  assignmentId: z
    .string()
    .uuid()
    .openapi({ param: { name: "assignmentId", in: "path" } }),
});

const security = [{ BearerAuth: [] }];

// ============================================================
// DTOs
// ============================================================

function toProfileDto(row: {
  id: string;
  tenantId: string;
  platform: "apple" | "windows";
  displayName: string;
  description: string | null;
  payload: Record<string, unknown>;
  status: "draft" | "active" | "archived";
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    platform: row.platform,
    displayName: row.displayName,
    description: row.description,
    payload: row.payload,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAssignmentDto(row: {
  id: string;
  profileId: string;
  scope: "device_group" | "device";
  deviceGroupId: string | null;
  deviceId: string | null;
  status: "pending" | "applied" | "failed" | "removed";
  appliedVersion: number | null;
  errorMessage: string | null;
  assignedAt: Date;
  appliedAt: Date | null;
  removedAt: Date | null;
}) {
  return {
    id: row.id,
    profileId: row.profileId,
    scope: row.scope,
    deviceGroupId: row.deviceGroupId,
    deviceId: row.deviceId,
    status: row.status,
    appliedVersion: row.appliedVersion,
    errorMessage: row.errorMessage,
    assignedAt: row.assignedAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
  };
}

// ============================================================
// Specs
// ============================================================

const createSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/profiles",
  tags: ["配置描述檔"],
  security,
  summary: "建立配置描述檔（含 payload；預設 status=draft）",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: successSchema(profileSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/profiles",
  tags: ["配置描述檔"],
  security,
  summary: "列出 tenant 下 profile（可過 platform / status）",
  request: { params: tenantParam, query: listQuery },
  responses: {
    200: {
      description: "Profile list",
      content: {
        "application/json": { schema: successSchema(z.array(profileSchema)) },
      },
    },
    ...commonErrorResponses,
  },
});

const detailSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/profiles/{profileId}",
  tags: ["配置描述檔"],
  security,
  summary: "取得 profile 詳情",
  request: { params: tenantProfileParam },
  responses: {
    200: {
      description: "Profile",
      content: { "application/json": { schema: successSchema(profileSchema) } },
    },
    ...commonErrorResponses,
  },
});

const updateSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/profiles/{profileId}",
  tags: ["配置描述檔"],
  security,
  summary: "更新 profile（payload 變更會自動 version+1）",
  request: {
    params: tenantProfileParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: successSchema(profileSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/profiles/{profileId}",
  tags: ["配置描述檔"],
  security,
  summary: "刪除 profile（cascade 清所有 assignments）",
  request: { params: tenantProfileParam },
  responses: {
    204: { description: "Deleted" },
    ...commonErrorResponses,
  },
});

const assignSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/profiles/{profileId}/assign",
  tags: ["配置描述檔"],
  security,
  summary: "指派 profile 給 device_group 或單一 device",
  request: {
    params: tenantProfileParam,
    body: { content: { "application/json": { schema: assignBody } } },
  },
  responses: {
    201: {
      description: "Assignment created",
      content: {
        "application/json": { schema: successSchema(assignmentSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const statusSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/profiles/{profileId}/status",
  tags: ["配置描述檔"],
  security,
  summary: "查詢 profile 各 assignment 的套用狀態",
  request: { params: tenantProfileParam },
  responses: {
    200: {
      description: "Assignments with status",
      content: {
        "application/json": {
          schema: successSchema(z.array(assignmentSchema)),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const unassignSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/profiles/{profileId}/assignments/{assignmentId}",
  tags: ["配置描述檔"],
  security,
  summary: "解除指派",
  request: { params: tenantProfileAssignmentParam },
  responses: {
    204: { description: "Removed" },
    ...commonErrorResponses,
  },
});

// ============================================================
// Handlers
// ============================================================

export const profilesAdminApp = new OpenAPIHono({ defaultHook: validationFailedHook });
profilesAdminApp.use("/admin/*", adminAuth());

profilesAdminApp.openapi(createSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await createProfile({
    tenantId,
    platform: body.platform,
    displayName: body.displayName,
    description: body.description ?? null,
    payload: body.payload,
    status: body.status,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "profile.create",
    resourceType: "profile",
    resourceId: row.id,
    payload: {
      platform: body.platform,
      displayName: body.displayName,
      status: body.status,
    },
  });
  return c.json({ ok: true as const, data: toProfileDto(row) }, 201);
});

profilesAdminApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const { platform, status } = c.req.valid("query");
  const rows = await listProfiles({ tenantId, platform, status });
  return c.json({ ok: true as const, data: rows.map(toProfileDto) }, 200);
});

profilesAdminApp.openapi(detailSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  const row = await getProfile({ tenantId, profileId });
  return c.json({ ok: true as const, data: toProfileDto(row) }, 200);
});

profilesAdminApp.openapi(updateSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await updateProfile({ tenantId, profileId, input: body });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "profile.update",
    resourceType: "profile",
    resourceId: profileId,
    payload: body as Record<string, unknown>,
  });
  return c.json({ ok: true as const, data: toProfileDto(row) }, 200);
});

profilesAdminApp.openapi(deleteSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  await deleteProfile({ tenantId, profileId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "profile.delete",
    resourceType: "profile",
    resourceId: profileId,
  });
  return c.body(null, 204);
});

profilesAdminApp.openapi(assignSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await assignProfile({ tenantId, profileId, input: body });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "profile.assign",
    resourceType: "profile",
    resourceId: profileId,
    payload: {
      assignmentId: row.id,
      scope: body.scope,
      deviceGroupId: body.deviceGroupId,
      deviceId: body.deviceId,
    },
  });
  return c.json({ ok: true as const, data: toAssignmentDto(row) }, 201);
});

profilesAdminApp.openapi(statusSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  const rows = await listProfileAssignments({ tenantId, profileId });
  return c.json({ ok: true as const, data: rows.map(toAssignmentDto) }, 200);
});

profilesAdminApp.openapi(unassignSpec, async (c) => {
  const { tenantId, profileId, assignmentId } = c.req.valid("param");
  await unassignProfile({ tenantId, profileId, assignmentId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "profile.unassign",
    resourceType: "profile",
    resourceId: profileId,
    payload: { assignmentId },
  });
  return c.body(null, 204);
});
