/**
 * MDM 註冊描述檔生成
 *
 * 生成 .mobileconfig（XML plist）包含：
 * 1. CA 根憑證 Payload - 讓裝置信任伺服器
 * 2. PKCS#12 Payload - 裝置身份憑證
 * 3. MDM Payload - ServerURL、CheckInURL、Topic 等核心設定
 */

import { buildPlist } from "./plist.ts";
import { getCACertDerBase64, issueDeviceCertificateP12 } from "./crypto.ts";
import forge from "node-forge";
import { Buffer } from "node:buffer";

/** 描述檔生成選項 */
export interface EnrollmentProfileOptions {
  /** MDM 伺服器基礎 URL（如 https://xxxx.ngrok-free.app） */
  serverBaseUrl: string;
  /** APNS Topic（MDM 推播憑證的 Subject UID） */
  topic: string;
  /** 裝置 UDID（用於裝置憑證 CN，可選） */
  deviceUdid?: string;
  /** 組織名稱 */
  orgName?: string;
  /** 裝置身份憑證密碼 */
  identityPassword?: string;
  /** AccessRights（預設 8191 = 全部權限） */
  accessRights?: number;
}

/** 生成 MDM 註冊描述檔（.mobileconfig XML plist） */
export function generateEnrollmentProfile(
  opts: EnrollmentProfileOptions
): string {
  const orgName = opts.orgName ?? "Aspira";
  const identityPassword = opts.identityPassword ?? "mdm-device-identity";
  const accessRights = opts.accessRights ?? 8191;

  // UUID 用於各 Payload 之間的引用
  const profileUuid = crypto.randomUUID().toUpperCase();
  const caPayloadUuid = crypto.randomUUID().toUpperCase();
  const identityPayloadUuid = crypto.randomUUID().toUpperCase();
  const mdmPayloadUuid = crypto.randomUUID().toUpperCase();

  // 1. CA 根憑證（DER → Buffer，plist 會輸出為 <data> 標籤）
  const caCertBase64 = getCACertDerBase64();
  const caCertBuffer = Buffer.from(caCertBase64, "base64");

  // 2. 裝置身份憑證（PKCS#12 → Buffer）
  const deviceId = opts.deviceUdid ?? "default";
  const p12Bytes = issueDeviceCertificateP12(deviceId, identityPassword);
  const p12Buffer = Buffer.from(p12Bytes);

  // 3. 建構描述檔
  const profile: Record<string, unknown> = {
    PayloadContent: [
      // CA 根憑證 Payload
      {
        PayloadType: "com.apple.security.pem",
        PayloadVersion: 1,
        PayloadIdentifier: `com.aspira.mdm.ca.${caPayloadUuid}`,
        PayloadUUID: caPayloadUuid,
        PayloadDisplayName: `${orgName} MDM CA`,
        PayloadDescription: "安裝 MDM 伺服器的根憑證",
        PayloadContent: caCertBuffer,
      },
      // 裝置身份憑證 Payload（PKCS#12）
      {
        PayloadType: "com.apple.security.pkcs12",
        PayloadVersion: 1,
        PayloadIdentifier: `com.aspira.mdm.identity.${identityPayloadUuid}`,
        PayloadUUID: identityPayloadUuid,
        PayloadDisplayName: "MDM 裝置身份憑證",
        PayloadDescription: "裝置向 MDM 伺服器認證的身份憑證",
        PayloadContent: p12Buffer,
        Password: identityPassword,
      },
      // MDM Payload
      {
        PayloadType: "com.apple.mdm",
        PayloadVersion: 1,
        PayloadIdentifier: `com.aspira.mdm.mdm.${mdmPayloadUuid}`,
        PayloadUUID: mdmPayloadUuid,
        PayloadDisplayName: `${orgName} MDM`,
        PayloadDescription: "裝置管理設定",
        PayloadOrganization: orgName,
        ServerURL: `${opts.serverBaseUrl}/api/mdm/command`,
        CheckInURL: `${opts.serverBaseUrl}/api/mdm/checkin`,
        Topic: opts.topic,
        IdentityCertificateUUID: identityPayloadUuid,
        AccessRights: accessRights,
        CheckOutWhenRemoved: true,
        ServerCapabilities: ["com.apple.mdm.per-user-connections"],
      },
    ],
    PayloadType: "Configuration",
    PayloadVersion: 1,
    PayloadIdentifier: `com.aspira.mdm.enroll.${profileUuid}`,
    PayloadUUID: profileUuid,
    PayloadDisplayName: `${orgName} MDM 註冊`,
    PayloadDescription: `安裝此描述檔以將裝置註冊到 ${orgName} MDM`,
    PayloadOrganization: orgName,
    PayloadRemovalDisallowed: false,
  };

  return buildPlist(profile);
}

/**
 * 生成用於 ADE 回應的註冊描述檔
 * ADE 裝置在 Setup Assistant 中會自動請求此描述檔
 * 與手動註冊描述檔相同，但可設定 PayloadRemovalDisallowed = true
 */
export function generateAdeEnrollmentProfile(
  opts: EnrollmentProfileOptions
): string {
  // ADE 描述檔本質上和手動一樣，但裝置是 supervised 模式
  // MDM 描述檔不可移除由 ADE profile 中的 is_mdm_removable 控制
  return generateEnrollmentProfile(opts);
}
