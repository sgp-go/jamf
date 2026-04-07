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

  /** 向裝置傳送管理命令（支援帶額外參數的命令，如 ENABLE_LOST_MODE） */
  async sendCommand(
    managementId: string,
    command: CommandPayload
  ): Promise<unknown> {
    return this.client.post("/api/v2/mdm/commands", {
      clientData: [{ managementId }],
      commandData: command,
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

  /** 啟用遺失模式 */
  enableLostMode(
    managementId: string,
    opts?: { message?: string; phone?: string; footnote?: string }
  ): Promise<unknown> {
    return this.sendCommand(managementId, {
      commandType: "ENABLE_LOST_MODE",
      lostModeMessage: opts?.message ?? "",
      lostModePhone: opts?.phone ?? "",
      lostModeFootnote: opts?.footnote ?? "",
    });
  }

  /** 停用遺失模式 */
  disableLostMode(managementId: string): Promise<unknown> {
    return this.sendCommand(managementId, { commandType: "DISABLE_LOST_MODE" });
  }

  /**
   * 啟用單 App 模式 — 將裝置加入 App Lock 群組（增量操作，不影響其他裝置）
   *
   * 前置配置：
   * 1. 在 Jamf Pro UI 建立含 com.apple.app.lock payload 的 Configuration Profile
   * 2. 建立 Static Group，將 Profile scope 綁定到該群組
   * 3. 在 .env 中設定 JAMF_APP_LOCK_GROUP_ID 為該群組 ID
   */
  async enableAppLock(deviceId: string): Promise<void> {
    const groupId = Deno.env.get("JAMF_APP_LOCK_GROUP_ID");
    if (!groupId) {
      throw new Error("JAMF_APP_LOCK_GROUP_ID is not configured");
    }
    await this.client.putXml(
      `/JSSResource/mobiledevicegroups/id/${groupId}`,
      `<mobile_device_group>
        <mobile_device_additions>
          <mobile_device><id>${deviceId}</id></mobile_device>
        </mobile_device_additions>
      </mobile_device_group>`
    );
    await this.client.postXml(
      `/JSSResource/mobiledevicecommands/command/BlankPush/id/${deviceId}`
    );
  }

  /** 停用單 App 模式 — 將裝置從 App Lock 群組中移除（增量操作，不影響其他裝置） */
  async disableAppLock(deviceId: string): Promise<void> {
    const groupId = Deno.env.get("JAMF_APP_LOCK_GROUP_ID");
    if (!groupId) {
      throw new Error("JAMF_APP_LOCK_GROUP_ID is not configured");
    }
    await this.client.putXml(
      `/JSSResource/mobiledevicegroups/id/${groupId}`,
      `<mobile_device_group>
        <mobile_device_deletions>
          <mobile_device><id>${deviceId}</id></mobile_device>
        </mobile_device_deletions>
      </mobile_device_group>`
    );
    await this.client.postXml(
      `/JSSResource/mobiledevicecommands/command/BlankPush/id/${deviceId}`
    );
  }
}

export type { MobileDeviceListResponse, MobileDeviceDetail, MobileDeviceSummary };
