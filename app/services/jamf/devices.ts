import { AppError } from "~/lib/errors.ts";
import type { JamfClient } from "./client.ts";
import type {
  ClassicMobileDeviceSecurity,
  CommandPayload,
  JamfLostModeStatus,
  MobileDeviceDetail,
  MobileDeviceListResponse,
} from "./types.ts";

export class DeviceService {
  constructor(private readonly client: JamfClient) {}

  listMobileDevices(opts?: { page?: number; pageSize?: number }) {
    const page = opts?.page ?? 0;
    const size = opts?.pageSize ?? 100;
    return this.client.get<MobileDeviceListResponse>(
      `/api/v2/mobile-devices?page=${page}&page-size=${size}`,
    );
  }

  getMobileDevice(id: string): Promise<MobileDeviceDetail> {
    return this.client.get<MobileDeviceDetail>(`/api/v2/mobile-devices/${id}/detail`);
  }

  /**
   * Jamf v2 detail endpoint 不回傳 lost mode，必須走 Classic API。
   * Classic 失敗時返回 null（不擋主要詳情查詢）。
   */
  async getLostModeStatus(id: string): Promise<JamfLostModeStatus | null> {
    try {
      const resp = await this.client.get<{
        mobile_device: { security: ClassicMobileDeviceSecurity };
      }>(`/JSSResource/mobiledevices/id/${id}`);
      return normalizeLostMode(resp.mobile_device.security);
    } catch (err) {
      console.warn(`[Jamf] getLostModeStatus(${id}) failed:`, err);
      return null;
    }
  }

  sendCommand(managementId: string, command: CommandPayload): Promise<unknown> {
    return this.client.post("/api/v2/mdm/commands", {
      clientData: [{ managementId }],
      commandData: command,
    });
  }

  /**
   * App Lock 開啟：把裝置加入指定 Static Group，scope 綁定的 Profile 自動派送。
   * groupId 由 jamf_instances.app_lock_group_id 提供，沒設則拒絕。
   */
  async enableAppLock(deviceId: string, groupId: number | null): Promise<void> {
    this.assertGroupConfigured(groupId);
    await this.client.putXml(
      `/JSSResource/mobiledevicegroups/id/${groupId}`,
      `<mobile_device_group>
        <mobile_device_additions>
          <mobile_device><id>${deviceId}</id></mobile_device>
        </mobile_device_additions>
      </mobile_device_group>`,
    );
    await this.client.postXml(
      `/JSSResource/mobiledevicecommands/command/BlankPush/id/${deviceId}`,
    );
  }

  async disableAppLock(deviceId: string, groupId: number | null): Promise<void> {
    this.assertGroupConfigured(groupId);
    await this.client.putXml(
      `/JSSResource/mobiledevicegroups/id/${groupId}`,
      `<mobile_device_group>
        <mobile_device_deletions>
          <mobile_device><id>${deviceId}</id></mobile_device>
        </mobile_device_deletions>
      </mobile_device_group>`,
    );
    await this.client.postXml(
      `/JSSResource/mobiledevicecommands/command/BlankPush/id/${deviceId}`,
    );
  }

  private assertGroupConfigured(groupId: number | null): asserts groupId is number {
    if (groupId == null) {
      throw new AppError(
        409,
        "app_lock_group_not_configured",
        "jamf_instances.app_lock_group_id is not set for this instance",
      );
    }
  }
}

function normalizeLostMode(sec: ClassicMobileDeviceSecurity): JamfLostModeStatus {
  const enabled =
    typeof sec.lost_mode_enabled === "boolean"
      ? sec.lost_mode_enabled
      : sec.lost_mode_enabled === "true";

  const hasLocation =
    sec.lost_location_epoch > 0 &&
    !(sec.lost_location_latitude === 0 && sec.lost_location_longitude === 0);

  const nullIfNegative = (n: number): number | null => (n < 0 ? null : n);

  return {
    enabled,
    enforced: Boolean(sec.lost_mode_enforced),
    message: sec.lost_mode_message || null,
    phone: sec.lost_mode_phone || null,
    footnote: sec.lost_mode_footnote || null,
    enabledAt:
      sec.lost_mode_enable_issued_epoch > 0
        ? new Date(sec.lost_mode_enable_issued_epoch).toISOString()
        : sec.lost_mode_enable_issued_utc || null,
    location: hasLocation
      ? {
          latitude: sec.lost_location_latitude,
          longitude: sec.lost_location_longitude,
          altitude: nullIfNegative(sec.lost_location_altitude),
          speed: nullIfNegative(sec.lost_location_speed),
          course: nullIfNegative(sec.lost_location_course),
          horizontalAccuracy: nullIfNegative(sec.lost_location_horizontal_accuracy),
          verticalAccuracy: nullIfNegative(sec.lost_location_vertical_accuracy),
          timestamp: sec.lost_location_utc || null,
        }
      : null,
  };
}
