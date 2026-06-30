import { sql } from "drizzle-orm";
import {
  bigint,
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
import { asmInstances } from "./asm.ts";
import { mdmDevices, platformEnum } from "./devices.ts";
import { deviceGroups, tenants } from "./tenants.ts";

/**
 * App 派發類型：
 *   msi          - Windows .msi 安裝包，走 EnterpriseDesktopAppManagement CSP
 *   exe          - Windows .exe（通常包成 MSI Wrapper 後派發）
 *   msix         - Windows MSIX/AppX 包，走 EnterpriseModernAppManagement CSP
 *   winget       - Windows 公共/私有源軟體，由 Agent 端 winget.exe 安裝（不上傳二進制）
 *   ipa_custom   - iOS Custom App via ABM/ASM，用 iTunesStoreID 派發
 *   mobileconfig - iOS Profile（.mobileconfig），這層只記錄安裝包，實際派發走 profiles 表
 */
export const appKindEnum = pgEnum("app_kind", [
  "msi",
  "exe",
  "msix",
  "winget",
  "ipa_custom",
  "mobileconfig",
]);

export const appAssignmentScopeEnum = pgEnum("app_assignment_scope", [
  "device_group",
  "device",
]);

export const appAssignmentStatusEnum = pgEnum("app_assignment_status", [
  "pending",
  "installing",
  "installed",
  "failed",
  "removed",
]);

/**
 * 上傳到平台的 App 安裝包。
 *
 * - 平台側 host：file_url 是我方平台 HTTPS URL（指向 cdn / object storage）
 * - iOS Custom App：file_url 可為空，靠 itunes_store_id 派發
 * - file_hash：SHA-256，EDA-CSP / MSIX install 命令會帶上做完整性驗證
 * - signed_by：簽名者識別（如 "CoGrow Code Signing"），方便審計
 * - tenantId 可為 null：null 代表「全平台共用 App」（如 Aspira Agent），所有 tenant 都能派發
 */
export const apps = pgTable(
  "apps",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().references(() => tenants.id, { onDelete: "cascade" }),
    platform: platformEnum().notNull(),
    kind: appKindEnum().notNull(),
    displayName: text().notNull(),
    bundleId: varchar({ length: 256 }),
    version: varchar({ length: 64 }).notNull(),
    fileUrl: text(),
    fileHash: varchar({ length: 128 }),
    fileSizeBytes: bigint({ mode: "number" }),
    signedBy: text(),
    installArgs: text(),
    iTunesStoreId: bigint({ mode: "number" }),

    // App 分類管理（PRD §5.3 — 例如 teaching / system_tools / office）
    // 自由字串（前端做 dropdown），不強約束 enum 避免擴展受限
    category: varchar({ length: 32 }),

    // 授權數量管理（PRD §5.3）
    // licenseCount=null 視為「無限制」；其它整數為總授權數
    // 已派發數量由 app_assignments 計算（status IN installing/installed），不冗餘存
    licenseCount: integer(),
    licenseNotes: text(),

    // winget 派發專用（kind=winget 時必填，其他 kind 留 null）
    // wingetId 例：`Microsoft.VisualStudioCode`、`7zip.7zip`
    // wingetSource 預設 `winget`（公共 source）；可選 `msstore` 或 `cogrow-{tenantSlug}`（未來私有 REST source）
    wingetId: varchar({ length: 256 }),
    wingetSource: varchar({ length: 64 }),

    metadata: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("apps_tenant_idx").on(t.tenantId),
    index("apps_platform_kind_idx").on(t.platform, t.kind),
    index("apps_bundle_id_idx").on(t.bundleId),
    index("apps_category_idx").on(t.category),
    index("apps_winget_id_idx").on(t.wingetId),
    uniqueIndex("apps_tenant_bundle_version_uq")
      .on(t.tenantId, t.bundleId, t.version)
      .where(sql`${t.bundleId} IS NOT NULL`),
    // 同 tenant 內同 wingetId 唯一（避免同個包重複上架）
    uniqueIndex("apps_tenant_winget_id_uq")
      .on(t.tenantId, t.wingetId)
      .where(sql`${t.wingetId} IS NOT NULL`),
  ],
);

/**
 * App × (device_group | device) 指派關係。
 * 同一個 app 可指派到多個 group/device，同一個 group/device 可承載多個 app。
 *
 * scope: device_group → 該組所有設備繼承；device → 單台指派（覆蓋分組策略）
 * status: 由 MDM 命令回報結果驅動
 */
export const appAssignments = pgTable(
  "app_assignments",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().notNull().references(() => tenants.id, { onDelete: "cascade" }),
    appId: uuid()
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    scope: appAssignmentScopeEnum().notNull(),
    deviceGroupId: uuid().references(() => deviceGroups.id, { onDelete: "cascade" }),
    deviceId: uuid().references(() => mdmDevices.id, { onDelete: "cascade" }),
    status: appAssignmentStatusEnum().notNull().default("pending"),
    lastCommandId: uuid(),
    errorMessage: text(),
    assignedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    installedAt: timestamp({ withTimezone: true }),
    removedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("app_assignments_app_idx").on(t.appId),
    index("app_assignments_device_group_idx").on(t.deviceGroupId),
    index("app_assignments_device_idx").on(t.deviceId),
    index("app_assignments_status_idx").on(t.status),
    uniqueIndex("app_assignments_app_group_uq")
      .on(t.appId, t.deviceGroupId)
      .where(sql`${t.scope} = 'device_group' AND ${t.deviceGroupId} IS NOT NULL`),
    uniqueIndex("app_assignments_app_device_uq")
      .on(t.appId, t.deviceId)
      .where(sql`${t.scope} = 'device' AND ${t.deviceId} IS NOT NULL`),
  ],
);

/**
 * iOS Custom App 在 ABM/ASM cross-organization 派發的授權狀態。
 *
 * 對應流程：我方 App Store Connect → Authorized Organizations → 加入對方 Org ID。
 * 此表追蹤每個 (app, asm_instance) 配對的授權狀態。
 *
 * status:
 *   not_requested - 還沒在 App Store Connect 加入
 *   pending       - 已加入但 Apple 尚未同步到對方 ASM 後台（< 24h）
 *   authorized    - 已生效，對方 ASM 可拉
 *   removed       - 已從 Authorized Organizations 列表移除
 */
export const customAppAuthorizationStatusEnum = pgEnum(
  "custom_app_authorization_status",
  ["not_requested", "pending", "authorized", "removed"],
);

export const customAppAuthorizations = pgTable(
  "custom_app_authorizations",
  {
    id: uuid().primaryKey().defaultRandom(),
    appId: uuid()
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    asmInstanceId: uuid()
      .notNull()
      .references(() => asmInstances.id, { onDelete: "cascade" }),
    status: customAppAuthorizationStatusEnum().notNull().default("not_requested"),
    authorizedAt: timestamp({ withTimezone: true }),
    removedAt: timestamp({ withTimezone: true }),
    notes: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("custom_app_auth_app_idx").on(t.appId),
    index("custom_app_auth_asm_idx").on(t.asmInstanceId),
    uniqueIndex("custom_app_auth_app_asm_uq").on(t.appId, t.asmInstanceId),
  ],
);

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
export type AppAssignment = typeof appAssignments.$inferSelect;
export type CustomAppAuthorization = typeof customAppAuthorizations.$inferSelect;
