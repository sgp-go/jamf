import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  commonErrorResponses,
  deviceIdParam,
  successSchema,
  tenantIdParam,
} from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  applyKioskToDevice,
  assignKiosk,
  createKioskProfile,
  deleteKioskProfile,
  getKioskProfile,
  getKioskState,
  listKioskProfiles,
  removeKioskFromDevice,
  unassignKiosk,
  updateKioskProfile,
} from "~/services/kiosk.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/kiosk/*
 *
 * Windows Kiosk（AssignedAccess）管理 — PRD Phase 3。
 * - Profile CRUD（edge_kiosk / uwp）
 * - Assignment（device / device_group）
 * - Apply / Remove / State
 */

// ── Schema ──

const appTypeEnum = z.enum(["edge_kiosk", "uwp"]).openapi({
  description:
    "edge_kiosk=鎖 Microsoft Edge（考試 URL / 展示頁）；uwp=鎖任意 UWP AUMID",
});

const edgeVariantEnum = z.enum(["public_browsing", "digital_signage"]).openapi({
  description:
    "public_browsing=公用瀏覽（考試模式，Session 結束清除瀏覽資料）；digital_signage=數位看板（不斷刷新展示頁）",
});

const kioskProfileSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z.string().openapi({
      description: "Profile 顯示名（tenant 內唯一）",
      example: "期末考試模式",
    }),
    description: z.string().nullable().openapi({
      description: "**【選填】** 描述備註",
    }),
    appType: appTypeEnum,
    edgeUrl: z.string().nullable().openapi({
      description:
        "**【選填】** edge_kiosk 專用：Kiosk 啟動 URL；uwp 模式為 null",
    }),
    edgeVariant: edgeVariantEnum.nullable().openapi({
      description:
        "**【選填】** edge_kiosk 專用：public_browsing 或 digital_signage；uwp 模式為 null",
    }),
    aumid: z.string().nullable().openapi({
      description:
        "**【選填】** uwp 專用：AppUserModelId（PowerShell `Get-StartApps` 取得）；edge_kiosk 模式為 null",
    }),
    autoLogonAccount: z.string().openapi({
      description:
        "AutoLogon 的本機帳號（預設 student，對應 PPKG 建立的學生帳號）",
      example: "student",
    }),
    breakoutSequence: z.string().nullable().openapi({
      description:
        "**【選填】** 應急退出組合鍵（如 Ctrl+B）；null 或空 = 完全禁 breakout。**必須雙鍵**（modifier + key），Ctrl+Alt+X 三鍵組合不生效（Alt 修飾鍵在 Chromium Edge Kiosk 全屏下被攔截）。觸發後需輸入 admin 密碼（走 LAPS 通道查 ITAdmin 密碼）",
    }),
    allowedUrls: z.array(z.string()).nullable().openapi({
      description:
        "**【選填】** Edge URL 白名單（僅 edge_kiosk 生效）；非 null 表示 kiosk 期間 Edge 只准訪問這裡列出的 URL，其他一律 blocked。語法同 Chromium URLAllowlist（bare host 匹配 host+subdomain；帶 scheme/path 則原樣）。範例：`[\"exam.school.edu.tw\", \"*.gov.edu.tw\"]`",
    }),
    version: z.number().int(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("KioskProfile");

const createProfileBody = z
  .object({
    name: z.string().min(1).max(128).openapi({
      description: "Profile 顯示名（tenant 內唯一）",
      example: "期末考試模式",
    }),
    description: z.string().nullable().optional().openapi({
      description: "**【選填】** 描述備註",
    }),
    appType: appTypeEnum,
    edgeUrl: z.string().url().nullable().optional().openapi({
      description:
        "**【選填】** edge_kiosk 必填：Kiosk 啟動 URL（如 https://exam.school.edu.tw）",
    }),
    edgeVariant: edgeVariantEnum.nullable().optional().openapi({
      description: "**【選填】** edge_kiosk 必填",
    }),
    aumid: z.string().nullable().optional().openapi({
      description:
        "**【選填】** uwp 必填：AppUserModelId（如 Microsoft.WindowsCalculator_8wekyb3d8bbwe!App）",
    }),
    autoLogonAccount: z.string().min(1).max(64).optional().openapi({
      description: "**【選填】** 預設 student",
    }),
    breakoutSequence: z.string().nullable().optional().openapi({
      description:
        "**【選填】** 應急退出組合鍵（如 Ctrl+B）；null = 禁 breakout。**必須雙鍵**，Ctrl+Alt+X 三鍵不生效（Edge kiosk 全屏 Alt 被攔）",
      example: "Ctrl+B",
    }),
    allowedUrls: z.array(z.string().min(1)).nullable().optional().openapi({
      description:
        "**【選填】** Edge URL 白名單，僅 edge_kiosk 支援；只准訪問名單內 URL，其他一律 block。uwp 模式傳非空陣列會 400。省略或 null 或空陣列 = 不加白名單",
      example: ["exam.school.edu.tw", "*.gov.edu.tw"],
    }),
  })
  .openapi("CreateKioskProfileInput");

const updateProfileBody = createProfileBody.openapi("UpdateKioskProfileInput");

const assignBody = z
  .object({
    scope: z.enum(["device_group", "device"]).openapi({
      description: "指派範圍：device_group 或 device",
    }),
    targetId: z.string().uuid().openapi({
      description: "device_group UUID 或 device UUID（依 scope）",
    }),
  })
  .openapi("AssignKioskInput");

const assignmentSchema = z
  .object({
    id: z.string().uuid(),
    profileId: z.string().uuid(),
    scope: z.enum(["device_group", "device"]),
    deviceGroupId: z.string().uuid().nullable().openapi({
      description: "**【選填】** scope=device_group 時的目標分組",
    }),
    deviceId: z.string().uuid().nullable().openapi({
      description: "**【選填】** scope=device 時的目標設備",
    }),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("KioskAssignment");

const applyBody = z
  .object({
    profileId: z.string().uuid().openapi({
      description: "要派發的 Kiosk profile UUID",
    }),
    activation: z.enum(["next_logon", "reboot"]).optional().openapi({
      description:
        "**【選填】** Kiosk 何時生效：`next_logon`（預設）不派額外命令，靠用戶下次 sign in 觸發（Windows 設計）；`reboot` apply 完立即派 RebootNow，設備自動重啟後 AutoLogon 進 Kiosk（含 5min 倒數通知）。session 內動態切 shell 官方不支援，這是唯二選項",
    }),
  })
  .openapi("KioskApplyInput");

const applyResultSchema = z
  .object({
    deviceId: z.string().uuid(),
    profileId: z.string().uuid(),
    commandIds: z.array(z.string().uuid()).openapi({
      description: "本次派發的 mdm_commands UUID 列表",
    }),
    version: z.number().int().openapi({
      description: "派發時 profile 的 version（設備 ack 後對齊 appliedVersion）",
    }),
  })
  .openapi("KioskApplyResult");

const removeResultSchema = z
  .object({
    deviceId: z.string().uuid(),
    commandIds: z.array(z.string().uuid()),
  })
  .openapi("KioskRemoveResult");

const stateSchema = z
  .object({
    deviceId: z.string().uuid(),
    profileId: z.string().uuid().nullable().openapi({
      description: "**【選填】** 當前綁定的 profile；status=removed 時 null",
    }),
    status: z.enum(["pending", "active", "failed", "removed"]).openapi({
      description:
        "pending=已派發等 ack；active=已生效；failed=派發失敗；removed=已撤除",
    }),
    appliedVersion: z.number().int().nullable().openapi({
      description: "**【選填】** 設備 ack 後的 profile.version；null=未 ack",
    }),
    lastCommandId: z.string().uuid().nullable().openapi({
      description: "**【選填】** 最後一次派發 command UUID",
    }),
    errorDetail: z.string().nullable().openapi({
      description: "**【選填】** status=failed 時的錯誤細節",
    }),
    deployedAt: z.string().nullable(),
    removedAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .openapi("KioskDeviceState");

const profileIdParam = tenantIdParam.extend({
  profileId: z.string().uuid().openapi({
    param: { name: "profileId", in: "path" },
    description: "Kiosk profile UUID",
  }),
});

const assignmentIdParam = tenantIdParam.extend({
  assignmentId: z.string().uuid().openapi({
    param: { name: "assignmentId", in: "path" },
    description: "Kiosk assignment UUID",
  }),
});

// ── Routes ──

const createProfileSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/kiosk/profiles",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "建立 Kiosk Profile",
  description: [
    "建立 Kiosk profile（tenant scoped）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**兩種模式**：",
    "- `edge_kiosk`：鎖 Microsoft Edge，需填 edgeUrl + edgeVariant；uwp 欄位須為 null",
    "- `uwp`：鎖任意 UWP，需填 aumid；edgeUrl/edgeVariant 須為 null",
    "",
    "**注意事項**：",
    "- 建立後不自動派發，需另呼叫 `/devices/{deviceId}/kiosk/apply`。",
    "- SKU 限制：僅支援 Win10/11 Pro 單 App UWP Kiosk；Win32 exe Kiosk 需 Enterprise/Edu，本端點不支援。",
  ].join("\n"),
  request: {
    params: tenantIdParam,
    body: { content: { "application/json": { schema: createProfileBody } } },
  },
  responses: {
    201: {
      description: "建立成功，回傳完整 profile 物件",
      content: { "application/json": { schema: successSchema(kioskProfileSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listProfilesSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/kiosk/profiles",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "列出 Kiosk Profiles",
  description: [
    "回傳 tenant 下所有 Kiosk profiles。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: { params: tenantIdParam },
  responses: {
    200: {
      description: "Kiosk profiles 列表",
      content: {
        "application/json": { schema: successSchema(z.array(kioskProfileSchema)) },
      },
    },
    ...commonErrorResponses,
  },
});

const getProfileSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/kiosk/profiles/{profileId}",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "取得單筆 Kiosk Profile",
  description: [
    "取得單筆 profile 詳情。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: { params: profileIdParam },
  responses: {
    200: {
      description: "Kiosk profile 詳情",
      content: { "application/json": { schema: successSchema(kioskProfileSchema) } },
    },
    ...commonErrorResponses,
  },
});

const updateProfileSpec = createRoute({
  method: "put",
  path: "/admin/tenants/{tenantId}/kiosk/profiles/{profileId}",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "更新 Kiosk Profile（全量）",
  description: [
    "全量更新 profile；version 自增 1。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：更新後不自動重派；下次 apply 時才會反映到設備。",
  ].join("\n"),
  request: {
    params: profileIdParam,
    body: { content: { "application/json": { schema: updateProfileBody } } },
  },
  responses: {
    200: {
      description: "更新後的 profile（version 已 +1）",
      content: { "application/json": { schema: successSchema(kioskProfileSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteProfileSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/kiosk/profiles/{profileId}",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "刪除 Kiosk Profile",
  description: [
    "刪除 profile。cascade 刪除相關 assignments 與 device_states.profile_id set null。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**不可逆**：已部署設備需另外呼叫 `/kiosk/disable` 才會撤除當前生效配置。",
  ].join("\n"),
  request: { params: profileIdParam },
  responses: {
    204: { description: "刪除成功，無 body" },
    ...commonErrorResponses,
  },
});

const assignSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/kiosk/profiles/{profileId}/assignments",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "指派 Kiosk Profile 到 device / device_group",
  description: [
    "將 Kiosk profile 指派給單台設備或整個 device_group。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：assignment 本身不觸發派發，需再呼叫 `/kiosk/apply`。",
  ].join("\n"),
  request: {
    params: profileIdParam,
    body: { content: { "application/json": { schema: assignBody } } },
  },
  responses: {
    201: {
      description: "指派成功",
      content: { "application/json": { schema: successSchema(assignmentSchema) } },
    },
    ...commonErrorResponses,
  },
});

const unassignSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/kiosk/assignments/{assignmentId}",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "移除 Kiosk 指派",
  description: [
    "移除單筆 assignment。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：不會自動撤除設備上生效的 Kiosk configuration；需另呼叫 `/kiosk/disable`。",
  ].join("\n"),
  request: { params: assignmentIdParam },
  responses: {
    204: { description: "移除成功，無 body" },
    ...commonErrorResponses,
  },
});

const applySpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/kiosk/apply",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "派發 Kiosk 到單台設備",
  description: [
    "把指定 Kiosk profile 派發到單台 Windows 設備（AssignedAccess Replace verb）。",
    "設備下次連線（秒級 WNS 觸發）即進入 Kiosk 模式。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 平台限 Windows；其他平台回 400。",
    "- AutoLogon 的本機帳號需已存在設備上（如 PPKG 建立的 student 帳號）。",
    "- 派發後首次 kiosk 模式生效需重啟；建議搭配 `/devices/{deviceId}/reboot`。",
    "",
    "**事件**：成功後將更新 `kiosk_device_states.status=pending`，設備 ack 後轉 active。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: applyBody } } },
  },
  responses: {
    200: {
      description: "派發成功，回傳 commandIds + version",
      content: { "application/json": { schema: successSchema(applyResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const disableBody = z
  .object({
    activation: z.enum(["next_logon", "reboot"]).optional().openapi({
      description:
        "**【選填】** 何時退出 Kiosk：`next_logon`（預設）只撤 config，用戶下次 sign in 才回普通桌面；`reboot` 撤 config 後派 RebootNow，設備自動重啟後 AutoLogon 進普通桌面。跟 apply 對稱設計",
    }),
  })
  .openapi("KioskDisableInput");

const disableSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/kiosk/disable",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "撤除設備上的 Kiosk 配置",
  description: [
    "對 AssignedAccess Configuration 節點下 Delete verb + 清 Edge URL Blocklist/Allowlist，恢復桌面 Edge 訪問。",
    "冪等：即使設備從未被派過 Kiosk 也允許呼叫。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**activation**：預設 `next_logon`（需用戶手動 sign out 或下次 login 才退出）；`reboot` 服務端派 RebootNow 5min 倒數自動離開。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: {
      content: { "application/json": { schema: disableBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "撤除命令已派發",
      content: {
        "application/json": { schema: successSchema(removeResultSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const stateSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/kiosk/state",
  tags: ["Admin: Kiosk"],
  security: [{ BearerAuth: [] }],
  summary: "查詢設備當前 Kiosk 狀態",
  description: [
    "回傳設備當前 Kiosk 部署狀態（pending / active / failed / removed）。",
    "無紀錄時回 200 + null data。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: { params: deviceIdParam },
  responses: {
    200: {
      description: "Kiosk 狀態；設備從未派過 Kiosk 時 data=null",
      content: {
        "application/json": {
          schema: successSchema(stateSchema.nullable()),
        },
      },
    },
    ...commonErrorResponses,
  },
});

// ── Handlers ──

export const kioskAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
kioskAdminApp.use("/admin/*", adminAuth());

kioskAdminApp.openapi(createProfileSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const meta = extractAuditMeta(c);
  const profile = await createKioskProfile({
    tenantId,
    input: body,
    createdBy: meta.actor,
  });
  await logAudit({
    ...meta,
    tenantId,
    action: "kiosk.profile.create",
    resourceType: "kiosk_profile",
    resourceId: profile.id,
    payload: { name: profile.name, appType: profile.appType },
  });
  return c.json({ ok: true as const, data: profile }, 201);
});

kioskAdminApp.openapi(listProfilesSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const rows = await listKioskProfiles(tenantId);
  return c.json({ ok: true as const, data: rows }, 200);
});

kioskAdminApp.openapi(getProfileSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  const row = await getKioskProfile({ tenantId, profileId });
  return c.json({ ok: true as const, data: row }, 200);
});

kioskAdminApp.openapi(updateProfileSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  const body = c.req.valid("json");
  const meta = extractAuditMeta(c);
  const updated = await updateKioskProfile({ tenantId, profileId, input: body });
  await logAudit({
    ...meta,
    tenantId,
    action: "kiosk.profile.update",
    resourceType: "kiosk_profile",
    resourceId: profileId,
    payload: { name: updated.name, version: updated.version },
  });
  return c.json({ ok: true as const, data: updated }, 200);
});

kioskAdminApp.openapi(deleteProfileSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  const meta = extractAuditMeta(c);
  await deleteKioskProfile({ tenantId, profileId });
  await logAudit({
    ...meta,
    tenantId,
    action: "kiosk.profile.delete",
    resourceType: "kiosk_profile",
    resourceId: profileId,
  });
  return c.body(null, 204);
});

kioskAdminApp.openapi(assignSpec, async (c) => {
  const { tenantId, profileId } = c.req.valid("param");
  const body = c.req.valid("json");
  const meta = extractAuditMeta(c);
  const assignment = await assignKiosk({
    tenantId,
    profileId,
    input: body,
    createdBy: meta.actor,
  });
  await logAudit({
    ...meta,
    tenantId,
    action: "kiosk.assign",
    resourceType: "kiosk_assignment",
    resourceId: assignment.id,
    payload: { profileId, scope: body.scope, targetId: body.targetId },
  });
  return c.json({ ok: true as const, data: assignment }, 201);
});

kioskAdminApp.openapi(unassignSpec, async (c) => {
  const { tenantId, assignmentId } = c.req.valid("param");
  const meta = extractAuditMeta(c);
  await unassignKiosk({ tenantId, assignmentId });
  await logAudit({
    ...meta,
    tenantId,
    action: "kiosk.unassign",
    resourceType: "kiosk_assignment",
    resourceId: assignmentId,
  });
  return c.body(null, 204);
});

kioskAdminApp.openapi(applySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { profileId, activation } = c.req.valid("json");
  const meta = extractAuditMeta(c);
  const result = await applyKioskToDevice({
    tenantId,
    deviceId,
    profileId,
    activation,
  });
  await logAudit({
    ...meta,
    tenantId,
    action: "kiosk.apply",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      profileId,
      activation: activation ?? "next_logon",
      commandIds: result.commandUuids,
      version: result.version,
    },
  });
  return c.json({
    ok: true as const,
    data: {
      deviceId: result.deviceId,
      profileId: result.profileId,
      commandIds: result.commandUuids,
      version: result.version,
    },
  }, 200);
});

kioskAdminApp.openapi(disableSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  // body 是 optional：沒傳就等同 { activation: "next_logon" }
  const body = c.req.header("content-length") && c.req.header("content-length") !== "0"
    ? c.req.valid("json")
    : {};
  const activation = (body as { activation?: "next_logon" | "reboot" })
    .activation;
  const meta = extractAuditMeta(c);
  const result = await removeKioskFromDevice({
    tenantId,
    deviceId,
    activation,
  });
  await logAudit({
    ...meta,
    tenantId,
    action: "kiosk.disable",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      activation: activation ?? "next_logon",
      commandIds: result.commandUuids,
    },
  });
  return c.json({
    ok: true as const,
    data: {
      deviceId: result.deviceId,
      commandIds: result.commandUuids,
    },
  }, 200);
});

kioskAdminApp.openapi(stateSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const state = await getKioskState({ tenantId, deviceId });
  return c.json({ ok: true as const, data: state }, 200);
});
