import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import {
  getLatestAgentReport,
  listAgentReports,
  listUsageStats,
  resolveAgentDevice,
  saveAgentReport,
  upsertUsageStats,
} from "~/services/agent.ts";
import {
  type AgentReportHooks,
  directAgentReportHooks,
} from "~/services/agent-report-hooks.ts";
import {
  authorizeAgentReport,
  extractBearerToken,
} from "~/services/agent-auth.ts";
import { verifyUsageSignature } from "~/services/usage-signature.ts";
import { publishEvent } from "~/services/webhooks/index.ts";

/**
 * /api/v1/tenants/{tenantId}/agent/*
 *
 * Agent App 端只認識自家 serialNumber（與可選 udid），不知道內部 UUID。
 * - POST /report:  body 帶 serialNumber，路由內 resolve / upsert 出 mdm_devices.id
 * - GET  /reports/{serial}, /latest/{serial}, /usage/{serial}: 以 tenant scope 的 serialNumber 查
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

const tenantSerialParam = tenantParam.extend({
  serialNumber: z.string().min(1).openapi({
    param: { name: "serialNumber", in: "path" },
    example: "F2L1234567",
  }),
});

const reportBody = z
  .object({
    serialNumber: z.string().min(1).openapi({ example: "F2L1234567" }),
    udid: z.string().optional(),
    batteryLevel: z.number().int().min(0).max(100).optional(),
    storageAvailableMb: z.number().int().nonnegative().optional(),
    storageTotalMb: z.number().int().nonnegative().optional(),
    networkType: z.string().optional(),
    networkSsid: z.string().optional(),
    screenBrightness: z.number().min(0).max(1).optional(),
    osVersion: z.string().optional(),
    appVersion: z.string().optional(),
    extraData: z.record(z.unknown()).optional(),
    reportedAt: z.string().datetime().optional().openapi({
      example: "2026-05-28T10:30:00Z",
      description: "ISO 8601 UTC；省略時取 server 當下時間",
    }),
  })
  .openapi("AgentReportInput");

const checkinBody = z
  .object({
    serialNumber: z.string().min(1).openapi({ example: "F2L1234567" }),
    udid: z.string().optional(),
    osVersion: z.string().optional().openapi({ example: "10.0.19045.4170" }),
    appVersion: z.string().optional().openapi({ example: "1.3.12.0" }),
    lapsRotationId: z.string().optional().openapi({
      description: "Agent 啟動時若已完成上次改密，帶上 rotationId 作確認（等同 report 的 windows.laps.rotation_id）",
    }),
  })
  .openapi("AgentCheckinInput");

const checkinActionSchema = z
  .object({
    type: z.string().openapi({ example: "laps_rotation_pending", description: "待辦動作類型" }),
    priority: z.number().int().openapi({ example: 100, description: "優先級（數字越大越先處理）" }),
    data: z.record(z.unknown()).openapi({ description: "動作參數（不含任何密碼）" }),
  })
  .openapi("AgentCheckinAction");

const checkinResponseSchema = z
  .object({
    deviceId: z.string().uuid(),
    actions: z.array(checkinActionSchema).openapi({
      description: "後端回應的待辦動作列表；Agent 依 type 分別處理",
    }),
  })
  .openapi("AgentCheckinResponse");

const reportItem = z
  .object({
    id: z.string().uuid(),
    batteryLevel: z.number().nullable().openapi({ description: "電池電量百分比（0-100）" }),
    storageAvailableMb: z.number().nullable().openapi({ description: "可用儲存空間（MB）" }),
    storageTotalMb: z.number().nullable().openapi({ description: "總儲存空間（MB）" }),
    networkType: z.string().nullable().openapi({ description: "網路類型（WiFi / Cellular / Ethernet）" }),
    networkSsid: z.string().nullable().openapi({ description: "連線中的 WiFi SSID" }),
    screenBrightness: z.number().nullable().openapi({ description: "螢幕亮度（0.0-1.0）" }),
    osVersion: z.string().nullable().openapi({ description: "作業系統版本", example: "10.0.19045.4170" }),
    appVersion: z.string().nullable().openapi({ description: "Agent App 版本", example: "1.2.0" }),
    extraData: z.unknown().nullable().openapi({ description: "平台特定的額外資料（Windows: defender/firewall/updates 等）" }),
    reportedAt: z.string().openapi({ description: "上報時間（ISO 8601 UTC）" }),
  })
  .openapi("AgentReportItem");

const latestReportItem = reportItem
  .extend({
    deviceId: z.string().uuid(),
    serialNumber: z.string().nullable(),
  })
  .openapi("AgentLatestReport");

const usageStatItem = z
  .object({
    date: z.string().openapi({ description: "日期（YYYY-MM-DD）", example: "2026-06-06" }),
    totalMinutes: z.number().int().nonnegative().openapi({ description: "當日總使用時長（分鐘）" }),
    pickup: z.number().int().nonnegative().openapi({ description: "當日拿起次數" }),
    maxContinuous: z.number().int().nonnegative().openapi({ description: "當日最長連續使用時長（分鐘）" }),
    timeStats: z.record(z.number()).optional().openapi({
      description: "按時段分佈的使用時長（key: 時段標籤，value: 分鐘數）",
    }),
  })
  .openapi("UsageStatItem");

const usageBody = z
  .object({
    serialNumber: z.string().min(1),
    sessionId: z.string().optional(),
    stats: z.array(usageStatItem).min(1),
  })
  .openapi("UsageStatsInput");

const usageRow = z
  .object({
    id: z.string().uuid(),
    date: z.string(),
    totalMinutes: z.number(),
    pickup: z.number(),
    maxContinuous: z.number(),
    timeStats: z.record(z.number()).nullable(),
    reportedAt: z.string(),
  })
  .openapi("UsageStatRow");

const usageQuery = z.object({
  date: z.string().optional().openapi({
    example: "2026-05-28",
    description: "按單日查詢（YYYY-MM-DD）；與 start/end 互斥",
  }),
  startDate: z.string().optional().openapi({
    example: "2026-05-21",
    description: "範圍查詢起始日（YYYY-MM-DD）",
  }),
  endDate: z.string().optional().openapi({
    example: "2026-05-28",
    description: "範圍查詢結束日（YYYY-MM-DD）",
  }),
  limit: z.coerce.number().int().positive().max(500).optional().openapi({
    example: 100,
    description: "返回條數（最大 500）",
  }),
});

const reportsQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// ── 命名響應 schema（OpenAPI inline 展開消除） ──

const agentReportSavedSchema = z
  .object({
    reportId: z.string().uuid(),
    deviceId: z.string().uuid(),
  })
  .openapi("AgentReportSaved");

const agentReportsListSchema = z
  .object({
    count: z.number().int().nonnegative(),
    reports: z.array(reportItem),
  })
  .openapi("AgentReportsList");

const usageStatsSavedSchema = z
  .object({
    savedCount: z.number().int().openapi({
      example: 1,
      description: "成功 upsert 的天數（同設備同日合併為 1）",
    }),
  })
  .openapi("UsageStatsSaved");

const usageStatsListSchema = z
  .object({
    count: z.number().int(),
    stats: z.array(usageRow),
  })
  .openapi("UsageStatsList");

// ============================================================
// Routes
// ============================================================

const reportRoute = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/agent/reports",
  tags: ["Agent 上報"],
  summary: "Agent App 上報設備狀態（iOS + Windows 共用）",
  description: [
    "**鑑權**：若 device 已簽發 token（Windows 經 `install-agent`、iOS 經 `agent-token` 端點），",
    "必須帶 `Authorization: Bearer <agent_token>`；未簽發 token 的 device 相容不帶（過渡期）。",
    "",
    "**Windows extraData 建議結構**：",
    "```json",
    '{ "platform": "windows",',
    '  "windows": {',
    '    "winget_version": "1.7.10861",',
    '    "defender_enabled": true,',
    '    "firewall_enabled": true,',
    '    "pending_updates": 3,',
    '    "is_local_admin": false }',
    "}",
    "```",
    "",
    "iOS 端維持既有欄位即可，無 `extraData.windows` 子物件。",
    "",
    "**事件**：成功後觸發 webhook `agent.reported`。",
  ].join("\n"),
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: reportBody } } },
  },
  responses: {
    201: {
      description: "Report saved",
      content: {
        "application/json": {
          schema: successSchema(agentReportSavedSchema),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const checkinRoute = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/agent/checkin",
  tags: ["Agent 上報"],
  summary: "Agent 啟動 checkin（取得待辦動作列表）",
  description: [
    "Agent App **啟動時**呼叫一次（區別於每日定時 `report`）。後端據此讓「上線即執行」的待辦",
    "立即觸發 —— 目前是 LAPS 密碼輪換：不必等每日 report 週期，Agent 一上線就觸發 / 確認輪換。",
    "",
    "**鑑權**：同 `/agent/reports`，若 device 已簽發 token 則必須帶 `Authorization: Bearer <agent_token>`。",
    "",
    "**LAPS 確認**：若 Agent 啟動時已完成上次改密，帶 `lapsRotationId` 作確認。",
    "",
    "**回應 actions**：待辦動作列表。`laps_rotation_pending` 僅**告知**有進行中的輪換，",
    "**不攜帶密碼**（密碼經 MDM CSP 通道下發到 registry，由 Agent LapsWatcher 取用）。",
    "",
    "**事件**：成功後觸發 webhook `agent.checkin`。",
  ].join("\n"),
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: checkinBody } } },
  },
  responses: {
    200: {
      description: "Checkin accepted，回傳待辦動作列表",
      content: {
        "application/json": {
          schema: successSchema(checkinResponseSchema),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const listReportsRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/agent/devices/{serialNumber}/reports",
  tags: ["Agent 上報"],
  summary: "查詢設備上報歷史",
  description: "回傳指定設備的上報記錄（分頁，按 reportedAt 降序）。\n\n**鑑權**：無。",
  request: { params: tenantSerialParam, query: reportsQuery },
  responses: {
    200: {
      description: "上報記錄列表",
      content: {
        "application/json": {
          schema: successSchema(agentReportsListSchema),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const latestReportRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/agent/devices/{serialNumber}/reports/latest",
  tags: ["Agent 上報"],
  summary: "取得設備最新一筆上報",
  description: "回傳設備最近一次上報的完整資料（含 deviceId + serialNumber）。\n\n**鑑權**：無。",
  request: { params: tenantSerialParam },
  responses: {
    200: {
      description: "最新上報物件",
      content: { "application/json": { schema: successSchema(latestReportItem) } },
    },
    ...commonErrorResponses,
  },
});

const usageReportRoute = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/agent/usage",
  tags: ["Agent 上報"],
  summary: "上報設備使用時長（同設備同日 upsert）",
  description: [
    "**鑑權**：同 `/agent/reports`，若 device 已簽發 token 則必須帶 Bearer。",
    "",
    "**錯峰策略**：建議 Windows Agent 在凌晨 0:00-5:00 之間用 `hash(udid) % 300`",
    "落到固定分鐘上報，避免 8000 台同時打。",
    "",
    "**事件**：成功後觸發 webhook `agent.usage_reported`。",
  ].join("\n"),
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: usageBody } } },
  },
  responses: {
    200: {
      description: "Stats upserted",
      content: {
        "application/json": {
          schema: successSchema(usageStatsSavedSchema),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const listUsageRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/agent/devices/{serialNumber}/usage",
  tags: ["Agent 上報"],
  summary: "查詢設備使用時長統計",
  description: [
    "回傳設備的每日使用統計。支援單日查詢（`date`）或範圍查詢（`startDate`/`endDate`）。",
    "",
    "**鑑權**：無。",
  ].join("\n"),
  request: { params: tenantSerialParam, query: usageQuery },
  responses: {
    200: {
      description: "使用統計列表",
      content: {
        "application/json": {
          schema: successSchema(usageStatsListSchema),
        },
      },
    },
    ...commonErrorResponses,
  },
});

// ============================================================
// App + handlers
// ============================================================

export const agentApp = new OpenAPIHono({ defaultHook: validationFailedHook });

/**
 * 上報副作用接縫：預設直連（LAPS / BitLocker）。拆為獨立部署且無共用 DB 時，
 * entry point 可 setAgentReportHooks 注入事件版實現，route 零改動。
 */
