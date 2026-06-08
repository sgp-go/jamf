import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { getBitLockerRecoveryKey } from "~/services/bitlocker.ts";

const tenantDeviceParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
  deviceId: z.string().uuid().openapi({
    param: { name: "deviceId", in: "path" },
    description: "設備 UUID",
    example: "9d4c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c",
  }),
});

const recoveryKeySchema = z
  .object({
    recoveryPassword: z.string().nullable().openapi({
      description: "解密後的 BitLocker Recovery Password（48 位數字，8 組 6 位）",
      example: "034386-466246-412808-216832-325061-463441-321299-112893",
    }),
    encryptionMethod: z.string().nullable().openapi({
      description: "加密演算法（如 XtsAes256）",
      example: "XtsAes256",
    }),
    encryptionId: z.string().openapi({
      description: "本次加密的唯一識別碼（UUID）",
    }),
    status: z.string().openapi({
      description: "狀態：confirmed＝Agent 已確認加密成功；pending＝等待 Agent 回報",
      example: "confirmed",
    }),
    confirmedAt: z.string().nullable().openapi({
      description: "確認時間（ISO 8601 UTC）",
    }),
  })
  .openapi("BitLockerRecoveryInfo");

const security = [{ BearerAuth: [] }];

const getRecoveryKeySpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/bitlocker-recovery",
  tags: ["BitLocker 加密管理"],
  security,
  summary: "查詢設備 BitLocker Recovery Password",
  description:
    "回傳最新一筆 BitLocker 加密記錄的 Recovery Password（解密後明文）。每次查詢都寫 audit log。",
  request: { params: tenantDeviceParam },
  responses: {
    200: {
      description: "Recovery Key 資訊",
      content: {
        "application/json": { schema: successSchema(recoveryKeySchema) },
      },
    },
    ...commonErrorResponses,
  },
});

export const bitlockerAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});

bitlockerAdminApp.use("/admin/*", adminAuth());

bitlockerAdminApp.openapi(getRecoveryKeySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");

  const info = await getBitLockerRecoveryKey({ tenantId, deviceId });
  if (!info) {
    throw new AppError(404, "bitlocker_not_found", "此設備尚無 BitLocker 加密記錄");
  }

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.bitlocker_recovery_viewed",
    resourceType: "device",
    resourceId: deviceId,
    payload: { encryptionId: info.encryptionId, status: info.status },
  });

  return c.json({ ok: true as const, data: info }, 200);
});
