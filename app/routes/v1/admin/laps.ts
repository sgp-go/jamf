import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { getLapsPassword, rotateLapsPassword } from "~/services/laps.ts";

const tenantDeviceParam = z.object({
  tenantId: z
    .string()
    .uuid()
    .openapi({ param: { name: "tenantId", in: "path" } }),
  deviceId: z
    .string()
    .uuid()
    .openapi({ param: { name: "deviceId", in: "path" } }),
});

const lapsPasswordSchema = z
  .object({
    password: z.string(),
    adminAccount: z.string(),
    rotatedAt: z.string(),
    rotationId: z.string(),
    status: z.string(),
  })
  .openapi("LapsPasswordInfo");

const rotateBody = z
  .object({
    adminAccount: z
      .string()
      .max(64)
      .optional()
      .openapi({ description: "受管帳號名稱（預設 Administrator）" }),
  })
  .openapi("LapsRotateInput");

const rotateResultSchema = z
  .object({
    rotationId: z.string().uuid(),
    commandUuid: z.string().uuid(),
  })
  .openapi("LapsRotateResult");

const security = [{ BearerAuth: [] }];

// ── GET 查詢密碼 ────────────────────────────────────────────────────────────

const getPasswordSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/laps-password",
  tags: ["Admin: LAPS"],
  security,
  summary: "查詢設備當前 LAPS 管理員密碼",
  description:
    "回傳最新一筆已確認的 LAPS 密碼（解密後明文）。每次查詢都寫 audit log。",
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "密碼資訊",
      content: {
        "application/json": { schema: successSchema(lapsPasswordSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

// ── POST 手動觸發輪換 ──────────────────────────────────────────────────────

const rotateSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/laps-rotate",
  tags: ["Admin: LAPS"],
  security,
  summary: "手動觸發設備 LAPS 密碼輪換",
  description:
    "生成新隨機密碼並透過 ADMX Policy CSP 下發到設備。Agent 執行後上報確認。",
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: rotateBody } } },
  },
  responses: {
    200: {
      description: "輪換已排入",
      content: {
        "application/json": { schema: successSchema(rotateResultSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

// ── App ──────────────────────────────────────────────────────────────────────

export const lapsAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});

lapsAdminApp.use("/admin/*", adminAuth());

lapsAdminApp.openapi(getPasswordSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");

  const info = await getLapsPassword({ tenantId, deviceId });
  if (!info) {
    throw new AppError(404, "laps_not_found", "此設備尚無已確認的 LAPS 記錄");
  }

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.laps_password_viewed",
    resourceType: "device",
    resourceId: deviceId,
    payload: { rotationId: info.rotationId, adminAccount: info.adminAccount },
  });

  return c.json({ ok: true as const, data: info }, 200);
});

lapsAdminApp.openapi(rotateSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");

  const result = await rotateLapsPassword({
    tenantId,
    deviceId,
    adminAccount: body.adminAccount,
    triggeredBy: "manual",
  });

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.laps_rotated",
    resourceType: "device",
    resourceId: deviceId,
    payload: { rotationId: result.rotationId, adminAccount: body.adminAccount },
  });

  return c.json({ ok: true as const, data: result }, 200);
});
