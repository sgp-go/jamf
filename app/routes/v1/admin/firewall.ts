import { and, desc, eq, isNull, or } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  commonErrorResponses,
  deviceIdParam,
  successSchema,
  tenantIdParam,
} from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { db } from "~/db/client.ts";
import { mdmFirewallRules } from "~/db/schema/firewall.ts";
import { applyFirewallToDevice } from "~/services/firewall.ts";

/**
 * /api/v1/admin/tenants/{tenantId}/firewall/*
 *
 * Firewall Rules 管理（PRD §5.4）：
 * - Rules CRUD（tenant base rules + device_group scoped rules；設備最終規則 = 並集）
 * - Apply to device：全量替換派發，含 enforce-enabled + 差異命令
 */

// ── Schema ──

const directionEnum = z.enum(["in", "out"]).openapi({
  description: "in=入站；out=出站",
});
const actionEnum = z.enum(["allow", "block"]).openapi({
  description: "allow=允許；block=阻擋",
});
const protocolEnum = z.enum(["tcp", "udp", "any"]).openapi({
  description: "tcp / udp / any（省略 = 任意 protocol）",
});

const firewallRuleSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    deviceGroupId: z.string().uuid().nullable().openapi({
      description:
        "**【選填】** NULL = tenant base rule 全 tenant 生效；非 NULL = 只在指定 device_group 額外套用",
    }),
    name: z.string().openapi({
      description: "規則顯示名（GUI 可見；限 64 字）",
      example: "Block Steam outbound",
    }),
    description: z.string().nullable().openapi({
      description: "**【選填】** 規則描述備註",
    }),
    direction: directionEnum,
    action: actionEnum,
    protocol: protocolEnum,
    localPortRanges: z.string().nullable().openapi({
      description:
        "**【選填】** 本機 port，逗號分隔或範圍：\"80,443,8000-8100\"；null=任意",
    }),
    remotePortRanges: z.string().nullable().openapi({
      description: "**【選填】** 遠端 port（同 localPortRanges 格式）",
    }),
    localAddressRanges: z.string().nullable().openapi({
      description: "**【選填】** 本機 IP / CIDR：\"10.0.0.0/8,192.168.1.1\"",
    }),
    remoteAddressRanges: z.string().nullable().openapi({
      description: "**【選填】** 遠端 IP / CIDR",
    }),
    appFilePath: z.string().nullable().openapi({
      description:
        "**【選填】** Win32 exe 完整路徑，如 `C:\\Program Files\\Steam\\Steam.exe`；與 appPackageFamilyName 互斥",
    }),
    appPackageFamilyName: z.string().nullable().openapi({
      description: "**【選填】** UWP PackageFamilyName；與 appFilePath 互斥",
    }),
    profiles: z.number().int().openapi({
      description: "Profile bitmask：1=Domain 2=Private 4=Public，預設 7（三 profile 都套用）",
      example: 7,
    }),
    enabled: z.boolean().openapi({
      description: "false=保留在 DB 但不下發；用於暫時停用某規則",
    }),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("FirewallRule");

const createRuleBody = z
  .object({
    deviceGroupId: z.string().uuid().nullable().optional().openapi({
      description:
        "**【選填】** NULL 或省略 = tenant base rule；填 group UUID = 該學校額外規則",
    }),
    name: z.string().min(1).max(64).openapi({
      description: "規則顯示名",
      example: "Block Steam",
    }),
    description: z.string().nullable().optional().openapi({
      description: "**【選填】** 描述備註",
    }),
    direction: directionEnum,
    action: actionEnum,
    protocol: protocolEnum.optional().openapi({
      description: "**【選填】** 預設 any",
    }),
    localPortRanges: z.string().max(256).nullable().optional().openapi({
      description: "**【選填】** 本機 port",
    }),
    remotePortRanges: z.string().max(256).nullable().optional().openapi({
      description: "**【選填】** 遠端 port",
    }),
    localAddressRanges: z.string().max(512).nullable().optional().openapi({
      description: "**【選填】** 本機 IP / CIDR",
    }),
    remoteAddressRanges: z.string().max(512).nullable().optional().openapi({
      description: "**【選填】** 遠端 IP / CIDR",
    }),
    appFilePath: z.string().nullable().optional().openapi({
      description: "**【選填】** Win32 exe 路徑；與 appPackageFamilyName 互斥",
    }),
    appPackageFamilyName: z.string().nullable().optional().openapi({
      description: "**【選填】** UWP PFN；與 appFilePath 互斥",
    }),
    profiles: z.number().int().min(1).max(7).optional().openapi({
      description:
        "**【選填】** Profile bitmask 1-7，預設 7；1=Domain 2=Private 4=Public",
    }),
    enabled: z.boolean().optional().openapi({
      description: "**【選填】** 預設 true",
    }),
  })
  .openapi("CreateFirewallRuleInput");

