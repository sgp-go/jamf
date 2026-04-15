/** /api/devices 路由 - 透過 Jamf API 取得裝置資訊 */

import { Hono } from "@hono/hono";
import { JamfClient, DeviceService } from "../jamf/mod.ts";
import { getLatestReport } from "../db/sqlite.ts";

const devices = new Hono();
let client: JamfClient;
let service: DeviceService;

function getService(): DeviceService {
  if (!service) {
    client = new JamfClient();
    service = new DeviceService(client);
  }
  return service;
}

/** GET /api/devices - 裝置列表 */
devices.get("/", async (c) => {
  const page = Number(c.req.query("page") ?? 0);
  const pageSize = Number(c.req.query("pageSize") ?? 100);

  const svc = getService();
  const list = await svc.listMobileDevices({ page, pageSize });

  return c.json({
    totalCount: list.totalCount,
    devices: list.results.map((d) => ({
      id: d.id,
      name: d.name,
      serialNumber: d.serialNumber,
      managementId: d.managementId,
    })),
  });
});

/** GET /api/devices/:id - 裝置詳情（Jamf 資料 + Agent 最新回報） */
devices.get("/:id", async (c) => {
  const id = c.req.param("id");
  const svc = getService();

  // v2 detail + Classic API lost mode 並行查
  const [detail, lostMode] = await Promise.all([
    svc.getMobileDevice(id),
    svc.getLostModeStatus(id).catch((e) => {
      console.warn(`[Jamf] getLostModeStatus(${id}) 失敗:`, e);
      return null;
    }),
  ]);
  const agentReport = getLatestReport(id);

  const ios = detail.ios;
  return c.json({
    // Jamf 基礎資訊
    id: detail.id,
    name: detail.name,
    serialNumber: detail.serialNumber,
    udid: detail.udid,
    osVersion: detail.osVersion,
    osBuild: detail.osBuild,
    managed: detail.managed,
    ipAddress: detail.ipAddress,
    enrollmentMethod: detail.enrollmentMethod,
    lastInventoryUpdate: detail.lastInventoryUpdateTimestamp,
    managementId: detail.managementId,
    groups: detail.groups,
    // iOS 硬體資訊
    hardware: ios
      ? {
          model: ios.model,
          modelIdentifier: ios.modelIdentifier,
          batteryLevel: ios.batteryLevel,
          capacityMb: ios.capacityMb,
          availableMb: ios.availableMb,
          percentageUsed: ios.percentageUsed,
          supervised: ios.supervised,
        }
      : null,
    // iOS 安全資訊
    security: ios?.security ?? null,
    // Lost Mode 狀態（Jamf 只在 Classic API /JSSResource/mobiledevices 才回傳，需額外 request）
    lostMode,
    // 已安裝 App
    applications: ios?.applications ?? [],
    // 設定描述檔
    configurationProfiles: ios?.configurationProfiles ?? [],
    // Agent App 最新回報
    agentReport: agentReport
      ? {
          batteryLevel: agentReport.battery_level,
          storageAvailableMb: agentReport.storage_available_mb,
          storageTotalMb: agentReport.storage_total_mb,
          networkType: agentReport.network_type,
          networkSsid: agentReport.network_ssid,
          screenBrightness: agentReport.screen_brightness,
          osVersion: agentReport.os_version,
          appVersion: agentReport.app_version,
          reportedAt: agentReport.reported_at,
        }
      : null,
  });
});

/** POST /api/devices/:id/command - 傳送管理命令 */
devices.post("/:id/command", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    command: string;
    lostModeMessage?: string;
    lostModePhone?: string;
    lostModeFootnote?: string;
  }>();

  const svc = getService();
  // 先取得裝置的 managementId
  const detail = await svc.getMobileDevice(id);

  const validCommands = [
    "DEVICE_LOCK",
    "ERASE_DEVICE",
    "CLEAR_PASSCODE",
    "DEVICE_INFORMATION",
    "RESTART_DEVICE",
    "SHUT_DOWN_DEVICE",
    "ENABLE_LOST_MODE",
    "DISABLE_LOST_MODE",
  ];

  if (!validCommands.includes(body.command)) {
    return c.json(
      { error: `Invalid command. Valid: ${validCommands.join(", ")}` },
      400
    );
  }

  const payload: import("../jamf/types.ts").CommandPayload = {
    commandType: body.command as import("../jamf/types.ts").DeviceCommand,
  };
  if (body.lostModeMessage) payload.lostModeMessage = body.lostModeMessage;
  if (body.lostModePhone) payload.lostModePhone = body.lostModePhone;
  if (body.lostModeFootnote) payload.lostModeFootnote = body.lostModeFootnote;

  const result = await svc.sendCommand(detail.managementId, payload);

  return c.json({ ok: true, command: body.command, result });
});

/** POST /api/devices/:id/app-lock - 啟用單 App 模式 */
devices.post("/:id/app-lock", async (c) => {
  const id = c.req.param("id");
  const svc = getService();
  await svc.enableAppLock(id);
  return c.json({ ok: true, action: "enabled" });
});

/** DELETE /api/devices/:id/app-lock - 停用單 App 模式 */
devices.delete("/:id/app-lock", async (c) => {
  const id = c.req.param("id");
  const svc = getService();
  await svc.disableAppLock(id);
  return c.json({ ok: true, action: "disabled" });
});

export default devices;
