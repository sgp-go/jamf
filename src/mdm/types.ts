/** 自建 MDM 伺服器 - 型別定義 */

// ============================================================
// MDM Check-in 協議型別
// ============================================================

/** Check-in 訊息類型 */
export type CheckinMessageType = "Authenticate" | "TokenUpdate" | "CheckOut";

/** Authenticate 訊息（裝置安裝 MDM 描述檔時首次發送） */
export interface AuthenticateMessage {
  MessageType: "Authenticate";
  UDID: string;
  Topic: string;
  BuildVersion?: string;
  DeviceName?: string;
  Model?: string;
  ModelName?: string;
  OSVersion?: string;
  ProductName?: string;
  SerialNumber?: string;
}

/** TokenUpdate 訊息（Authenticate 後發送，含推播 token） */
export interface TokenUpdateMessage {
  MessageType: "TokenUpdate";
  UDID: string;
  Topic: string;
  Token: Uint8Array | string; // APNS push token（二進位或 base64）
  PushMagic: string;
  UnlockToken?: Uint8Array | string;
  AwaitingConfiguration?: boolean;
}

/** CheckOut 訊息（MDM 描述檔被移除時發送） */
export interface CheckOutMessage {
  MessageType: "CheckOut";
  UDID: string;
  Topic: string;
}

/** Check-in 訊息聯合型別 */
export type CheckinMessage =
  | AuthenticateMessage
  | TokenUpdateMessage
  | CheckOutMessage;

// ============================================================
// MDM Command 協議型別
// ============================================================

/** 裝置命令回應狀態 */
export type CommandStatus =
  | "Idle"
  | "Acknowledged"
  | "Error"
  | "CommandFormatError"
  | "NotNow";

/** 裝置向 ServerURL 發送的請求 */
export interface CommandRequest {
  Status: CommandStatus;
  UDID: string;
  CommandUUID?: string;
  ErrorChain?: ErrorChainItem[];
  // 各命令的回應資料會作為額外欄位
  [key: string]: unknown;
}

/** 錯誤鏈項目 */
export interface ErrorChainItem {
  LocalizedDescription?: string;
  USEnglishDescription?: string;
  ErrorDomain?: string;
  ErrorCode?: number;
}

/** 支援的 MDM 命令類型 */
export type MdmCommandType =
  | "DeviceInformation"
  | "SecurityInfo"
  | "InstalledApplicationList"
  | "DeviceLock"
  | "ClearPasscode"
  | "EraseDevice"
  | "RestartDevice"
  | "ShutDownDevice"
  | "InstallProfile"
  | "RemoveProfile"
  | "ProfileList"
  | "CertificateList"
  | "EnableLostMode"
  | "DisableLostMode"
  | "InstallApplication"
  | "RemoveApplication";

/** 命令佇列資料庫記錄 */
export interface MdmCommandRow {
  id: number;
  command_uuid: string;
  device_udid: string;
  command_type: string;
  request_payload: string;
  response_payload: string | null;
  status: string;
  error_chain: string | null;
  queued_at: string;
  sent_at: string | null;
  responded_at: string | null;
}

/** 伺服器回傳給裝置的命令結構 */
export interface CommandResponse {
  CommandUUID: string;
  Command: {
    RequestType: string;
    [key: string]: unknown;
  };
}

// ============================================================
// MDM 裝置型別
// ============================================================

/** 裝置註冊狀態 */
export type EnrollmentStatus =
  | "pending"
  | "authenticated"
  | "enrolled"
  | "unenrolled";

/** MDM 裝置資料庫記錄 */
export interface MdmDeviceRow {
  id: number;
  udid: string;
  serial_number: string | null;
  device_name: string | null;
  model: string | null;
  os_version: string | null;
  push_token: string | null;
  push_magic: string | null;
  unlock_token: string | null;
  topic: string | null;
  last_seen_at: string | null;
  enrolled_at: string;
  enrollment_status: string;
  enrollment_type: string;
  device_info: string | null;
  lost_mode_enabled: number;
  lost_mode_message: string | null;
  lost_mode_phone: string | null;
  lost_mode_footnote: string | null;
  lost_mode_enabled_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// DEP/ADE 協議型別
// ============================================================

/** DEP Server Token（從 .p7m 解密後的內容） */
export interface DepServerToken {
  consumer_key: string;
  consumer_secret: string;
  access_token: string;
  access_secret: string;
  access_token_expiry: string;
}

/** DEP 帳戶資訊（GET /account 回應） */
export interface DepAccountInfo {
  server_name: string;
  server_uuid: string;
  org_name: string;
  org_email: string;
  org_phone: string;
  org_address: string;
  facilitator_id?: string;
  admin_id?: string;
}

/** DEP 裝置（從 Apple 同步） */
export interface DepDevice {
  serial_number: string;
  model: string;
  description: string;
  color: string;
  device_family: string;
  os: string;
  device_assigned_by: string;
  device_assigned_date: string;
  profile_uuid?: string;
  profile_status: "empty" | "assigned" | "pushed" | "removed";
  profile_assign_time?: string;
}

/** DEP 裝置同步回應 */
export interface DepDeviceSyncResponse {
  cursor: string;
  more_to_follow: boolean;
  fetched_until: string;
  devices: DepDevice[];
}

/** DEP 裝置資料庫記錄 */
export interface DepDeviceRow {
  id: number;
  serial_number: string;
  model: string | null;
  description: string | null;
  color: string | null;
  device_family: string | null;
  os: string | null;
  profile_uuid: string | null;
  profile_status: string;
  dep_synced_at: string | null;
  created_at: string;
}

/** ADE 描述檔定義（POST /profile 到 Apple DEP API） */
export interface DepProfile {
  profile_name: string;
  url: string;
  allow_pairing: boolean;
  is_supervised: boolean;
  is_mandatory: boolean;
  await_device_configured: boolean;
  is_mdm_removable: boolean;
  support_phone_number?: string;
  support_email_address?: string;
  org_magic?: string;
  anchor_certs?: string[];
  supervising_host_certs?: string[];
  skip_setup_items?: string[];
  department?: string;
  devices?: string[];
}

/** ADE 描述檔回應 */
export interface DepProfileResponse {
  profile_uuid: string;
  devices: Record<string, string>; // serial_number -> status
}

/** DEP Token 資料庫記錄 */
export interface DepTokenRow {
  id: number;
  server_name: string | null;
  consumer_key: string;
  consumer_secret: string;
  access_token: string;
  access_secret: string;
  token_expiry: string | null;
  org_name: string | null;
  org_email: string | null;
  org_address: string | null;
  last_synced_at: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

// ============================================================
// 遷移型別
// ============================================================

/** 遷移狀態 */
export type MigrationStatus =
  | "pending"
  | "abm_reassigned"
  | "device_wiping"
  | "awaiting_setup"
  | "dep_enrolled"
  | "failed";

/** 遷移記錄 */
export interface MdmMigrationRow {
  id: number;
  serial_number: string;
  device_udid: string | null;
  jamf_device_id: string | null;
  jamf_management_id: string | null;
  status: string;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

// ============================================================
// Enrollment 描述檔型別
// ============================================================

/** MDM Payload 設定 */
export interface MdmPayloadConfig {
  serverUrl: string;
  checkinUrl: string;
  topic: string;
  identityCertificateUuid: string;
  accessRights: number;
}

/** 憑證狀態 */
export interface CertificateStatus {
  apnsCert: { exists: boolean; expiry?: string };
  caCert: { exists: boolean; expiry?: string };
  depToken: { exists: boolean; expiry?: string; orgName?: string };
}
