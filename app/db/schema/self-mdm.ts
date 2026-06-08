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
