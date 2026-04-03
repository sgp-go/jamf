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

  /**
   * 啟用單 App 模式 — 將裝置加入 App Lock Profile 的 scope
   * 需要在 Jamf Pro UI 預先建立含 com.apple.app.lock payload 的 Configuration Profile，
   * 並透過環境變數 JAMF_APP_LOCK_PROFILE_ID 指定其 ID。
   */
  async enableAppLock(deviceId: string): Promise<void> {
    const profileId = Deno.env.get("JAMF_APP_LOCK_PROFILE_ID");
    if (!profileId) {
      throw new Error("JAMF_APP_LOCK_PROFILE_ID is not configured");
    }
    await this.client.putXml(
      `/JSSResource/mobiledeviceconfigurationprofiles/id/${profileId}`,
      `<configuration_profile>
        <scope>
          <mobile_devices>
            <mobile_device><id>${deviceId}</id></mobile_device>
          </mobile_devices>
        </scope>
      </configuration_profile>`
    );
    // 發送 Blank Push 讓裝置盡快簽入
    await this.client.postXml(
      `/JSSResource/mobiledevicecommands/command/BlankPush/id/${deviceId}`
    );
  }

  /** 停用單 App 模式 — 將裝置從 App Lock Profile 的 scope 中移除 */
  async disableAppLock(deviceId: string): Promise<void> {
    const profileId = Deno.env.get("JAMF_APP_LOCK_PROFILE_ID");
    if (!profileId) {
      throw new Error("JAMF_APP_LOCK_PROFILE_ID is not configured");
    }
    await this.client.putXml(
      `/JSSResource/mobiledeviceconfigurationprofiles/id/${profileId}`,
      `<configuration_profile>
        <scope>
          <mobile_devices/>
        </scope>
      </configuration_profile>`
    );
    await this.client.postXml(
      `/JSSResource/mobiledevicecommands/command/BlankPush/id/${deviceId}`
    );
  }
}

export type { MobileDeviceListResponse, MobileDeviceDetail, MobileDeviceSummary };
