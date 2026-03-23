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

  const detail = await svc.getMobileDevice(id);
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
  const body = await c.req.json<{ command: string }>();

  const svc = getService();
  // 先取得裝置的 managementId
  const detail = await svc.getMobileDevice(id);

  const validCommands = [
    "DeviceLock",
    "EraseDevice",
    "ClearPasscode",
    "UpdateInventory",
    "RestartDevice",
    "ShutDownDevice",
  ];

  if (!validCommands.includes(body.command)) {
    return c.json(
      { error: `Invalid command. Valid: ${validCommands.join(", ")}` },
      400
    );
  }

  const result = await svc.sendCommand(detail.managementId, {
    commandType: body.command as import("../jamf/types.ts").DeviceCommand,
  });

  return c.json({ ok: true, command: body.command, result });
});

export default devices;
