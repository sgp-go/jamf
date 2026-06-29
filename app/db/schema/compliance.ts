/**
 * 合規政策 + 批量評估歷史(PRD §5.5)。
 *
 * 設計動機:既有 evaluateCompliance 是純函式單台即時評估,無持久化。台灣團隊管理介面
 * 需要(a) 政策 CRUD、(b) 批量評估後篩出不合規設備清單、(c) 設備歷史趨勢。
 *
 * Schema 分兩表:
 *   - compliance_policies:政策定義(tenant 維護)
 *   - device_compliance_results:每次評估快照(append-only,設備 × 政策 × 評估時間)
 *
 * 評估後不刪舊紀錄,歷史保留供趨勢圖。資料保留清理走 pg_cron(audit-webhook-retention
 * 同一機制,延後配置)。
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { mdmDevices } from "./devices.ts";
import { tenants } from "./tenants.ts";

/**
 * 合規政策定義。
 * MVP 規則限於 minOSVersion / maxOfflineDays(對應 evaluateCompliance 引擎)。
 */
export const compliancePolicies = pgTable(
  "compliance_policies",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar({ length: 128 }).notNull(),
    description: text(),
    /** dotted-decimal,如 "10.0.19045.4170" / "14.5";null = 不檢查 */
    minOsVersion: varchar({ length: 64 }),
    /** 小數允許;null = 不檢查 */
    maxOfflineDays: integer(),
    /** 啟用中的政策才會被批量評估;false=暫停 */
    isActive: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("compliance_policies_tenant_idx").on(t.tenantId),
    index("compliance_policies_active_idx").on(t.isActive),
    uniqueIndex("compliance_policies_tenant_name_uq").on(t.tenantId, t.name),
  ],
);

/**
 * 單次評估結果(append-only)。
 *
 * 每次 batch evaluate 會為每台符合範圍的設備寫一筆 row(無論合規與否),
 * 這樣歷史趨勢可以畫「合規率隨時間變化」。
 *
 * violations 是 jsonb,保留完整 ComplianceViolation[] 結構供後續查詢。
 */
export const deviceComplianceResults = pgTable(
  "device_compliance_results",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    policyId: uuid()
      .notNull()
      .references(() => compliancePolicies.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    compliant: boolean().notNull(),
    /** ComplianceViolation[] JSON。空陣列表示完全合規 */
    violations: jsonb().$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    evaluatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 查 tenant 某 policy 的最新結果(批量列表)
    index("compliance_results_tenant_policy_evaluated_idx")
      .on(t.tenantId, t.policyId, t.evaluatedAt.desc()),
    // 查 device 的歷史紀錄(趨勢圖)
    index("compliance_results_device_evaluated_idx").on(
      t.deviceId,
      t.evaluatedAt.desc(),
    ),
    // 篩 unique device 最新一筆: (policy, device) DESC by evaluatedAt
    index("compliance_results_policy_device_evaluated_idx")
      .on(t.policyId, t.deviceId, t.evaluatedAt.desc()),
  ],
);

export type CompliancePolicy = typeof compliancePolicies.$inferSelect;
export type NewCompliancePolicy = typeof compliancePolicies.$inferInsert;
export type DeviceComplianceResult = typeof deviceComplianceResults.$inferSelect;
export type NewDeviceComplianceResult =
  typeof deviceComplianceResults.$inferInsert;
