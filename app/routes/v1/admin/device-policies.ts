/**
 * 設備策略推送 API。
 *
 * 把已實現的 CSP 能力（WiFi / 桌布 / 密碼 / USB / AppLocker）暴露為
 * 友善的管理端點。每個端點接收業務參數，內部構建 SyncML 命令排入佇列。
 * 回傳 202 Accepted + commandIds。
 */

import { z } from "@hono/zod-openapi";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { commonErrorResponses, deviceIdParam, successSchema } from "~/lib/api.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import {
  getWindowsDeviceForPolicy,
  pushWiFiToDevice,
  removeWiFiFromDevice,
  pushWallpaperToDevice,
  pushPasswordPolicyToDevice,
  pushUsbPolicyToDevice,
  pushAppRestrictionToDevice,
} from "~/services/device-policies.ts";

// ── Response schema ──

const commandResultSchema = z
  .object({
    commandIds: z.array(z.string().uuid()).openapi({
      description: "排入佇列的命令 UUID 列表",
    }),
  })
  .openapi("PolicyCommandResult");

// ── WiFi ──

const wifiBody = z
  .object({
    ssid: z.string().min(1).max(32).openapi({
      description: "WiFi SSID",
      example: "SchoolWiFi",
    }),
    auth: z
      .discriminatedUnion("type", [
        z.object({
          type: z.literal("open"),
        }),
        z.object({
          type: z.literal("WPA2PSK"),
          password: z.string().min(8).max(63).openapi({
            description: "WPA2-PSK 密碼（8-63 字元）",
            example: "MySecurePass123",
          }),
        }),
      ])
      .openapi({ description: "認證方式：open（無密碼）或 WPA2PSK" }),
    autoConnect: z.boolean().default(true).openapi({
      description: "自動連線（預設 true）",
    }),
    nonBroadcast: z.boolean().default(false).openapi({
      description: "隱藏 SSID（預設 false）",
    }),
  })
  .openapi("PushWiFiInput");

const pushWifiSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-wifi",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送 WiFi 連線設定",
  description: [
    "遠端推送 WiFi 連線設定到設備，設備自動連線。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 僅支援 WPA2-PSK 和 Open 兩種認證方式",
    "- 密碼以明文傳輸到設備端，設備端加密存儲",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: wifiBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const removeWifiBody = z
  .object({
    ssid: z.string().min(1).max(32).openapi({
      description: "要移除的 WiFi SSID",
      example: "SchoolWiFi",
    }),
  })
  .openapi("RemoveWiFiInput");

const removeWifiSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/remove-wifi",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "移除設備上的 WiFi 設定",
  description: [
    "遠端移除設備上指定 SSID 的 WiFi 設定。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: removeWifiBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── 桌布 / 鎖屏 ──

const wallpaperBody = z
  .object({
    desktopImageUrl: z.string().url().optional().openapi({
      description: "桌布圖 URL（HTTPS）",
      example: "https://cdn.example.com/school-wallpaper.jpg",
    }),
    lockScreenImageUrl: z.string().url().optional().openapi({
      description: "鎖屏圖 URL（HTTPS）",
      example: "https://cdn.example.com/school-lockscreen.jpg",
    }),
  })
  .refine((d) => d.desktopImageUrl || d.lockScreenImageUrl, {
    message: "至少需要 desktopImageUrl 或 lockScreenImageUrl 其中之一",
  })
  .openapi("PushWallpaperInput");

const pushWallpaperSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-wallpaper",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送桌布與登入畫面設定",
  description: [
    "統一設定學校桌布與 Windows 登入畫面圖片。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 圖片 URL 必須是設備可存取的 HTTPS 位址",
    "- 設備需 Windows 10/11 Pro 以上版本才支援",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: wallpaperBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── 密碼政策 ──

const passwordPolicyBody = z
  .object({
    enabled: z.boolean().optional().openapi({
      description: "啟用密碼要求",
    }),
    minLength: z.number().int().min(4).max(16).optional().openapi({
      description: "最短長度（4-16）",
      example: 8,
    }),
    complexity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional().openapi({
      description: "複雜度：1=數字 / 2=數字+小寫 / 3=字母數字 / 4=含特殊字元",
      example: 3,
    }),
    allowSimple: z.boolean().optional().openapi({
      description: "允許簡單密碼（如 123456）",
    }),
    maxFailedAttempts: z.number().int().min(0).max(999).optional().openapi({
      description: "連續失敗鎖定次數（0=不限）",
      example: 10,
    }),
    maxInactivityMinutes: z.number().int().min(0).optional().openapi({
      description: "閒置自動鎖屏（分鐘，0=不限）",
      example: 15,
    }),
    history: z.number().int().min(0).max(50).optional().openapi({
      description: "密碼歷史長度（防重複使用）",
      example: 5,
    }),
    expirationDays: z.number().int().min(0).max(730).optional().openapi({
      description: "密碼有效期（天，0=永不過期）",
      example: 90,
    }),
  })
  .openapi("PushPasswordPolicyInput");

const pushPasswordPolicySpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-password-policy",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送密碼政策",
  description: [
    "設定設備的密碼最短長度、複雜度要求、錯誤鎖定次數等。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 只有提供的欄位會被設定，未提供的欄位保持原值",
    "- 設備會在下次使用者更換密碼時強制執行新政策",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: passwordPolicyBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── USB 管控 ──

const usbPolicyBody = z
  .object({
    denyWriteAccess: z.boolean().optional().openapi({
      description: "禁止 USB 存儲寫入",
    }),
    denyReadAccess: z.boolean().optional().openapi({
      description: "禁止 USB 存儲讀取",
    }),
  })
  .openapi("PushUsbPolicyInput");

const pushUsbPolicySpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-usb-policy",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送 USB 存儲管控",
  description: [
    "禁止設備使用 USB 儲存裝置（隨身碟、外接硬碟）的讀取/寫入。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: usbPolicyBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── AppLocker（應用限制 / 白名單）──

const appLockerRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("path"),
    id: z.string().uuid().openapi({ description: "規則 UUID" }),
    name: z.string().openapi({ description: "規則名稱" }),
    description: z.string().optional(),
    action: z.enum(["Allow", "Deny"]).openapi({
      description: "Allow=允許執行；Deny=禁止執行",
    }),
    userOrGroupSid: z.string().default("S-1-1-0").openapi({
      description: "SID（預設 S-1-1-0 Everyone）",
    }),
    path: z.string().openapi({
      description: "路徑模式，支援 *",
      example: "C:\\Program Files\\*",
    }),
    exceptions: z.array(z.object({ path: z.string() })).optional(),
  }),
  z.object({
    type: z.literal("publisher"),
    id: z.string().uuid().openapi({ description: "規則 UUID" }),
    name: z.string().openapi({ description: "規則名稱" }),
    description: z.string().optional(),
    action: z.enum(["Allow", "Deny"]),
    userOrGroupSid: z.string().default("S-1-1-0"),
    publisherName: z.string().openapi({
      description: "簽名者 X.500 DN",
    }),
    productName: z.string().default("*").optional(),
    binaryName: z.string().default("*").optional(),
    versionRange: z
      .object({ low: z.string(), high: z.string() })
      .optional(),
  }),
]);

const appRestrictionBody = z
  .object({
    grouping: z.string().min(1).max(64).openapi({
      description: "規則分組識別符（如 default、school-policy），同 group 重推會覆蓋",
      example: "default",
    }),
    ruleCollection: z.enum(["EXE", "MSI", "Script", "StoreApps", "DLL"]).openapi({
      description: "規則集類型",
    }),
    enforcementMode: z.enum(["Enabled", "AuditOnly", "NotConfigured"]).default("Enabled").openapi({
      description: "Enabled=強制；AuditOnly=僅記錄不阻止",
    }),
    rules: z.array(appLockerRuleSchema).min(1).openapi({
      description: "AppLocker 規則列表（至少一條）",
    }),
  })
  .openapi("PushAppRestrictionInput");

const pushAppRestrictionSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-app-restriction",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送應用限制規則（AppLocker 白名單）",
  description: [
    "設定設備上可以/禁止執行的應用程式。透過 AppLocker 規則控制。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 同一 grouping + ruleCollection 重複推送會覆蓋先前規則",
    "- 規則類型：path（按路徑）或 publisher（按簽名者）",
    "- 設備需 Windows 10/11 Enterprise 或 Education 才完整支援 AppLocker",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: appRestrictionBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── App instance ──

export const devicePoliciesAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
devicePoliciesAdminApp.use("/admin/*", adminAuth());

// WiFi
devicePoliciesAdminApp.openapi(pushWifiSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushWiFiToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_wifi",
    resourceType: "device",
    resourceId: deviceId,
    payload: { ssid: body.ssid, authType: body.auth.type },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

devicePoliciesAdminApp.openapi(removeWifiSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { ssid } = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await removeWiFiFromDevice(device, ssid);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.remove_wifi",
    resourceType: "device",
    resourceId: deviceId,
    payload: { ssid },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// 桌布
devicePoliciesAdminApp.openapi(pushWallpaperSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushWallpaperToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_wallpaper",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      hasDesktop: !!body.desktopImageUrl,
      hasLockScreen: !!body.lockScreenImageUrl,
    },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// 密碼政策
devicePoliciesAdminApp.openapi(pushPasswordPolicySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushPasswordPolicyToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_password_policy",
    resourceType: "device",
    resourceId: deviceId,
    payload: body,
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// USB
devicePoliciesAdminApp.openapi(pushUsbPolicySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushUsbPolicyToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_usb_policy",
    resourceType: "device",
    resourceId: deviceId,
    payload: body,
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// AppLocker
devicePoliciesAdminApp.openapi(pushAppRestrictionSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushAppRestrictionToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_app_restriction",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      grouping: body.grouping,
      ruleCollection: body.ruleCollection,
      enforcementMode: body.enforcementMode,
      ruleCount: body.rules.length,
    },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});
