/**
 * Jamf v2 API 與 Classic API 的型別。
 *
 * 沿用 src/jamf/types.ts 的結構，僅補上 client_id 等對舊版相容欄位。
 * 由 services 自家用，不直接外暴露給 route layer（route 用 zod schema 過濾）。
 */

export interface MobileDeviceListResponse {
  totalCount: number;
  results: MobileDeviceSummary[];
}

export interface MobileDeviceSummary {
  id: string;
  name: string;
  serialNumber: string;
  wifiMacAddress: string;
  managementId: string;
}

/**
 * 批量庫存端點 GET /api/v2/mobile-devices/detail?section=GENERAL&section=HARDWARE 的回應。
 *
 * ⚠️ 與單台 /{id}/detail（MobileDeviceDetail）結構不同：單台是扁平 + ios 子物件；
 * 批量是巢狀 section（general / hardware），且欄位名有差：
 *   - id → mobileDeviceId
 *   - lastEnrollmentTimestamp → general.lastEnrolledDate
 *   - ios.availableMb → hardware.availableSpaceMb
 *   - serialNumber 位於 hardware（非頂層）
 * sync 用此端點（一次分頁取回全庫存），兩端點欄位名不可混用。
 */
export interface MobileDeviceDetailListResponse {
  totalCount: number;
  results: MobileDeviceInventory[];
}

export interface MobileDeviceInventory {
  mobileDeviceId: string;
  deviceType: string;
  general: MobileDeviceGeneralSection | null;
  hardware: MobileDeviceHardwareSection | null;
}

export interface MobileDeviceGeneralSection {
  displayName: string | null;
  udid: string | null;
  managementId: string | null;
  osVersion: string | null;
  osBuild: string | null;
  lastEnrolledDate: string | null;
  lastInventoryUpdateDate: string | null;
}

export interface MobileDeviceHardwareSection {
  serialNumber: string | null;
  model: string | null;
  modelIdentifier: string | null;
  capacityMb: number | null;
  availableSpaceMb: number | null;
  usedSpacePercentage: number | null;
  batteryLevel: number | null;
  batteryHealth: string | null;
}

export interface MobileDeviceDetail {
  id: string;
  name: string;
  serialNumber: string;
  udid: string;
  wifiMacAddress: string;
  bluetoothMacAddress: string;
  ipAddress: string;
  osVersion: string;
  osBuild: string;
  managed: boolean;
  deviceOwnershipLevel: string;
  enrollmentMethod: string;
  lastInventoryUpdateTimestamp: string;
  lastEnrollmentTimestamp: string;
  managementId: string;
  type: "ios" | "tvos" | "watchos" | "visionos";
  ios: IosDetail | null;
  groups: DeviceGroup[];
  extensionAttributes: unknown[];
}

export interface IosDetail {
  model: string;
  modelIdentifier: string;
  modelNumber: string;
  capacityMb: number;
  availableMb: number;
  percentageUsed: number;
  batteryLevel: number;
  batteryHealth: string;
  supervised: boolean;
  shared: boolean;
  security: DeviceSecurity;
  applications: DeviceApplication[];
  configurationProfiles: ConfigurationProfile[];
}

export interface DeviceSecurity {
  dataProtected: boolean;
  blockLevelEncryptionCapable: boolean;
  fileLevelEncryptionCapable: boolean;
  passcodePresent: boolean;
  passcodeCompliant: boolean;
  activationLockEnabled: boolean;
  jailBreakDetected: boolean;
}

export interface DeviceApplication {
  name: string;
  identifier: string;
  version: string | null;
  shortVersion: string | null;
}

export interface ConfigurationProfile {
  displayName: string;
  version: string;
  uuid: string;
  identifier: string;
}

export interface DeviceGroup {
  groupId: string;
  groupName: string;
  smart: boolean;
}

export interface ClassicMobileDeviceSecurity {
  lost_mode_enabled: string | boolean;
  lost_mode_enforced: boolean;
  lost_mode_enable_issued_epoch: number;
  lost_mode_enable_issued_utc: string;
  lost_mode_message: string;
  lost_mode_phone: string;
  lost_mode_footnote: string;
  lost_location_epoch: number;
  lost_location_utc: string;
  lost_location_latitude: number;
  lost_location_longitude: number;
  lost_location_altitude: number;
  lost_location_speed: number;
  lost_location_course: number;
  lost_location_horizontal_accuracy: number;
  lost_location_vertical_accuracy: number;
}

export interface JamfLostModeStatus {
  enabled: boolean;
  enforced: boolean;
  message: string | null;
  phone: string | null;
  footnote: string | null;
  enabledAt: string | null;
  location: {
    latitude: number;
    longitude: number;
    altitude: number | null;
    speed: number | null;
    course: number | null;
    horizontalAccuracy: number | null;
    verticalAccuracy: number | null;
    timestamp: string | null;
  } | null;
}

export type DeviceCommand =
  | "DEVICE_LOCK"
  | "ERASE_DEVICE"
  | "CLEAR_PASSCODE"
  | "DEVICE_INFORMATION"
  | "RESTART_DEVICE"
  | "SHUT_DOWN_DEVICE"
  | "ENABLE_LOST_MODE"
  | "DISABLE_LOST_MODE";

export interface CommandPayload {
  commandType: DeviceCommand;
  lostModeMessage?: string;
  lostModePhone?: string;
  lostModeFootnote?: string;
}
