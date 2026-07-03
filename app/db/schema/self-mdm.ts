import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.ts";

/**
 * 自建 MDM 的 per-tenant 配置（一個 tenant 一份 CA + APNS topic + 對外 endpoint）。
 * 不放在 jamfInstances 一起，因為自建 MDM 與 Jamf 是兩種不同的設備管理路徑，
 * 設備也可以單純走自建 MDM 而完全不用 Jamf。
 */
export const selfMdmConfigs = pgTable(
  "self_mdm_configs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" })
      .unique(),
    publicBaseUrl: text().notNull(),
    appDownloadBaseUrl: text(),
    /**
     * 新設備 enroll 完成後要派發的 CoGrow MDM Agent app（指向 apps.id）。
     *
     * 為什麼放在 tenant 配置而非自動推導：apps 表只記文件類型（kind=msi/msix/...），
     * 不區分用途。一個 tenant 可以上傳多個 MSI（agent + 教學軟體 + 7-Zip…），系統
     * 必須明確知道「哪個是 agent」才能 enrollment hook 自動派發。預設 null 時
     * enrollment hook 會跳過 install-agent 並 warn。
     *
     * ⚠️ FK 在 migration 裡手寫加上（onDelete: set null）：drizzle schema 這裡不寫
     * `.references(() => apps.id)`，避開 apps.ts ↔ devices.ts ↔ self-mdm.ts 的三角
     * 循環依賴。FK 約束本身在 DB 層仍生效。
     */
    agentAppId: uuid(),
    /**
     * LAPS 自動輪換的目標本機管理員帳號。預設 "ITAdmin" —— 對齊 PPKG
     * 常見預配的日常 admin 帳號（Win11 內建 Administrator 預設禁用不可用）。
     * 若 PPKG 建的 admin 帳號名不同，tenant 建配置時（或 PATCH mdm-config）改成該名。
     * 空字串或 NULL 都當作 "ITAdmin"（服務層 fallback）。
     */
    adminAccountName: varchar({ length: 64 }).notNull().default("ITAdmin"),
    apnsTopic: text(),
    apnsCertPem: text(),
    apnsKeyPemEnc: text(),
    caCertPem: text(),
    caKeyPemEnc: text(),
    vendorCertPem: text(),
    vendorKeyPemEnc: text(),
    isActive: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

/**
 * 自建 MDM 註冊期間 + 註冊後簽發的客戶端憑證（每台裝置一張）。
 */
export const mdmDeviceCertificates = pgTable(
  "mdm_device_certificates",
  {
    id: uuid().primaryKey().defaultRandom(),
    selfMdmConfigId: uuid()
      .notNull()
      .references(() => selfMdmConfigs.id, { onDelete: "cascade" }),
    deviceUdid: varchar({ length: 64 }),
    certSerial: text(),
    subject: text(),
    notBefore: timestamp({ withTimezone: true }),
    notAfter: timestamp({ withTimezone: true }),
    certificatePem: text().notNull(),
    revoked: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mdm_device_certs_udid_idx").on(t.deviceUdid),
    index("mdm_device_certs_serial_idx").on(t.certSerial),
  ],
);

export type SelfMdmConfig = typeof selfMdmConfigs.$inferSelect;