let reportHooks: AgentReportHooks = directAgentReportHooks;
export function setAgentReportHooks(hooks: AgentReportHooks): void {
  reportHooks = hooks;
}

async function resolveDeviceBySerial(opts: {
  tenantId: string;
  serialNumber: string;
}): Promise<string> {
  const { db } = await import("~/db/client.ts");
  const row = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.tenantId, opts.tenantId), eqOp(t.serialNumber, opts.serialNumber)),
    columns: { id: true },
  });
  if (!row) {
    throw new AppError(404, "device_not_found", "Device not found in this tenant");
  }
  return row.id;
}

agentApp.openapi(reportRoute, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const token = extractBearerToken(c.req.header("authorization"));

  const device = await resolveAgentDevice({
    tenantId,
    serialNumber: body.serialNumber,
    udid: body.udid ?? null,
    token,
  });

  await authorizeAgentReport({ device, token });

  const saved = await saveAgentReport({
    tenantId,
    deviceId: device.id,
    serialNumber: body.serialNumber,
    batteryLevel: body.batteryLevel,
    storageAvailableMb: body.storageAvailableMb,
    storageTotalMb: body.storageTotalMb,
    networkType: body.networkType,
    networkSsid: body.networkSsid,
    screenBrightness: body.screenBrightness,
    osVersion: body.osVersion,
    appVersion: body.appVersion,
    extraData: body.extraData,
    reportedAt: body.reportedAt,
  });

  // 非阻塞上報副作用（Windows LAPS + BitLocker），經接縫注入；
  // 平台判斷收斂到 hook 實現內，route 保持平台無關
  void reportHooks
    .onReport({
      tenantId,
      deviceId: device.id,
      extraData: (body.extraData ?? {}) as Record<string, unknown>,
    })
    .catch((err) => {
      console.error("[agent.report] side-effect hook failed", err);
    });

  // 非阻塞觸發 webhook：失敗不影響 Agent 上報成功，但會在 webhook_deliveries
  // 留 pending row 由 scheduler 重試
  void publishEvent({
    tenantId,
    eventType: "agent.reported",
    data: {
      device_id: device.id,
      report_id: saved.id,
      serial_number: body.serialNumber,
      os_version: body.osVersion ?? null,
      app_version: body.appVersion ?? null,
      battery_level: body.batteryLevel ?? null,
      storage_available_mb: body.storageAvailableMb ?? null,
      reported_at: body.reportedAt ?? new Date().toISOString(),
    },
  }).catch((err) => {
    console.error("[agent.reported] publishEvent failed", err);
  });

  return c.json(
    { ok: true as const, data: { reportId: saved.id, deviceId: device.id } },
    201,
  );
});

