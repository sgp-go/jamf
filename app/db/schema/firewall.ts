import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { mdmDevices } from "./devices.ts";
import { deviceGroups, tenants } from "./tenants.ts";

/**
 * Firewall Rules（PRD §5.4 防火牆管理）
 *
 * 兩層規則並集：`device_group_id` NULL = tenant-level base rules，
 *              非 NULL = 該學校（device_group）額外 append 的規則。
 * 設備實際生效規則 = tenant rules ∪ 自己所屬 device_group 的 rules。
 *
 * 派發策略：全量替換（backend 記 device.rule_set_hash，變更時 diff old→new
 * 生成 Delete + Add SyncML 命令）。Rule 修改也走 delete + add（CSP 不支援
 * partial Replace）。
 */

export const firewallDirectionEnum = pgEnum("firewall_direction", ["in", "out"]);
export const firewallActionEnum = pgEnum("firewall_action", ["allow", "block"]);
export const firewallProtocolEnum = pgEnum("firewall_protocol", [
  "tcp",
  "udp",
  "any",
]);

export const mdmFirewallRules = pgTable(
  "mdm_firewall_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * NULL = tenant base rule（該 tenant 下所有設備都套用）；
     * 非 NULL = 該 device_group（學校）額外的 rule。
     * 設備最終生效規則 = tenant base ∪ 所屬 group rules。
     */
    deviceGroupId: uuid().references(() => deviceGroups.id, {
      onDelete: "cascade",
    }),
    name: varchar({ length: 64 }).notNull(),
    description: text(),
    direction: firewallDirectionEnum().notNull(),
    action: firewallActionEnum().notNull(),
    protocol: firewallProtocolEnum().notNull().default("any"),
    /** 逗號分隔或範圍："80,443,8000-8100"；null=任意 port */
    localPortRanges: varchar({ length: 256 }),
    remotePortRanges: varchar({ length: 256 }),
    /** 逗號分隔 IP / CIDR："10.0.0.0/8,192.168.1.1"；null=任意 */
    localAddressRanges: varchar({ length: 512 }),
    remoteAddressRanges: varchar({ length: 512 }),
    /** Win32 exe 完整路徑（互斥於 appPackageFamilyName） */
    appFilePath: text(),
    /** UWP PackageFamilyName（互斥於 appFilePath） */
    appPackageFamilyName: text(),
    /** Profile bitmask：1=Domain 2=Private 4=Public；預設 7 = 三 profile 都套 */
    profiles: integer().notNull().default(7),
    enabled: boolean().notNull().default(true),
    createdBy: varchar({ length: 128 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mdm_firewall_rules_tenant_idx").on(t.tenantId),
    index("mdm_firewall_rules_tenant_group_idx").on(t.tenantId, t.deviceGroupId),
  ],
);

/**
 * 每設備當前生效的 firewall rule set 快照。
 * 用於下一次 apply 時 diff old→new，只發 Delete 已刪除的 + Add 新增的。
 * `enforceEnabledAt` 記錄上次強制三 profile enable 的時間（判斷是否需重派）。
 */
export const mdmDeviceFirewallState = pgTable(
  "mdm_device_firewall_state",
  {
    deviceId: uuid()
      .primaryKey()
      .references(() => mdmDevices.id, { onDelete: "cascade" }),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 上次 apply 的 rule id 列表（用於 diff） */
    appliedRuleIds: jsonb().$type<string[]>().notNull().default([]),
    /** 上次生效 rule set 的 sha256 hash（快速判斷是否需重派） */
    ruleSetHash: varchar({ length: 64 }),
    enforceEnabledAt: timestamp({ withTimezone: true }),
    appliedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mdm_device_firewall_state_tenant_idx").on(t.tenantId),
  ],
);

export type MdmFirewallRule = typeof mdmFirewallRules.$inferSelect;
export type NewMdmFirewallRule = typeof mdmFirewallRules.$inferInsert;
export type MdmDeviceFirewallState = typeof mdmDeviceFirewallState.$inferSelect;
