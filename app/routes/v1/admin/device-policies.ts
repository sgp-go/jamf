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
  pushVpnToDevice,
  removeVpnFromDevice,
  pushCameraPolicyToDevice,
  pushFirewallPolicyToDevice,
  pushDeviceRenameToDevice,
  pushSettingsRestrictionToDevice,
  pushLostModeToDevice,
  removeLostModeFromDevice,
  pushDefenderPolicyToDevice,
  queryDefenderHealthOnDevice,
  pushBlockedSitesToDevice,
  clearBlockedSitesFromDevice,
  pushUpdatePolicyToDevice,
  triggerOsUpdateNow,
  queryUpdateStatusOnDevice,
  pushEdgeBrowserSigninToDevice,
  clearEdgeBrowserSigninFromDevice,
  pushDeviceInstallPolicyToDevice,
  clearDeviceInstallPolicyFromDevice,
} from "~/services/device-policies.ts";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { and, eq } from "drizzle-orm";

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

// ── VPN ──

const vpnBody = z
  .object({
    profileName: z.string().min(1).max(64).openapi({
      description: "VPN profile 名稱（顯示於設備 VPN 設定畫面，不可含 /）",
      example: "School-VPN",
    }),
    serverHost: z.string().min(1).openapi({
      description: "VPN 伺服器位址（FQDN 或 IP）",
      example: "vpn.school.edu.tw",
    }),
    protocol: z.enum(["IKEv2", "L2TP"]).openapi({
      description: "VPN 協議：IKEv2（推薦，無需 PSK）或 L2TP（需 l2tpPsk）",
    }),
    l2tpPsk: z.string().optional().openapi({
      description: "**【選填】** L2TP 預共享密鑰。protocol=L2TP 時必填；IKEv2 忽略",
    }),
    rememberCredentials: z.boolean().default(true).openapi({
      description: "允許設備記住使用者帳密。預設 true",
    }),
    alwaysOn: z.boolean().default(false).openapi({
      description: "Always-on：螢幕解鎖即自動連線。預設 false",
    }),
    dnsSuffix: z.string().optional().openapi({
      description: "**【選填】** DNS 後綴（如 school.edu.tw）",
    }),
    routingPolicy: z.enum(["SplitTunnel", "ForceTunnel"]).default("SplitTunnel").openapi({
      description: "SplitTunnel=只指定流量走 VPN；ForceTunnel=全流量走 VPN",
    }),
    trustedNetworkDetection: z.array(z.string()).optional().openapi({
      description: "**【選填】** 信任網路 DNS 後綴清單（在這些網路時不自動連 VPN）",
    }),
  })
  .openapi("PushVpnInput");

const pushVpnSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-vpn",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送 VPN 連線設定",
  description: [
    "遠端推送 VPN profile 到設備，設備在 VPN 設定畫面看到新增 profile。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- MVP 只支援 Windows 原生 IKEv2 / L2TP 兩種協議",
    "- VPN 帳號密碼**不在 profile 內**，使用者首次連線時自行輸入",
    "- L2TP PSK 會明文寫在 ProfileXML（OS 設備端會加密儲存）",
    "- 同名 profileName 重複派發會覆蓋",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: vpnBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const removeVpnBody = z
  .object({
    profileName: z.string().min(1).max(64).openapi({
      description: "要移除的 VPN profile 名稱",
      example: "School-VPN",
    }),
  })
  .openapi("RemoveVpnInput");

const removeVpnSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/remove-vpn",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "移除設備上的 VPN 設定",
  description: [
    "遠端移除設備上指定 VPN profile。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: removeVpnBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── Camera 禁用 ──

const cameraBody = z
  .object({
    allow: z.boolean().openapi({
      description: "true=允許相機；false=禁用內建相機（考試 / 機密場景）",
      example: false,
    }),
  })
  .openapi("PushCameraPolicyInput");

const pushCameraSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-camera-policy",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送 Camera 禁用 / 啟用政策",
  description: [
    "啟用或禁用設備內建相機。Win10 1607+ 所有版本皆支援。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：策略只控制內建相機，外接 USB 視訊裝置需配 USB 管控政策。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: cameraBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── 防火牆 ──

const firewallBody = z
  .object({
    enabled: z.boolean().default(true).openapi({
      description: "強制啟用三個防火牆 profile（Domain/Private/Public）。預設 true",
    }),
    stealthMode: z.boolean().default(true).openapi({
      description: "啟用隱形模式（拒絕未請求的入站連線）。預設 true",
    }),
    showNotifications: z.boolean().default(false).openapi({
      description: "顯示防火牆阻擋通知。預設 false（避免學生關通知）",
    }),
  })
  .openapi("PushFirewallPolicyInput");

const pushFirewallSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-firewall-policy",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送防火牆政策",
  description: [
    "確保 Windows 防火牆保持啟用,防止學生關閉。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 一次套用到三個 profile (Domain/Private/Public)，學校場景需全覆蓋",
    "- 隱形模式（stealth）建議啟用，降低 portscan / 蠕蟲攻擊面",
    "- 此 API 不管理具體 inbound/outbound 規則（如需精細化規則,走 profile）",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: firewallBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── 自動設備命名 ──

const renameBody = z
  .object({
    explicitName: z.string().min(1).max(15).optional().openapi({
      description:
        "**【選填】** 直接指定名稱（與 template 二選一）。Windows ComputerName 上限 15 字元，不可含空白 / 保留符號",
      example: "TPE001-1234",
    }),
    template: z.string().optional().openapi({
      description:
        "**【選填】** 命名模板（與 explicitName 二選一）。" +
        "支援變數：{schoolCode}=device_group.code、{serial}=完整序號、{serial4}=序號後 4 碼、{udid8}=UDID 前 8 碼",
      example: "{schoolCode}-{serial4}",
    }),
  })
  .refine((d) => d.explicitName || d.template, {
    message: "必須提供 explicitName 或 template 其中之一",
  })
  .openapi("RenameDeviceInput");

const renameResultSchema = z
  .object({
    commandIds: z.array(z.string().uuid()),
    appliedName: z.string().openapi({
      description: "實際派發的設備名稱（模板替換後的結果）",
      example: "TPE001-1234",
    }),
  })
  .openapi("RenameDeviceResult");

const renameDeviceSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/rename",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "自動設備命名（依範本生成 ComputerName）",
  description: [
    "派發 ComputerName 變更指令到設備（PRD §5.1 自動設備命名）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- Windows ComputerName 規範：最多 15 字元、不含空白與保留符號",
    "- 設備需重啟後新名稱才生效",
    "- 模板變數於後端替換後再呼叫 CSP，回傳實際派發的 appliedName",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: renameBody } } },
  },
  responses: {
    202: {
      description: "命令已排入，回傳實際使用名稱",
      content: { "application/json": { schema: successSchema(renameResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── 設備功能限制（Settings 頁面可見性）──

const settingsPageBody = z
  .object({
    mode: z.enum(["hide", "showonly"]).openapi({
      description:
        "hide=隱藏 pages 列出的頁面；showonly=只顯示 pages 列出的頁面（其他全隱藏）",
    }),
    pages: z.array(z.string()).min(1).openapi({
      description:
        "ms-settings 識別符列表（不含 ms-settings: 前綴）。" +
        "常用：recovery / windowsupdate / printers / network-wifi / accounts / personalization",
      example: ["recovery", "windowsupdate"],
    }),
  })
  .openapi("PushSettingsRestrictionInput");

const pushSettingsRestrictionSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-settings-restriction",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送設定 App 頁面可見性限制",
  description: [
    "透過 Policy CSP `Settings/PageVisibilityList` 限制學生可進入的「設定」頁面（PRD §5.2 設備功能限制）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 同一設備 PageVisibilityList **只能設一條**，後送的覆蓋前送的",
    "- 這是 UI 層隱藏，不是系統層禁用；搭配標準帳戶 + LAPS 才完整",
    "- showonly 模式請務必保留必要頁面（如 network-wifi），否則學生無法連網",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: settingsPageBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── Lost Mode ──

const pushLostModeBody = z
  .object({
    message: z.string().min(1).max(255).openapi({
      description: "鎖屏顯示找回訊息（例如「請聯絡光復國小資訊組 02-1234-5678」）",
      example: "請聯絡光復國小資訊組",
    }),
    phone: z.string().min(1).max(64).openapi({
      description: "鎖屏顯示聯絡電話",
      example: "02-1234-5678",
    }),
    footnote: z.string().max(255).optional().openapi({
      description: "**【選填】** 鎖屏顯示輔助訊息（例如「拾獲者可獲報酬」）",
      example: "拾獲者請聯絡校方",
    }),
  })
  .openapi("PushLostModeInput");

const pushLostModeSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-lost-mode",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "啟用設備 Lost Mode（遺失模式）",
  description: [
    "啟用 Windows 設備 Lost Mode：推送 ADMX Policy CSP → Agent 切換 GPS 採集頻率",
    "（平時 24h → Lost Mode 30s），同時 Registry 落找回訊息供鎖屏顯示。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- iOS 設備 Lost Mode 走 Apple MDM 命令（既有獨立流程），不經此端點",
    "- 反復啟用是 idempotent（ADMX Replace），會覆蓋之前的訊息",
    "- 設備未在線時命令會在佇列裡等待，下次 checkin 拉取",
    "",
    "**事件**：成功觸發 webhook `device.lost_mode_enabled`（待 phase 3 接 webhook）。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: pushLostModeBody } } },
  },
  responses: {
    202: {
      description: "命令已排入；mdm_devices.lostModeEnabled 已更新為 true",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const removeLostModeSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/remove-lost-mode",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "關閉設備 Lost Mode",
  description: [
    "關閉 Windows 設備 Lost Mode：推送 disable state → Agent 切回平時 24h GPS 頻率，",
    "清空鎖屏找回訊息。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：iOS 設備走 Apple MDM 獨立流程，不經此端點。",
  ].join("\n"),
  request: { params: deviceIdParam },
  responses: {
    202: {
      description: "命令已排入；mdm_devices.lostModeEnabled 已更新為 false",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── Defender（PRD §4.1.2）──

const defenderCustomSchema = z
  .object({
    realtimeMonitoring: z.boolean().optional(),
    behaviorMonitoring: z.boolean().optional(),
    cloudProtection: z.boolean().optional(),
    ioavProtection: z.boolean().optional(),
    networkProtection: z
      .union([z.literal(0), z.literal(1), z.literal(2)])
      .optional()
      .openapi({ description: "0=disabled / 1=block / 2=audit" }),
    puaProtection: z
      .union([z.literal(0), z.literal(1), z.literal(2)])
      .optional()
      .openapi({ description: "0=disabled / 1=block / 2=audit" }),
    submitSamplesConsent: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .openapi({ description: "0=Always prompt / 1=Send safe / 2=Never / 3=Send all" }),
  })
  .openapi("DefenderEnforceCustom");

const pushDefenderBody = z
  .object({
    all: z.boolean().optional().openapi({
      description:
        "**【選填】** true 套用全開預設（Realtime / Behavior / Cloud / IOAV / Network=block / PUA=block / SubmitSamples=safe）",
    }),
    custom: defenderCustomSchema.optional().openapi({
      description:
        "**【選填】** 細項覆蓋；與 all 同時提供時 custom 覆蓋對應欄位。all 與 custom 兩者需至少提供其一",
    }),
  })
  .openapi("PushDefenderInput");

const pushDefenderSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-defender",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送 Windows Defender 強制啟用政策（PRD §4.1.2）",
  description: [
    "透過 Policy CSP 強制啟用 Defender 主要防護，防止學生關閉。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 若裝置已啟用 Tamper Protection，Defender 會擋掉部分 policy 變更；先確認 Tamper 狀態",
    "- 建議搭配 `/query-defender-health` 定期拉狀態確認",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: pushDefenderBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const defenderHealthNodeEnum = z.enum([
  "ProductStatus",
  "RealTimeProtectionEnabled",
  "BehaviorMonitorEnabled",
  "IoavProtectionEnabled",
  "NisEnabled",
  "RebootRequired",
  "FullScanRequired",
  "EngineVersion",
  "SignatureVersion",
  "AntiMalwareVersion",
  "QuickScanTime",
  "FullScanTime",
  "QuickScanSigVersion",
  "FullScanSigVersion",
  "TamperProtectionEnabled",
  "DefenderEnabled",
]);

const queryDefenderHealthBody = z
  .object({
    nodes: z.array(defenderHealthNodeEnum).optional().openapi({
      description:
        "**【選填】** 指定要查詢的 Health 節點；不填走預設套餐（ProductStatus / RealTime / Behavior / Tamper / SignatureVersion / EngineVersion / ScanTime / RebootRequired）",
    }),
  })
  .openapi("QueryDefenderHealthInput");

const queryDefenderHealthSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/query-defender-health",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "查詢設備 Defender 健康狀態（PRD §4.1.2）",
  description: [
    "發送 Get 命令到裝置的 Defender Health 節點；裝置回覆會寫回 mdm_commands.responsePayload，",
    "admin 前端輪詢該欄位或訂閱 `command.completed` webhook 取用。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: queryDefenderHealthBody } } },
  },
  responses: {
    202: {
      description: "命令已排入（多個 Get，一節點一 commandId）",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── 網站黑名單（PRD §4.1.1）──

const zonedSiteSchema = z.object({
  host: z.string().min(1).openapi({
    description: "host 或 URL pattern（如 `tiktok.com` 或 `https://*.tiktok.com`）",
    example: "tiktok.com",
  }),
  zone: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).openapi({
    description: "1=Intranet / 2=Trusted / 3=Internet / 4=Restricted（封鎖）",
  }),
});

const pushBlockedSitesBody = z
  .object({
    hosts: z.array(z.string().min(1)).optional().openapi({
      description:
        "**【選填】** 完整封鎖 host 清單（自動派到 Zone 4）。與 sites 二選一",
      example: ["tiktok.com", "*.facebook.com"],
    }),
    sites: z.array(zonedSiteSchema).optional().openapi({
      description:
        "**【選填】** 進階：可指定每個 host 對應 Zone。與 hosts 二選一",
    }),
    scope: z.enum(["device", "user"]).optional().openapi({
      description: "device（預設）= 全機生效；user = 僅當前使用者",
    }),
  })
  .refine((d) => (!!d.hosts && d.hosts.length > 0) || (!!d.sites && d.sites.length > 0), {
    message: "必須提供 hosts 或 sites 其中之一，且不可為空陣列",
  })
  .openapi("PushBlockedSitesInput");

const pushBlockedSitesSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-blocked-sites",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送網站黑名單（PRD §4.1.1）",
  description: [
    "透過 IE Security Zones 將 host 派到 Restricted Sites（Zone 4）。Edge Chromium 尊重此機制，",
    "故對 Edge / IE 兩者皆生效。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 支援萬用字元（如 `*.tiktok.com`）",
    "- 單一 Replace 承載整份清單，**重推 = 覆蓋**，不是 append",
    "- host 中不可含 U+F000（分隔字元），有含會 400 rejected",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: pushBlockedSitesBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const clearBlockedSitesBody = z
  .object({
    scope: z.enum(["device", "user"]).optional().openapi({
      description: "device（預設）= 全機；user = 僅當前使用者",
    }),
  })
  .openapi("ClearBlockedSitesInput");

const clearBlockedSitesSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/clear-blocked-sites",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "清除設備上網站黑名單（PRD §4.1.1）",
  description: [
    "送 `<disabled/>` 使 IE Site Zone Assignment 政策不啟用，回退本機原 Zone Map。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: clearBlockedSitesBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── OS 更新管理（PRD §5.6）──

const updatePolicyBody = z
  .object({
    autoUpdate: z
      .union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
      ])
      .optional()
      .openapi({
        description:
          "**【選填】** 0=Notify / 1=Auto install at maintenance / 2=Auto install+notify restart / 3=Auto install+restart at scheduled / 4=Force restart（強制） / 5=關閉自動更新（不建議）",
      }),
    scheduledDay: z
      .union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
        z.literal(7),
      ])
      .optional()
      .openapi({
        description: "**【選填】** ScheduledInstallDay：0=每日 / 1=週日 / ... / 7=週六（autoUpdate=3/4 才生效）",
      }),
    scheduledHour: z.number().int().min(0).max(23).optional().openapi({
      description: "**【選填】** ScheduledInstallTime，24h 制小時",
    }),
    activeHoursStart: z.number().int().min(0).max(23).optional().openapi({
      description: "**【選填】** 使用者時段起，避開此時段自動安裝",
    }),
    activeHoursEnd: z.number().int().min(0).max(23).optional().openapi({
      description: "**【選填】** 使用者時段迄",
    }),
    activeHoursMaxRange: z.number().int().min(8).max(18).optional().openapi({
      description: "**【選填】** 使用者可調 Active Hours 最大範圍（8-18 小時）",
    }),
    deferQualityDays: z.number().int().min(0).max(30).optional().openapi({
      description: "**【選填】** Quality update 延後天數（0-30）",
    }),
    deferFeatureDays: z.number().int().min(0).max(365).optional().openapi({
      description: "**【選填】** Feature update 延後天數（0-365）",
    }),
    pauseQuality: z.boolean().optional().openapi({
      description: "**【選填】** 暫停 Quality updates（最多 35 天）",
    }),
    pauseFeature: z.boolean().optional().openapi({
      description: "**【選填】** 暫停 Feature updates（最多 35 天）",
    }),
  })
  .openapi("PushUpdatePolicyInput");

const pushUpdatePolicySpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-update-policy",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送 Windows Update 排程 / 延後 / 暫停政策（PRD §5.6）",
  description: [
    "透過 Policy CSP / Update namespace 設定裝置的 WU 行為。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- 只設有提供的欄位；未提供的欄位保留裝置現值",
    "- 「立即觸發 OS 更新」用 `/trigger-os-update` 便捷端點（Windows 沒有原生立即觸發 CSP，走強制 policy + 短排程）",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: updatePolicyBody } } },
  },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const triggerOsUpdateBody = z
  .object({
    delayHours: z.number().int().min(0).max(6).optional().openapi({
      description:
        "**【選填】** 排程小時偏移，預設 0（當前小時）；1-6 = 延後 N 小時（用於避開午休 / 上課時段）",
    }),
  })
  .openapi("TriggerOsUpdateInput");

const triggerOsUpdateResultSchema = z
  .object({
    commandIds: z.array(z.string().uuid()),
    scheduledHour: z.number().int().min(0).max(23).openapi({
      description: "實際排定的小時（24h 制）",
    }),
  })
  .openapi("TriggerOsUpdateResult");

const triggerOsUpdateSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/trigger-os-update",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "立即觸發 Windows OS 更新（PRD §5.6）",
  description: [
    "組合強制自動更新 policy 派下去，裝置在下個 WU poll cycle（幾分鐘至半小時）依 policy 執行。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- Windows Update 沒有原生「立即觸發」MDM 命令；此端點=`AllowAutoUpdate=4` + `ScheduledInstallDay=0` + 當前小時的組合",
    "- 「強制無用戶控制」使用者不能取消；重啟會被排入 WU 排程",
    "- 進度 / 完成透過 `/query-update-status` 拉取（或訂閱 command.completed）",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: triggerOsUpdateBody } } },
  },
  responses: {
    202: {
      description: "命令已排入，回傳實際 scheduledHour",
      content: {
        "application/json": { schema: successSchema(triggerOsUpdateResultSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

const queryUpdateStatusBody = z
  .object({
    include: z
      .array(z.enum(["installable", "installed", "pendingReboot"]))
      .min(1)
      .openapi({
        description:
          "要查詢的更新清單：installable=可安裝但未批准 / installed=已安裝 / pendingReboot=已裝待重啟",
        example: ["installable", "pendingReboot"],
      }),
  })
  .openapi("QueryUpdateStatusInput");

const queryUpdateStatusSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/query-update-status",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "查詢設備 Windows Update 狀態（PRD §5.6）",
  description: [
    "發送 Get 命令到 Update CSP；裝置回覆會寫回 mdm_commands.responsePayload。",
    "",
    "**鑑權**：Bearer admin token。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: queryUpdateStatusBody } } },
  },
  responses: {
    202: {
      description: "命令已排入（每個 include 值對應一個 Get）",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── Edge BrowserSignin（PRD §4.1.1 生產配套：URLBlocklist 免疫子問題防護）──

const pushBrowserSigninBody = z
  .object({
    mode: z.union([z.literal(0), z.literal(1), z.literal(2)]).openapi({
      description:
        "0=禁止 Edge 登入任何帳號（教育場景推薦）/ 1=允許（Edge 預設）/ 2=強制登入",
      example: 0,
    }),
  })
  .openapi("PushEdgeBrowserSigninInput");

const pushBrowserSigninSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-edge-browser-signin",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送 Edge BrowserSignin policy",
  description: [
    "設定 Edge 是否允許帳號登入。**URLBlocklist 生產配套**：MS 個人帳號登入的 Edge profile 對 URLBlocklist 免疫（by design），",
    "教育場景推 mode=0 從源頭防繞過。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意事項**：",
    "- mode=0 後既存已登入的 profile 會被強制登出",
    "- policy 生效需要 Edge 重啟（跟 URLBlocklist 同一 policy engine cache 機制）",
    "- 跟 push-blocked-sites 分離的端點：允許 admin 單獨切換 signin 而不動 URL 黑名單",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: pushBrowserSigninBody } } },
  },
  responses: {
    202: {
      description: "命令已排入（ADMX install + Policy Set 2 條）",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const clearBrowserSigninSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/clear-edge-browser-signin",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "清除 Edge BrowserSignin policy（回退 Edge 預設允許登入）",
  description: "**鑑權**：Bearer admin token。",
  request: { params: deviceIdParam },
  responses: {
    202: {
      description: "命令已排入",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── DeviceInstallation 設備類黑名單（PRD §5.4 進階 USB 管控）──

const guidPattern = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;

const deviceInstallBody = z
  .object({
    blockedClasses: z.array(z.string().regex(guidPattern)).optional().openapi({
      description:
        "**【選填】** Setup Class GUID 黑名單。含 `{}` 或不含皆可（自動包上）。常用：\n" +
        "- `{36fc9e60-c465-11cf-8056-444553540000}` USB 存儲類\n" +
        "- `{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}` Bluetooth\n" +
        "- `{6bdd1fc6-810f-11d0-bec7-08002be2092f}` Image Class（相機 / 掃描器）",
      example: ["{36fc9e60-c465-11cf-8056-444553540000}"],
    }),
    blockedHardwareIds: z.array(z.string().min(1)).optional().openapi({
      description:
        "**【選填】** Hardware ID 黑名單（PnP hardware id）。例：`USB\\Composite`、`USB\\Class_FF`",
      example: ["USB\\Composite"],
    }),
    blockRemovableDevices: z.boolean().optional().openapi({
      description:
        "**【選填】** 一刀切禁**所有** removable device（U 盤 / 外接硬碟 / SD 卡等）",
    }),
    applyRetroactive: z.boolean().optional().openapi({
      description:
        "**【選填】** 是否對已安裝的匹配設備也套用（強制卸載）；預設 false 只擋新插入",
    }),
  })
  .refine(
    (d) =>
      (d.blockedClasses?.length ?? 0) > 0 ||
      (d.blockedHardwareIds?.length ?? 0) > 0 ||
      d.blockRemovableDevices === true,
    { message: "必須至少提供 blockedClasses / blockedHardwareIds / blockRemovableDevices 其中之一" },
  )
  .openapi("PushDeviceInstallPolicyInput");

const pushDeviceInstallSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/push-device-install-policy",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "推送 DeviceInstallation 黑名單（PRD §5.4 進階 USB 管控）",
  description: [
    "比 `/push-usb-policy`（Storage CSP）更徹底：按 Setup Class GUID / Hardware ID / removable-flag 全類別禁用。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**與 push-usb-policy 差異**：",
    "- Storage CSP 只擋 USB **儲存**類的讀寫（Files Explorer 看不到但驅動仍載入）",
    "- 此端點擋設備**安裝**（驅動層拒載），可覆蓋 USB 相機 / 藍牙 / 讀卡機等非儲存類",
    "",
    "**注意事項**：",
    "- `applyRetroactive=true` 會強制卸載已裝驅動，可能中斷正在用的外設",
    "- Windows Pro 22H2+ 完整支援；Home 不支援 GPO/CSP",
    "- 政策生效需**重新插拔設備**或重啟",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: deviceInstallBody } } },
  },
  responses: {
    202: {
      description: "命令已排入（每種類型一條，1-3 條）",
      content: { "application/json": { schema: successSchema(commandResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

const clearDeviceInstallSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/clear-device-install-policy",
  tags: ["設備策略"],
  security: [{ BearerAuth: [] }],
  summary: "清除 DeviceInstallation 黑名單（PRD §5.4）",
  description: "**鑑權**：Bearer admin token。同時清除 Classes / IDs / RemovableDevices 三種 policy。",
  request: { params: deviceIdParam },
  responses: {
    202: {
      description: "命令已排入（3 條 <disabled/>）",
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

// VPN
devicePoliciesAdminApp.openapi(pushVpnSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushVpnToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_vpn",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      profileName: body.profileName,
      protocol: body.protocol,
      serverHost: body.serverHost,
      hasPsk: !!body.l2tpPsk,
    },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

devicePoliciesAdminApp.openapi(removeVpnSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { profileName } = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await removeVpnFromDevice(device, profileName);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.remove_vpn",
    resourceType: "device",
    resourceId: deviceId,
    payload: { profileName },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// Camera
devicePoliciesAdminApp.openapi(pushCameraSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { allow } = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushCameraPolicyToDevice(device, allow);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_camera_policy",
    resourceType: "device",
    resourceId: deviceId,
    payload: { allow },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// 防火牆
devicePoliciesAdminApp.openapi(pushFirewallSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushFirewallPolicyToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_firewall_policy",
    resourceType: "device",
    resourceId: deviceId,
    payload: body,
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// 自動命名
devicePoliciesAdminApp.openapi(renameDeviceSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });

  // 模板需查 device.serialNumber + device_group.code；explicitName 不查
  let ctx = { schoolCode: null as string | null, serialNumber: null as string | null, udid: device.udid };
  if (body.template) {
    const detail = await db.query.mdmDevices.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.id, deviceId),
      columns: { serialNumber: true, deviceGroupId: true },
      with: { deviceGroup: { columns: { code: true } } },
    });
    ctx = {
      schoolCode: detail?.deviceGroup?.code ?? null,
      serialNumber: detail?.serialNumber ?? null,
      udid: device.udid,
    };
  }

  const { commandIds, appliedName } = await pushDeviceRenameToDevice(device, body, ctx);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.rename",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      mode: body.explicitName ? "explicit" : "template",
      template: body.template ?? null,
      appliedName,
    },
  });
  return c.json({ ok: true as const, data: { commandIds, appliedName } }, 202);
});

// 設備功能限制
devicePoliciesAdminApp.openapi(pushSettingsRestrictionSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushSettingsRestrictionToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_settings_restriction",
    resourceType: "device",
    resourceId: deviceId,
    payload: { mode: body.mode, pageCount: body.pages.length, pages: body.pages },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// Lost Mode
devicePoliciesAdminApp.openapi(pushLostModeSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const lostModeId = crypto.randomUUID();
  const commandIds = await pushLostModeToDevice(device, { ...body, lostModeId });

  // 同步寫 mdm_devices.lostMode* — Apple/Windows 共用同一組欄位
  await db.update(mdmDevices)
    .set({
      lostModeEnabled: true,
      lostModeMessage: body.message,
      lostModePhone: body.phone,
      lostModeFootnote: body.footnote ?? null,
      lostModeEnabledAt: new Date(),
    })
    .where(and(eq(mdmDevices.id, deviceId), eq(mdmDevices.tenantId, tenantId)));

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_lost_mode",
    resourceType: "device",
    resourceId: deviceId,
    payload: { lostModeId, phone: body.phone, footnoteLen: body.footnote?.length ?? 0 },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

devicePoliciesAdminApp.openapi(removeLostModeSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await removeLostModeFromDevice(device);

  await db.update(mdmDevices)
    .set({
      lostModeEnabled: false,
      lostModeEnabledAt: null,
    })
    .where(and(eq(mdmDevices.id, deviceId), eq(mdmDevices.tenantId, tenantId)));

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.remove_lost_mode",
    resourceType: "device",
    resourceId: deviceId,
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// Defender push
devicePoliciesAdminApp.openapi(pushDefenderSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushDefenderPolicyToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_defender",
    resourceType: "device",
    resourceId: deviceId,
    payload: { all: body.all ?? false, custom: body.custom ?? null },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// Defender health query
devicePoliciesAdminApp.openapi(queryDefenderHealthSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await queryDefenderHealthOnDevice(device, body.nodes);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.query_defender_health",
    resourceType: "device",
    resourceId: deviceId,
    payload: { nodeCount: body.nodes?.length ?? "default" },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// 網站黑名單 push
devicePoliciesAdminApp.openapi(pushBlockedSitesSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushBlockedSitesToDevice(
    device,
    body.sites
      ? { sites: body.sites, scope: body.scope }
      : { hosts: body.hosts!, scope: body.scope },
  );
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_blocked_sites",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      mode: body.sites ? "sites" : "hosts",
      count: body.sites?.length ?? body.hosts?.length ?? 0,
      scope: body.scope ?? "device",
    },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// 網站黑名單 clear
devicePoliciesAdminApp.openapi(clearBlockedSitesSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await clearBlockedSitesFromDevice(device, body.scope);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.clear_blocked_sites",
    resourceType: "device",
    resourceId: deviceId,
    payload: { scope: body.scope ?? "device" },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// Update policy push
devicePoliciesAdminApp.openapi(pushUpdatePolicySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushUpdatePolicyToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_update_policy",
    resourceType: "device",
    resourceId: deviceId,
    payload: body,
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// Trigger OS update now
devicePoliciesAdminApp.openapi(triggerOsUpdateSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const { commandIds, scheduledHour } = await triggerOsUpdateNow(
    device,
    body.delayHours,
  );
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.trigger_os_update",
    resourceType: "device",
    resourceId: deviceId,
    payload: { delayHours: body.delayHours ?? 0, scheduledHour },
  });
  return c.json({ ok: true as const, data: { commandIds, scheduledHour } }, 202);
});

// Edge BrowserSignin push
devicePoliciesAdminApp.openapi(pushBrowserSigninSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { mode } = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushEdgeBrowserSigninToDevice(device, mode);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_edge_browser_signin",
    resourceType: "device",
    resourceId: deviceId,
    payload: { mode },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// DeviceInstallation push
devicePoliciesAdminApp.openapi(pushDeviceInstallSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await pushDeviceInstallPolicyToDevice(device, body);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.push_device_install_policy",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      classesCount: body.blockedClasses?.length ?? 0,
      hardwareIdsCount: body.blockedHardwareIds?.length ?? 0,
      removable: body.blockRemovableDevices ?? false,
      retroactive: body.applyRetroactive ?? false,
    },
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// DeviceInstallation clear
devicePoliciesAdminApp.openapi(clearDeviceInstallSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await clearDeviceInstallPolicyFromDevice(device);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.clear_device_install_policy",
    resourceType: "device",
    resourceId: deviceId,
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// Edge BrowserSignin clear
devicePoliciesAdminApp.openapi(clearBrowserSigninSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await clearEdgeBrowserSigninFromDevice(device);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.clear_edge_browser_signin",
    resourceType: "device",
    resourceId: deviceId,
  });
  return c.json({ ok: true as const, data: { commandIds } }, 202);
});

// Update status query
devicePoliciesAdminApp.openapi(queryUpdateStatusSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const device = await getWindowsDeviceForPolicy({ tenantId, deviceId });
  const commandIds = await queryUpdateStatusOnDevice(device, body.include);
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "device.query_update_status",
    resourceType: "device",
    resourceId: deviceId,
    payload: { include: body.include },
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
