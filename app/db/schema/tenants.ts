import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { jamfInstances } from "./jamf.ts";

export const tenants = pgTable("tenants", {
  id: uuid().primaryKey().defaultRandom(),
  slug: varchar({ length: 64 }).notNull().unique(),
  displayName: text().notNull(),
  isActive: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * device_group：tenant 內的設備分組，用於操作員可見性邊界與批次派送。
 *
 * - `code`：tenant 內唯一識別碼（由上游業務系統決定語意，例如學校代碼、部門代碼）
 * - `jamfInstanceId`：可選的 Jamf 實例綁定（1:1），保留供 Jamf 場景使用
 * - 不含使用者 / 學校 / 班級資料；上游業務系統負責這些
 */
export const deviceGroups = pgTable(
  "device_groups",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    code: varchar({ length: 64 }).notNull(),
    displayName: text().notNull(),
    jamfInstanceId: uuid().references(() => jamfInstances.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("device_groups_tenant_idx").on(t.tenantId),
    uniqueIndex("device_groups_tenant_code_uq").on(t.tenantId, t.code),
    // 一個 Jamf instance 最多綁一個 device_group（1:1）；可以為 null 表示尚未綁
    uniqueIndex("device_groups_jamf_instance_uq")
      .on(t.jamfInstanceId)
      .where(sql`${t.jamfInstanceId} IS NOT NULL`),
  ],
);
