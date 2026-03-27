/** 裝置管理 API */

import { JamfClient } from "./client.ts";
import type {
  MobileDeviceListResponse,
  MobileDeviceDetail,
  MobileDeviceSummary,
  CommandPayload,
} from "./types.ts";

export class DeviceService {
  constructor(private client: JamfClient) {}

  /** 獲取移動裝置列表 */
  async listMobileDevices(opts?: {
    page?: number;
    pageSize?: number;
  }): Promise<MobileDeviceListResponse> {
    const page = opts?.page ?? 0;
    const size = opts?.pageSize ?? 100;
    return this.client.get<MobileDeviceListResponse>(
      `/api/v2/mobile-devices?page=${page}&page-size=${size}`
    );
  }

  /** 獲取單個移動裝置詳情（包含 iOS 硬體/網路/App 等完整資訊） */
  async getMobileDevice(id: string): Promise<MobileDeviceDetail> {
    return this.client.get<MobileDeviceDetail>(
      `/api/v2/mobile-devices/${id}/detail`
    );
  }

  /** 透過序列號查詢裝置 */
  async findBySerialNumber(
    serialNumber: string
  ): Promise<MobileDeviceSummary | null> {
    const resp = await this.listMobileDevices({ pageSize: 200 });
    return (
      resp.results.find((d) => d.serialNumber === serialNumber) ?? null
    );
  }

  /** 向裝置傳送管理命令 */
  async sendCommand(
    managementId: string,
    command: CommandPayload
  ): Promise<unknown> {
    return this.client.post("/api/v2/mdm/commands", {
      clientData: [{ managementId }],
      commandData: { commandType: command.commandType },
    });
  }

  /** 更新庫存資訊 */
  updateInventory(managementId: string): Promise<unknown> {
    return this.sendCommand(managementId, { commandType: "DEVICE_INFORMATION" });
  }

  /** 鎖定裝置 */
  lockDevice(managementId: string): Promise<unknown> {
    return this.sendCommand(managementId, { commandType: "DEVICE_LOCK" });
  }
}

export type { MobileDeviceListResponse, MobileDeviceDetail, MobileDeviceSummary };
