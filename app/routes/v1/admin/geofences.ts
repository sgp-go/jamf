/**
 * Geofence 地理圍欄 Admin API（PRD §6）
 *
 * 端點：
 *   - CRUD tenant 級 geofence 定義
 *   - assign / unassign device × geofence
 *   - 查設備當前 geofence in/out 狀態
 *
 * Agent GPS 上報時後端自動 point-in-polygon 對比 state，transition 發生就
 * publish webhook `device.geofence_enter` / `.geofence_exit`（service 層完成，
 * 這裡不重複實作）。
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { db } from "~/db/client.ts";
import {
  deviceGeofenceAssignments,
  deviceGeofenceStates,
  geofences,
  GEOFENCE_STATUS,
} from "~/db/schema/geofences.ts";
import { mdmDevices } from "~/db/schema/devices.ts";

const security = [{ BearerAuth: [] }];

// ── 參數 ──

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

const tenantGeofenceParam = tenantParam.extend({
  geofenceId: z.string().uuid().openapi({
    param: { name: "geofenceId", in: "path" },
    description: "Geofence UUID",
  }),
});

const tenantDeviceParam = tenantParam.extend({
  deviceId: z.string().uuid().openapi({
    param: { name: "deviceId", in: "path" },
    description: "設備 UUID",
  }),
});

const tenantDeviceGeofenceParam = tenantDeviceParam.extend({
  geofenceId: z.string().uuid().openapi({
    param: { name: "geofenceId", in: "path" },
    description: "Geofence UUID",
  }),
});

// ── Schema ──

const pointSchema = z.object({
  lat: z.number().min(-90).max(90).openapi({
    description: "緯度（WGS84 度數）",
    example: 39.925,
  }),
  lng: z.number().min(-180).max(180).openapi({
    description: "經度（WGS84 度數）",
    example: 116.450,
  }),
});

const polygonSchema = z.array(pointSchema).min(3).openapi({
  description: "多邊形頂點陣列，至少 3 個點；順時針 / 逆時針皆可，首尾不必相同",
});

const geofenceResponseSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    polygon: polygonSchema,
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Geofence");

const createBody = z
  .object({
    name: z.string().min(1).max(128).openapi({
      description: "顯示名稱（tenant 內唯一）",
      example: "光復國小校園",
    }),
    description: z.string().optional().openapi({
      description: "**【選填】** 描述文字",
    }),
    polygon: polygonSchema,
    isActive: z.boolean().default(true).openapi({
      description: "啟用中的 geofence 才會參與計算。預設 true",
    }),
  })
  .openapi("CreateGeofenceInput");

const updateBody = z
  .object({
    name: z.string().min(1).max(128).optional().openapi({
      description: "**【選填】** 更新後名稱",
    }),
    description: z.string().nullable().optional().openapi({
      description: "**【選填】** 更新描述；傳 null 清空",
    }),
    polygon: polygonSchema.optional().openapi({
      description: "**【選填】** 更新多邊形；提供則整份覆蓋",
    }),
    isActive: z.boolean().optional().openapi({
      description: "**【選填】** 啟用 / 停用",
    }),
  })
  .openapi("UpdateGeofenceInput");

const deviceGeofenceStateSchema = z
  .object({
    geofenceId: z.string().uuid(),
    geofenceName: z.string(),
    status: z.enum(["inside", "outside"]).nullable().openapi({
      description: "當前狀態；null 代表尚未有 GPS 上報",
    }),
    lastLatitude: z.string().nullable(),
    lastLongitude: z.string().nullable(),
    lastTransitionAt: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
  })
  .openapi("DeviceGeofenceState");

// ── Routes ──

const listSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/geofences",
  tags: ["Admin: 地理圍欄"],
  security,
  summary: "列出 tenant 所有 geofence",
  description: "**鑑權**：Bearer admin token。回傳全部 geofence（含 archived）。",
  request: { params: tenantParam },
  responses: {
    200: {
      description: "geofence 清單",
      content: {
        "application/json": {
          schema: successSchema(z.array(geofenceResponseSchema)),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const createSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/geofences",
  tags: ["Admin: 地理圍欄"],
  security,
  summary: "建立 geofence（PRD §6）",
  description: [
    "建立多邊形地理圍欄，關聯到設備後 Agent GPS 上報時後端自動計算 in/out。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- name 在 tenant 內必須唯一",
    "- polygon 至少 3 個頂點；首尾不必相同（算法自動閉合）",
    "- 建立不會自動 assign 給設備，需另呼叫 assign 端點",
  ].join("\n"),
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: {
      description: "建立成功",
      content: {
        "application/json": { schema: successSchema(geofenceResponseSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const getSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/geofences/{geofenceId}",
  tags: ["Admin: 地理圍欄"],
  security,
  summary: "取得單一 geofence 詳情",
  description: "**鑑權**：Bearer admin token。",
  request: { params: tenantGeofenceParam },
  responses: {
    200: {
      description: "geofence 詳情",
      content: {
        "application/json": { schema: successSchema(geofenceResponseSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const updateSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/geofences/{geofenceId}",
  tags: ["Admin: 地理圍欄"],
  security,
  summary: "更新 geofence（部分欄位）",
  description: [
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：polygon 提供時整份覆蓋，不做增量 merge。",
  ].join("\n"),
  request: {
    params: tenantGeofenceParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: {
      description: "更新後 geofence",
      content: {
        "application/json": { schema: successSchema(geofenceResponseSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const deleteSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/geofences/{geofenceId}",
  tags: ["Admin: 地理圍欄"],
  security,
  summary: "刪除 geofence",
  description: [
    "**⚠️ 不可逆操作。** 刪除時級聯清 device_geofence_assignments 與 device_geofence_states，",
    "但**不會**觸發 exit webhook（因為 geofence 已不存在，語意不明確）。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: { params: tenantGeofenceParam },
  responses: {
    204: { description: "刪除成功（無回傳）" },
    ...commonErrorResponses,
  },
});

const assignSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/geofences/{geofenceId}/assign",
  tags: ["Admin: 地理圍欄"],
  security,
  summary: "把設備關聯到 geofence",
  description: [
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 冪等：同一 (device, geofence) 重複 assign 不會出錯",
    "- 首次 GPS 上報時 state 才落表；本呼叫僅記錄意圖",
    "- 支援一台設備關聯多個 geofence（跨校區 / 多層圍欄）",
  ].join("\n"),
  request: { params: tenantDeviceGeofenceParam },
  responses: {
    204: { description: "關聯成功（無回傳）" },
    ...commonErrorResponses,
  },
});

const unassignSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/geofences/{geofenceId}/unassign",
  tags: ["Admin: 地理圍欄"],
  security,
  summary: "解除設備與 geofence 的關聯",
  description: [
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：解除關聯時同步清該對的 state（避免遺留舊 status 誤判）；",
    "**不**觸發 exit webhook（明確 admin 動作，非設備真的離開）。",
  ].join("\n"),
  request: { params: tenantDeviceGeofenceParam },
  responses: {
    204: { description: "解除成功（無回傳）" },
    ...commonErrorResponses,
  },
});

const deviceStatesSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/geofences",
  tags: ["Admin: 地理圍欄"],
  security,
  summary: "查設備當前 geofence in/out 狀態",
  description: [
    "回傳設備關聯的所有 geofence 及當前狀態。若設備尚未有 GPS 上報，state 欄位皆為 null。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "設備 geofence 狀態陣列",
      content: {
        "application/json": {
          schema: successSchema(z.array(deviceGeofenceStateSchema)),
        },
      },
    },
    ...commonErrorResponses,
  },
});

// ── App ──

export const geofencesAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
geofencesAdminApp.use("/admin/*", adminAuth());

function toDto(row: typeof geofences.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    polygon: row.polygon,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// list
geofencesAdminApp.openapi(listSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const rows = await db
    .select()
    .from(geofences)
    .where(eq(geofences.tenantId, tenantId));
  return c.json({ ok: true as const, data: rows.map(toDto) }, 200);
});

// create
geofencesAdminApp.openapi(createSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");

  const [row] = await db
    .insert(geofences)
    .values({
      tenantId,
      name: body.name,
      description: body.description ?? null,
      polygon: body.polygon,
      isActive: body.isActive,
    })
    .returning();

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "geofence.create",
    resourceType: "geofence",
    resourceId: row.id,
    payload: { name: body.name, vertexCount: body.polygon.length },
  });
  return c.json({ ok: true as const, data: toDto(row) }, 201);
});

// get
geofencesAdminApp.openapi(getSpec, async (c) => {
  const { tenantId, geofenceId } = c.req.valid("param");
  const [row] = await db
    .select()
    .from(geofences)
    .where(and(eq(geofences.tenantId, tenantId), eq(geofences.id, geofenceId)))
    .limit(1);
  if (!row) {
    throw new AppError(404, "geofence_not_found", "Geofence not found");
  }
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

// update
geofencesAdminApp.openapi(updateSpec, async (c) => {
  const { tenantId, geofenceId } = c.req.valid("param");
  const body = c.req.valid("json");

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.description !== undefined) update.description = body.description;
  if (body.polygon !== undefined) update.polygon = body.polygon;
  if (body.isActive !== undefined) update.isActive = body.isActive;

  if (Object.keys(update).length === 0) {
    throw new AppError(400, "empty_update", "至少一個欄位需提供");
  }

  const [row] = await db
    .update(geofences)
    .set(update)
    .where(and(eq(geofences.tenantId, tenantId), eq(geofences.id, geofenceId)))
    .returning();
  if (!row) {
    throw new AppError(404, "geofence_not_found", "Geofence not found");
  }
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "geofence.update",
    resourceType: "geofence",
    resourceId: geofenceId,
    payload: {
      fields: Object.keys(update),
      polygonVertices: body.polygon?.length,
    },
  });
  return c.json({ ok: true as const, data: toDto(row) }, 200);
});

// delete
geofencesAdminApp.openapi(deleteSpec, async (c) => {
  const { tenantId, geofenceId } = c.req.valid("param");
  const result = await db
    .delete(geofences)
    .where(and(eq(geofences.tenantId, tenantId), eq(geofences.id, geofenceId)))
    .returning({ id: geofences.id });
  if (result.length === 0) {
    throw new AppError(404, "geofence_not_found", "Geofence not found");
  }
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "geofence.delete",
    resourceType: "geofence",
    resourceId: geofenceId,
  });
  return c.body(null, 204);
});

// assign — 需驗證 device 屬於 tenant，且 geofence 屬於 tenant
geofencesAdminApp.openapi(assignSpec, async (c) => {
  const { tenantId, deviceId, geofenceId } = c.req.valid("param");

  const [device] = await db
    .select({ id: mdmDevices.id })
    .from(mdmDevices)
    .where(and(eq(mdmDevices.id, deviceId), eq(mdmDevices.tenantId, tenantId)))
    .limit(1);
  if (!device) {
    throw new AppError(404, "device_not_found", "Device not found in tenant");
  }
  const [gf] = await db
    .select({ id: geofences.id })
    .from(geofences)
    .where(and(eq(geofences.id, geofenceId), eq(geofences.tenantId, tenantId)))
    .limit(1);
  if (!gf) {
    throw new AppError(404, "geofence_not_found", "Geofence not found in tenant");
  }

  await db
    .insert(deviceGeofenceAssignments)
    .values({ deviceId, geofenceId })
    .onConflictDoNothing();

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "geofence.assign",
    resourceType: "device",
    resourceId: deviceId,
    payload: { geofenceId },
  });
  return c.body(null, 204);
});

// unassign — 同步刪 state 避免遺留
geofencesAdminApp.openapi(unassignSpec, async (c) => {
  const { tenantId, deviceId, geofenceId } = c.req.valid("param");

  // 驗證屬於此 tenant（防止跨 tenant 越權操作）
  const [device] = await db
    .select({ id: mdmDevices.id })
    .from(mdmDevices)
    .where(and(eq(mdmDevices.id, deviceId), eq(mdmDevices.tenantId, tenantId)))
    .limit(1);
  if (!device) {
    throw new AppError(404, "device_not_found", "Device not found in tenant");
  }

  await db
    .delete(deviceGeofenceAssignments)
    .where(
      and(
        eq(deviceGeofenceAssignments.deviceId, deviceId),
        eq(deviceGeofenceAssignments.geofenceId, geofenceId),
      ),
    );
  await db
    .delete(deviceGeofenceStates)
    .where(
      and(
        eq(deviceGeofenceStates.deviceId, deviceId),
        eq(deviceGeofenceStates.geofenceId, geofenceId),
      ),
    );

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "geofence.unassign",
    resourceType: "device",
    resourceId: deviceId,
    payload: { geofenceId },
  });
  return c.body(null, 204);
});

// device states — join assignment + state + geofence 名稱
geofencesAdminApp.openapi(deviceStatesSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");

  const [device] = await db
    .select({ id: mdmDevices.id })
    .from(mdmDevices)
    .where(and(eq(mdmDevices.id, deviceId), eq(mdmDevices.tenantId, tenantId)))
    .limit(1);
  if (!device) {
    throw new AppError(404, "device_not_found", "Device not found in tenant");
  }

  const rows = await db
    .select({
      geofenceId: deviceGeofenceAssignments.geofenceId,
      geofenceName: geofences.name,
      status: deviceGeofenceStates.status,
      lastLatitude: deviceGeofenceStates.lastLatitude,
      lastLongitude: deviceGeofenceStates.lastLongitude,
      lastTransitionAt: deviceGeofenceStates.lastTransitionAt,
      lastCheckedAt: deviceGeofenceStates.lastCheckedAt,
    })
    .from(deviceGeofenceAssignments)
    .innerJoin(
      geofences,
      and(
        eq(deviceGeofenceAssignments.geofenceId, geofences.id),
        eq(geofences.tenantId, tenantId),
      ),
    )
    .leftJoin(
      deviceGeofenceStates,
      and(
        eq(deviceGeofenceStates.deviceId, deviceId),
        eq(deviceGeofenceStates.geofenceId, deviceGeofenceAssignments.geofenceId),
      ),
    )
    .where(eq(deviceGeofenceAssignments.deviceId, deviceId));

  const data = rows.map((r) => ({
    geofenceId: r.geofenceId,
    geofenceName: r.geofenceName,
    status: (r.status as "inside" | "outside" | null) ?? null,
    lastLatitude: r.lastLatitude,
    lastLongitude: r.lastLongitude,
    lastTransitionAt: r.lastTransitionAt?.toISOString() ?? null,
    lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
  }));

  return c.json({ ok: true as const, data }, 200);
});

// 靜態使用 GEOFENCE_STATUS 常量（避免 unused import warning）
export { GEOFENCE_STATUS };