const patchRuleBody = createRuleBody.partial().openapi(
  "UpdateFirewallRuleInput",
);

const listQuery = z.object({
  deviceGroupId: z.string().uuid().optional().openapi({
    description:
      "**【選填】** 篩選：僅列該 group 的 rules；省略則列 tenant + 全部 group 的 rules",
  }),
});

const ruleIdParam = tenantIdParam.extend({
  ruleId: z.string().uuid().openapi({
    param: { name: "ruleId", in: "path" },
    description: "Firewall rule UUID",
  }),
});

const applyResultSchema = z
  .object({
    deviceId: z.string().uuid(),
    skipped: z.boolean().openapi({
      description: "true = rule set 與上次一致且 enforce-enabled 已推過，未送任何命令",
    }),
    reason: z.string().nullable().openapi({
      description: "skipped 時的原因；否則 null",
    }),
    effectiveRuleCount: z.number().int().openapi({
      description: "此設備當前生效規則數量（tenant + group 並集後、enabled=true 部分）",
    }),
    commandIds: z.array(z.string().uuid()).openapi({
      description: "本次派發的 mdm_commands UUID 列表（skipped=true 時為空）",
    }),
    ruleSetHash: z.string().openapi({
      description: "生效規則集 sha256 hash",
    }),
  })
  .openapi("FirewallApplyResult");

// ── Routes ──

const createRuleSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/firewall/rules",
  tags: ["Admin: Firewall"],
  security: [{ BearerAuth: [] }],
  summary: "建立 Firewall Rule",
  description: [
    "在 tenant 或 device_group 層級建立一條防火牆規則。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**兩層並集語義**：`deviceGroupId=null` 表示 tenant base rule（全 tenant 生效）；",
    "填入 group UUID 則該學校額外套用。單台設備最終規則 = tenant base ∪ 所屬 group rules。",
    "",
    "**注意事項**：",
    "- 建立後**不自動派發**到設備。需另外呼叫 `/devices/{did}/firewall/apply`",
    "  或等下次 apply 觸發。",
    "- `appFilePath` 與 `appPackageFamilyName` 互斥；若同時指定會 400。",
  ].join("\n"),
  request: {
    params: tenantIdParam,
    body: { content: { "application/json": { schema: createRuleBody } } },
  },
  responses: {
    201: {
      description: "建立成功，回傳完整 rule 物件",
      content: { "application/json": { schema: successSchema(firewallRuleSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listRulesSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/firewall/rules",
  tags: ["Admin: Firewall"],
  security: [{ BearerAuth: [] }],
  summary: "列出 Firewall Rules",
  description: [
    "回傳 tenant 下的規則列表。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**篩選**：",
    "- 省略 `deviceGroupId` → 回傳 tenant 全部 rules（包含 base + 所有 group）",
    "- 帶 `deviceGroupId` → 只回傳該 group 額外規則（不含 tenant base）",
  ].join("\n"),
  request: { params: tenantIdParam, query: listQuery },
  responses: {
    200: {
      description: "規則列表（按 createdAt 降序）",
      content: {
        "application/json": {
          schema: successSchema(z.array(firewallRuleSchema)),
        },
      },
    },
    ...commonErrorResponses,
  },
});

const patchRuleSpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/firewall/rules/{ruleId}",
  tags: ["Admin: Firewall"],
  security: [{ BearerAuth: [] }],
  summary: "更新 Firewall Rule",
  description: [
    "部分更新規則欄位；未傳的欄位保持不動。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**注意**：更新後**不自動派發**；下次 `firewall/apply` 才會反映到設備。",
  ].join("\n"),
  request: {
    params: ruleIdParam,
    body: { content: { "application/json": { schema: patchRuleBody } } },
  },
  responses: {
    200: {
      description: "更新成功，回傳更新後 rule",
      content: { "application/json": { schema: successSchema(firewallRuleSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deleteRuleSpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/firewall/rules/{ruleId}",
  tags: ["Admin: Firewall"],
  security: [{ BearerAuth: [] }],
  summary: "刪除 Firewall Rule",
  description: [
    "從 DB 刪除規則。**下次 apply 時**才會從設備側刪除（Delete SyncML）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**不可逆**：刪除後無 undo；若只是暫停使用建議 PATCH `enabled=false`。",
  ].join("\n"),
  request: { params: ruleIdParam },
  responses: {
    204: { description: "刪除成功，無 body" },
    ...commonErrorResponses,
  },
});

const applyBody = z
  .object({
    enforceEnabled: z.boolean().optional().openapi({
      description:
        "**【選填】** 預設 true，同時派「三 profile 保持 EnableFirewall=1」政策",
    }),
  })
  .openapi("FirewallApplyInput");

const applySpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/firewall/apply",
  tags: ["Admin: Firewall"],
  security: [{ BearerAuth: [] }],
  summary: "派發 Firewall Rules 到設備（全量替換 + enforce-enabled）",
  description: [
    "計算設備最終生效規則（tenant base ∪ 所屬 device_group rules），",
    "與上次 apply 快照做 diff：刪除已移除的 rule + 新增所有當前 rules。",
    "同時可選派「保持三 profile 開啟」政策（預設一起派）。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**幂等**：backend 記 `rule_set_hash`，同 hash 再次呼叫回傳 `skipped=true`，不派命令。",
    "",
    "**注意事項**：",
    "- 平台限 Windows；Apple / iOS 回 400。",
    "- 全量替換：Delete 上次全部 + Add 當前全部（含未變化的 rule），確保設備端狀態收斂。",
    "- 若當前 rule 集為空，只派 enforce-enabled（保持防火牆開）。",
  ].join("\n"),
  request: {
    params: deviceIdParam,
    body: { content: { "application/json": { schema: applyBody } } },
  },
  responses: {
    200: {
      description: "派發完成（可能因 hash 未變 skipped）",
      content: { "application/json": { schema: successSchema(applyResultSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ── Handlers ──

export const firewallAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
firewallAdminApp.use("/admin/*", adminAuth());

firewallAdminApp.openapi(createRuleSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  if (body.appFilePath && body.appPackageFamilyName) {
    throw new AppError(
      400,
      "app_target_conflict",
      "appFilePath 與 appPackageFamilyName 互斥",
    );
  }
  const [row] = await db
    .insert(mdmFirewallRules)
    .values({
      tenantId,
      deviceGroupId: body.deviceGroupId ?? null,
      name: body.name,
      description: body.description ?? null,
      direction: body.direction,
      action: body.action,
      protocol: body.protocol ?? "any",
      localPortRanges: body.localPortRanges ?? null,
      remotePortRanges: body.remotePortRanges ?? null,
      localAddressRanges: body.localAddressRanges ?? null,
      remoteAddressRanges: body.remoteAddressRanges ?? null,
      appFilePath: body.appFilePath ?? null,
      appPackageFamilyName: body.appPackageFamilyName ?? null,
      profiles: body.profiles ?? 7,
      enabled: body.enabled ?? true,
      createdBy: extractAuditMeta(c).actor,
    })
    .returning();
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "firewall.rule.create",
    resourceType: "firewall_rule",
    resourceId: row.id,
    payload: { name: row.name, direction: row.direction, action: row.action },
  });
  return c.json({ ok: true as const, data: toDto(row) }, 201);
});

firewallAdminApp.openapi(listRulesSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const { deviceGroupId } = c.req.valid("query");
  const whereClause = deviceGroupId
    ? and(
      eq(mdmFirewallRules.tenantId, tenantId),
      eq(mdmFirewallRules.deviceGroupId, deviceGroupId),
    )
    : eq(mdmFirewallRules.tenantId, tenantId);
  const rows = await db
    .select()
    .from(mdmFirewallRules)
    .where(whereClause!)
    .orderBy(desc(mdmFirewallRules.createdAt));
  return c.json({ ok: true as const, data: rows.map(toDto) }, 200);
});

firewallAdminApp.openapi(patchRuleSpec, async (c) => {
  const { tenantId, ruleId } = c.req.valid("param");
  const patch = c.req.valid("json");
  const existing = await db.query.mdmFirewallRules.findFirst({
    where: and(
      eq(mdmFirewallRules.id, ruleId),
      eq(mdmFirewallRules.tenantId, tenantId),
    ),
  });
  if (!existing) {
    throw new AppError(404, "rule_not_found", `Rule ${ruleId} 不存在`);
  }
  const finalAppFile = patch.appFilePath !== undefined
    ? patch.appFilePath
    : existing.appFilePath;
  const finalAppPfn = patch.appPackageFamilyName !== undefined
    ? patch.appPackageFamilyName
    : existing.appPackageFamilyName;
  if (finalAppFile && finalAppPfn) {
    throw new AppError(
      400,
      "app_target_conflict",
      "appFilePath 與 appPackageFamilyName 互斥",
    );
  }
  const [updated] = await db
    .update(mdmFirewallRules)
    .set({
      ...(patch.deviceGroupId !== undefined
        ? { deviceGroupId: patch.deviceGroupId }
        : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
      ...(patch.action !== undefined ? { action: patch.action } : {}),
      ...(patch.protocol !== undefined ? { protocol: patch.protocol } : {}),
      ...(patch.localPortRanges !== undefined
        ? { localPortRanges: patch.localPortRanges }
        : {}),
      ...(patch.remotePortRanges !== undefined
        ? { remotePortRanges: patch.remotePortRanges }
        : {}),
      ...(patch.localAddressRanges !== undefined
        ? { localAddressRanges: patch.localAddressRanges }
        : {}),
      ...(patch.remoteAddressRanges !== undefined
        ? { remoteAddressRanges: patch.remoteAddressRanges }
        : {}),
      ...(patch.appFilePath !== undefined
        ? { appFilePath: patch.appFilePath }
        : {}),
      ...(patch.appPackageFamilyName !== undefined
        ? { appPackageFamilyName: patch.appPackageFamilyName }
        : {}),
      ...(patch.profiles !== undefined ? { profiles: patch.profiles } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(eq(mdmFirewallRules.id, ruleId))
    .returning();
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "firewall.rule.update",
    resourceType: "firewall_rule",
    resourceId: ruleId,
    payload: patch,
  });
  return c.json({ ok: true as const, data: toDto(updated) }, 200);
});

firewallAdminApp.openapi(deleteRuleSpec, async (c) => {
  const { tenantId, ruleId } = c.req.valid("param");
  const deleted = await db
    .delete(mdmFirewallRules)
    .where(
      and(
        eq(mdmFirewallRules.id, ruleId),
        eq(mdmFirewallRules.tenantId, tenantId),
      ),
    )
    .returning({ id: mdmFirewallRules.id });
  if (deleted.length === 0) {
    throw new AppError(404, "rule_not_found", `Rule ${ruleId} 不存在`);
  }
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "firewall.rule.delete",
    resourceType: "firewall_rule",
    resourceId: ruleId,
  });
  return c.body(null, 204);
});

firewallAdminApp.openapi(applySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await applyFirewallToDevice({
    deviceId,
    enforceEnabled: body.enforceEnabled ?? true,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "firewall.apply",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      skipped: result.skipped,
      reason: result.reason ?? null,
      effectiveRuleCount: result.effectiveRuleCount,
      commandCount: result.commandUuids.length,
      ruleSetHash: result.ruleSetHash,
    },
  });
  return c.json(
    {
      ok: true as const,
      data: {
        deviceId: result.deviceId,
        skipped: result.skipped,
        reason: result.reason ?? null,
        effectiveRuleCount: result.effectiveRuleCount,
        commandIds: result.commandUuids,
        ruleSetHash: result.ruleSetHash,
      },
    },
    200,
  );
});

function toDto(row: typeof mdmFirewallRules.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
