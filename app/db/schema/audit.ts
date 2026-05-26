import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.ts";

/**
 * 審計日誌：所有 admin / service-to-service API 操作的完整記錄。
 *
 * 保留期限 1 年（透過定期任務清除 created_at < now() - 365 days）。
 * 支援 CSV 匯出（指定 tenant + 時間範圍）。
 *
 * actor:
 *   - "admin:<email>"     台灣後端傳遞的操作員身份
 *   - "service:<api_key>" 純 service-to-service 呼叫
 *   - "system"            自動任務（webhook 重試、過期清理等）
 *
 * action: 動詞短語，如 "device.transfer"、"profile.assign"、"app.install"
 * resource_type / resource_id: 操作對象
 * payload: 操作前後 diff（before / after）+ 請求 body 摘要
 * request_id: 對應 HTTP request 的追蹤 ID（與錯誤響應一致）
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    actor: text().notNull(),
    action: varchar({ length: 64 }).notNull(),
    resourceType: varchar({ length: 32 }).notNull(),
    resourceId: text(),
    payload: jsonb().$type<Record<string, unknown>>(),
    requestId: varchar({ length: 64 }),
    ip: varchar({ length: 64 }),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_tenant_time_idx").on(t.tenantId, t.createdAt),
    index("audit_logs_resource_idx").on(t.resourceType, t.resourceId),
    index("audit_logs_action_idx").on(t.action),
    // 清理用：找出 365 天前的 row
    index("audit_logs_created_at_idx").on(t.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
