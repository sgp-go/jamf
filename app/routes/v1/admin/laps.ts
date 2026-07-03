import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmWindowsLaps } from "~/db/schema/laps.ts";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { decryptSecret } from "~/lib/secrets.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  getLapsPassword,
  getUserPassword,
  resetUserPassword,
  rotateLapsPassword,
} from "~/services/laps.ts";

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

const lapsPasswordSchema = z
  .object({
    password: z.string().openapi({
      description: "解密後的密碼明文（每次查詢都寫 audit log）",
      example: "kX9#mP2$vL7@nQ4",
    }),
    adminAccount: z.string().openapi({
      description: "受管的本機帳號名稱（admin 或 student 帳號皆共用此欄位）",
      example: "ITAdmin",
    }),
    accountType: z.string().openapi({
      description: "帳號分類：admin=管理員（LAPS 自動輪換）；student=學生（管理員手動重設）；other=其他",
      example: "admin",
    }),
    requireChangeOnFirstLogon: z.boolean().openapi({
      description: "當次重設是否附帶「下次登入強制改密」旗標",
    }),
    rotatedAt: z.string().openapi({
      description: "密碼最後重設時間（ISO 8601 UTC）",
    }),
    rotationId: z.string().openapi({
      description: "本次重設的唯一識別碼（UUID）",
    }),
    status: z.string().openapi({
      description: "狀態：confirmed＝Agent 已確認執行；pending＝等待 Agent 回報",
      example: "confirmed",
    }),
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
    rotationId: z.string().uuid().openapi({
      description: "本次輪換的唯一識別碼，可用於追蹤 Agent 確認狀態",
    }),
    commandUuid: z.string().uuid().openapi({
      description: "已排入的 MDM 命令 UUID（ADMX Policy CSP 下發）",
    }),
  })
  .openapi("LapsRotateResult");

const security = [{ BearerAuth: [] }];

// ── GET 查詢密碼 ────────────────────────────────────────────────────────────

const getPasswordSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/laps-password",
  tags: ["密碼託管（LAPS）"],
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
  tags: ["密碼託管（LAPS）"],
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

// ── POST 通用密碼重設（含 student）────────────────────────────────────────────

const targetAccountRegex = /^[a-zA-Z0-9._-]{1,20}$/;

const resetUserPwdBody = z
  .object({
    targetAccount: z
      .string()
      .min(1)
      .max(20)
      .regex(targetAccountRegex)
      .openapi({
        description:
          "目標本機帳號名（如 'student'）。**白名單 regex** `^[a-zA-Z0-9._-]{1,20}$` " +
          "防 `net user` 參數注入。",
        example: "student",
      }),
    mode: z.enum(["random", "explicit"]).openapi({
      description:
        "random=系統隨機生成 20 字元強密碼；explicit=使用 body.password（管理員指定明碼）",
    }),
    password: z.string().min(4).max(127).optional().openapi({
      description: "**【選填】** mode=explicit 時必填；mode=random 時忽略",
    }),
    requireChangeOnFirstLogon: z.boolean().optional().openapi({
      description:
        "**【選填】** true = Agent 改密後額外跑 `net user <acct> /logonpasswordchg:yes` 強制帳號下次登入改密；預設 false",
    }),
    accountType: z.enum(["admin", "student", "other"]).optional().openapi({
      description:
        "**【選填】** 帳號分類，預設 student；影響 audit / 查詢過濾。admin 觸發等同 LAPS 手動輪換",
    }),
  })
  .openapi("ResetUserPasswordInput");

const resetUserPwdSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/user-password/reset",
  tags: ["密碼託管（LAPS）"],
  security,
  summary: "重設設備上指定本機帳號的密碼（含 student / admin）",
  description: [
    "通用密碼重設：管理員指定 targetAccount 帳號 + 明碼 or 隨機生成，透過 LAPS 通道下發。",
    "同一通道支援 admin（LAPS 自動輪換手動觸發）與 student（新學期重設 / 學生忘密求助）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 密碼明碼**只此 API 回傳一次**；後續透過 GET `/user-password/{account}` 查（會寫 audit）",
    "- `targetAccount` 走 regex `^[a-zA-Z0-9._-]{1,20}$` 防 net user 參數注入",
    "- Agent 改密失敗（帳號不存在 / 密碼不合規 / 系統錯誤）會回報 status=failed 並帶 stderr",
    "- **不會**主動創建不存在的帳號；帳號需事先由 PPKG 建立",
  ].join("\n"),
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: resetUserPwdBody } } },
  },
  responses: {
    200: {
      description: "重設已排入 CSP 通道；回傳 rotationId + commandUuid",
      content: {
        "application/json": {
          schema: successSchema(
            rotateResultSchema.extend({
              password: z.string().openapi({
                description:
                  "**【一次性明碼回傳】** DB 只存 sha256 之外加密副本；請立即記錄或傳達給使用者",
              }),
            }),
          ),
        },
      },
    },
    ...commonErrorResponses,
  },
});

// ── GET 按帳號查密碼 ────────────────────────────────────────────────────────

const userPasswordAccountParam = tenantDeviceParam.extend({
  targetAccount: z
    .string()
    .min(1)
    .max(20)
    .regex(targetAccountRegex)
    .openapi({
      param: { name: "targetAccount", in: "path" },
      description: "目標帳號名（同 reset 時傳的 targetAccount）",
      example: "student",
    }),
});

const getUserPwdSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/user-password/{targetAccount}",
  tags: ["密碼託管（LAPS）"],
  security,
  summary: "查詢設備上指定帳號的最新已確認密碼",
  description: [
    "回傳指定帳號最新一筆 status=confirmed 的密碼明文（跨 admin/student/other 通用）。",
    "每次呼叫寫 audit log。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**404**：該帳號尚無已確認記錄（可能剛 reset 還 pending，或從未 reset 過）",
  ].join("\n"),
  request: { params: userPasswordAccountParam },
  responses: {
    200: {
      description: "帳號密碼資訊",
      content: {
        "application/json": { schema: successSchema(lapsPasswordSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

lapsAdminApp.openapi(resetUserPwdSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");

  if (body.mode === "explicit" && !body.password) {
    throw new AppError(
      400,
      "password_required",
      "mode=explicit 時 password 為必填",
    );
  }

  const result = await resetUserPassword({
    tenantId,
    deviceId,
    targetAccount: body.targetAccount,
    accountType: body.accountType ?? "student",
    mode: body.mode,
    explicitPassword: body.password,
    requireChangeOnFirstLogon: body.requireChangeOnFirstLogon ?? false,
    triggeredBy: "manual",
  });

  // 一次性回傳明碼：mode=explicit 直接用 body.password；random 從剛派的 row 讀
  // （row status=pending，`getUserPassword` 只找 confirmed → 這裡直接 by rotationId 讀）
  let plainPassword: string;
  if (body.mode === "explicit") {
    plainPassword = body.password!;
  } else {
    const row = await db.query.mdmWindowsLaps.findFirst({
      where: eq(mdmWindowsLaps.rotationId, result.rotationId),
      columns: { passwordEnc: true },
    });
    if (!row) {
      throw new AppError(500, "reset_row_missing", "剛派的重設 row 找不到");
    }
    plainPassword = decryptSecret(row.passwordEnc);
  }

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.user_password_reset",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      rotationId: result.rotationId,
      targetAccount: body.targetAccount,
      accountType: body.accountType ?? "student",
      mode: body.mode,
      requireChangeOnFirstLogon: body.requireChangeOnFirstLogon ?? false,
    },
  });

  return c.json(
    {
      ok: true as const,
      data: { ...result, password: plainPassword },
    },
    200,
  );
});

lapsAdminApp.openapi(getUserPwdSpec, async (c) => {
  const { tenantId, deviceId, targetAccount } = c.req.valid("param");

  const info = await getUserPassword({ tenantId, deviceId, targetAccount });
  if (!info) {
    throw new AppError(
      404,
      "user_password_not_found",
      `帳號 ${targetAccount} 尚無已確認的密碼記錄`,
    );
  }

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.user_password_viewed",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      targetAccount,
      accountType: info.accountType,
      rotationId: info.rotationId,
    },
  });

  return c.json({ ok: true as const, data: info }, 200);
});
