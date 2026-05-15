import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
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
 * school 是設備的物理歸屬單位 + 操作員可見性邊界。
 *
 * - 'school'：一般學校
 * - 'headquarters'：教育部自己的「行政單位 Jamf」也用同一張表，方便聚合查詢
 *
 * jamf_instance_id 是 1:1 對應（school 持有自己的 Jamf 憑據），新建 school 時必填。
 * 暫時設為 nullable，因為 admin onboarding 流程可能先建 school 再建 Jamf 再綁定。
 */
export const schoolKindEnum = pgEnum("school_kind", ["school", "headquarters"]);

export const schools = pgTable(
  "schools",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    code: varchar({ length: 64 }).notNull(),
    displayName: text().notNull(),
    kind: schoolKindEnum().notNull().default("school"),
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
    index("schools_tenant_idx").on(t.tenantId),
    uniqueIndex("schools_tenant_code_uq").on(t.tenantId, t.code),
    // 一個 Jamf instance 最多綁一個 school（1:1）；可以為 null 表示尚未綁
    uniqueIndex("schools_jamf_instance_uq")
      .on(t.jamfInstanceId)
      .where(sql`${t.jamfInstanceId} IS NOT NULL`),
  ],
);