agentApp.openapi(checkinRoute, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const token = extractBearerToken(c.req.header("authorization"));

  const device = await resolveAgentDevice({
    tenantId,
    serialNumber: body.serialNumber,
    udid: body.udid ?? null,
    token,
  });

  await authorizeAgentReport({ device, token });

  // 上線即觸發 / 確認 LAPS 輪換（不等每日 report 週期），回傳待辦動作。
  // 內部容錯：觸發失敗不影響 checkin 上線信號成立。
  const actions = await reportHooks.onCheckin({
    tenantId,
    deviceId: device.id,
    lapsRotationId: body.lapsRotationId,
  });

  void publishEvent({
    tenantId,
    eventType: "agent.checkin",
    data: {
      device_id: device.id,
      serial_number: body.serialNumber,
      os_version: body.osVersion ?? null,
      app_version: body.appVersion ?? null,
      action_count: actions.length,
      checked_in_at: new Date().toISOString(),
    },
  }).catch((err) => {
    console.error("[agent.checkin] publishEvent failed", err);
  });

  return c.json(
    { ok: true as const, data: { deviceId: device.id, actions } },
    200,
  );
});

agentApp.openapi(listReportsRoute, async (c) => {
  const { tenantId, serialNumber } = c.req.valid("param");
  const { limit, offset } = c.req.valid("query");

  const deviceId = await resolveDeviceBySerial({ tenantId, serialNumber });
  const rows = await listAgentReports({ tenantId, deviceId, limit, offset });

  return c.json(
    {
      ok: true as const,
      data: {
        count: rows.length,
        reports: rows.map((r) => ({
          id: r.id,
          batteryLevel: r.batteryLevel,
          storageAvailableMb: r.storageAvailableMb,
          storageTotalMb: r.storageTotalMb,
          networkType: r.networkType,
          networkSsid: r.networkSsid,
          screenBrightness: r.screenBrightness,
          osVersion: r.osVersion,
          appVersion: r.appVersion,
          extraData: r.extraData,
          reportedAt: r.reportedAt.toISOString(),
        })),
      },
    },
    200,
  );
});

