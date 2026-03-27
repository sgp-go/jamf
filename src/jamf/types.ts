/** Jamf API 型別定義 - 基於 v2 API 實際返回結構 */

// OAuth Token 響應
export interface TokenResponse {
  access_token: string;
  scope: string;
  token_type: string;
  expires_in: number;
}

// 移動裝置列表響應
export interface MobileDeviceListResponse {
  totalCount: number;
  results: MobileDeviceSummary[];
}

// 裝置摘要（列表中的簡略資訊）
export interface MobileDeviceSummary {
  id: string;
  name: string;
  serialNumber: string;
  wifiMacAddress: string;
  managementId: string;
}

// v2 裝置詳情 - 頂層欄位
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
  mdmProfileExpirationTimestamp: string;
  managementId: string;
  type: "ios" | "tvos" | "watchos" | "visionos";
  ios: IosDetail | null;
  groups: DeviceGroup[];
  extensionAttributes: unknown[];
}

// iOS 裝置詳細資訊
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
  deviceLocatorServiceEnabled: boolean;
  cloudBackupEnabled: boolean;
  locationServicesEnabled: boolean;
  security: DeviceSecurity;
  network: DeviceNetwork;
  applications: DeviceApplication[];
  configurationProfiles: ConfigurationProfile[];
  certificates: DeviceCertificate[];
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

export interface DeviceNetwork {
  cellularTechnology: string;
  voiceRoamingEnabled: boolean;
  imei: string | null;
  iccid: string | null;
  currentCarrierNetwork: string | null;
  dataRoamingEnabled: boolean;
  roaming: boolean;
  phoneNumber: string | null;
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

export interface DeviceCertificate {
  commonName: string;
  identity: boolean;
  expirationDateEpoch: string;
  certificateStatus: string;
}

export interface DeviceGroup {
  groupId: string;
  groupName: string;
  smart: boolean;
}

// 裝置命令（v2 API 使用 UPPER_SNAKE_CASE）
export type DeviceCommand =
  | "DEVICE_LOCK"
  | "ERASE_DEVICE"
  | "CLEAR_PASSCODE"
  | "DEVICE_INFORMATION"
  | "RESTART_DEVICE"
  | "SHUT_DOWN_DEVICE";

export interface CommandPayload {
  commandType: DeviceCommand;
}

// Jamf Pro 版本
export interface JamfProVersion {
  version: string;
}

// API 錯誤
export interface JamfApiError {
  httpStatus: number;
  errors: { code: string; description: string; field?: string }[];
}