agentApp.openapi(latestReportRoute, async (c) => {
  const { tenantId, serialNumber } = c.req.valid("param");
  const deviceId = await resolveDeviceBySerial({ tenantId, serialNumber });
  const r = await getLatestAgentReport({ tenantId, deviceId });
  if (!r) {
    throw new AppError(404, "report_not_found", "No reports for this device yet");
  }
  return c.json(
    {
      ok: true as const,
      data: {
        id: r.id,
        deviceId: r.deviceId,
        serialNumber: r.serialNumber,
        batteryLevel: r.batteryLevel,
        storageAvailableMb: r.storageAvailableMb,
        storageTotalMb: r.storageTotalMb,
        networkType: r.networkType,
        networkSsid: r.networkSsid,
        screenBrightness: r.screenBrightness,
        osVersion: r.osVersion,
        appVersion: r.appVersion,
        extraData: r.extraData,
        reportedAt: r.reportedAt.toISOString(),
      },
    },
    200,
  );
});

agentApp.openapi(usageReportRoute, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const token = extractBearerToken(c.req.header("authorization"));

  const device = await resolveAgentDevice({
    tenantId,
    serialNumber: body.serialNumber,
    token,
  });

  await authorizeAgentReport({ device, token });

  // 防篡改第 3 層：驗 HMAC 簽名（密鑰＝agent_token）。無簽名（iOS / 舊版 agent）
  // 跳過驗簽（相容降級）；簽名不符不拒絕，僅告警 —— 與第 2 層單調性互補，且渐进
  // 上线不丢数据。未來可收緊為直接拒絕。
  const signature = c.req.header("x-usage-signature");
  if (signature && token) {
    const valid = await verifyUsageSignature(
      token,
      {
        serialNumber: body.serialNumber,
        sessionId: body.sessionId,
        stats: body.stats,
      },
      signature,
    );
    if (!valid) {
      console.warn(
        `[agent.usage_signature_invalid] device=${device.id} serial=${body.serialNumber}`,
      );
      void publishEvent({
        tenantId,
        eventType: "agent.usage_anomaly",
        data: {
          device_id: device.id,
          serial_number: body.serialNumber,
          reason: "signature_invalid",
        },
      }).catch((err) => {
        console.error("[agent.usage_anomaly] publishEvent failed", err);
      });
    }
  }

  const { ids, anomalies } = await upsertUsageStats({
    tenantId,
    deviceId: device.id,
    sessionId: body.sessionId,
    stats: body.stats,
  });

  // Usage 上報觸發 webhook 給台灣後端做學生使用統計分析
  void publishEvent({
    tenantId,
    eventType: "agent.usage_reported",
    data: {
      device_id: device.id,
      serial_number: body.serialNumber,
      session_id: body.sessionId ?? null,
      stats: body.stats,
      saved_count: ids.length,
    },
  }).catch((err) => {
    console.error("[agent.usage_reported] publishEvent failed", err);
  });

  // 防篡改第 2 層：累計值回退＝疑似本地 db 被改，告警給後端做風控。
  if (anomalies.length > 0) {
    console.warn(
      `[agent.usage_anomaly] device=${device.id} serial=${body.serialNumber} regressions=${anomalies.length}`,
    );
    void publishEvent({
      tenantId,
      eventType: "agent.usage_anomaly",
      data: {
        device_id: device.id,
        serial_number: body.serialNumber,
        anomalies,
      },
    }).catch((err) => {
      console.error("[agent.usage_anomaly] publishEvent failed", err);
    });
  }

  return c.json({ ok: true as const, data: { savedCount: ids.length } }, 200);
});

agentApp.openapi(listUsageRoute, async (c) => {
  const { tenantId, serialNumber } = c.req.valid("param");
  const q = c.req.valid("query");
  const deviceId = await resolveDeviceBySerial({ tenantId, serialNumber });

  const rows = await listUsageStats({
    tenantId,
    deviceId,
    date: q.date,
    startDate: q.startDate,
    endDate: q.endDate,
    limit: q.limit,
  });

  return c.json(
    {
      ok: true as const,
      data: {
        count: rows.length,
        stats: rows.map((r) => ({
          id: r.id,
          date: r.date,
          totalMinutes: r.totalMinutes,
          pickup: r.pickup,
          maxContinuous: r.maxContinuous,
          timeStats: r.timeStats,
          reportedAt: r.reportedAt.toISOString(),
        })),
      },
    },
    200,
  );
});
