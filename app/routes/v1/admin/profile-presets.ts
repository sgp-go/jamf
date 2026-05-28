import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { AppError } from "~/lib/errors.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { createProfile } from "~/services/admin/profiles.ts";
import {
  buildBlockedSites,
  buildIESiteZoneAssignment,
} from "~/services/mdm/windows/csp-browser.ts";
import {
  buildDefenderEnforce,
  buildDefenderEnforceAll,
  type DefenderEnforceInput,
} from "~/services/mdm/windows/csp-defender.ts";
import {
  buildUpdatePolicy,
  type UpdatePolicyInput,
} from "~/services/mdm/windows/csp-update.ts";
import type { SyncMLCommand } from "~/services/mdm/windows/syncml.ts";

/**
 * Admin Profile Presets — 高層 API
 *
 * 直接以教育場景語義建立 Windows profile，內部呼叫 W4 csp-* helper 產生
 * SyncMLCommand[]，轉成 profile.payload.csps 後委派 createProfile()。
 *
 * 與 admin/profiles.ts 通用 createProfile 比，preset 路徑：
 *   - 入參更語義化（hosts / DefenderEnforceInput / UpdatePolicyInput），
 *     admin 不必手拼 LocURI / format / data
 *   - 同一語義走同一 helper，避免 admin UI / curl 之間漂移
 *   - LocURI 拼錯（MS schema 偏差）由 helper 單元測試擋下
 */

// ============================================================
// 共用 schema / helpers
// ============================================================

const profileStatusEnum = z.enum(["draft", "active", "archived"]);
const scopeEnum = z.enum(["device", "user"]);

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});

const security = [{ BearerAuth: [] }];

const profileResponseSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    platform: z.literal("windows"),
    displayName: z.string(),
    description: z.string().nullable(),
    payload: z.record(z.unknown()),
    status: profileStatusEnum,
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("PresetProfile");

interface CspEntry {
  path: string;
  verb: string;
  format?: string;
  data?: string;
}

function cmdToCsp(cmd: SyncMLCommand): CspEntry {
  const entry: CspEntry = { path: cmd.target, verb: cmd.verb };
  if (cmd.format !== undefined) entry.format = cmd.format;
  if (cmd.data !== undefined) entry.data = cmd.data;
  return entry;
}

function cmdsToPayload(cmds: SyncMLCommand[]): { csps: CspEntry[] } {
  return { csps: cmds.map(cmdToCsp) };
}

function toProfileDto(row: {
  id: string;
  tenantId: string;
  platform: "apple" | "windows";
  displayName: string;
  description: string | null;
  payload: Record<string, unknown>;
  status: "draft" | "active" | "archived";
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    platform: row.platform as "windows",
    displayName: row.displayName,
    description: row.description,
    payload: row.payload,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ============================================================
// blocked-sites preset
// ============================================================

const blockedSitesBody = z
  .object({
    displayName: z.string().min(1).max(200),
    description: z.string().optional(),
    hosts: z.array(z.string().min(1)).min(1).openapi({
      description: "完整封鎖（Zone 4 Restricted）host 清單。",
      example: ["tiktok.com", "facebook.com"],
    }),
    sites: z
      .array(
        z.object({
          host: z.string().min(1),
          zone: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
        }),
      )
      .optional()
      .openapi({
        description:
          "進階：可指定每個 host 對應 Zone（1=Intranet/2=Trusted/3=Internet/4=Restricted）。" +
          "提供 sites 時忽略 hosts 欄位。",
      }),
    scope: scopeEnum.optional().openapi({
      description: "device（預設）= 全機；user = 當前使用者",
    }),
    status: profileStatusEnum.optional(),
  })
  .openapi("CreateBlockedSitesPreset");

const blockedSitesSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/profile-presets/blocked-sites",
  tags: ["Admin: profile presets"],
  security,
  summary: "建立網站黑名單 profile（IE Site Zone → Edge Chromium 透過 Security Zones 受影響）",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: blockedSitesBody } } },
  },
  responses: {
    201: {
      description: "Profile created",
      content: { "application/json": { schema: successSchema(profileResponseSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ============================================================
// defender preset
// ============================================================

const defenderBody = z
  .object({
    displayName: z.string().min(1).max(200),
    description: z.string().optional(),
    all: z.boolean().optional().openapi({
      description: "true 套用全開預設（Realtime / Behavior / Cloud / IOAV / Network=block / PUA=block）",
    }),
    custom: z
      .object({
        realtimeMonitoring: z.boolean().optional(),
        behaviorMonitoring: z.boolean().optional(),
        cloudProtection: z.boolean().optional(),
        ioavProtection: z.boolean().optional(),
        networkProtection: z
          .union([z.literal(0), z.literal(1), z.literal(2)])
          .optional(),
        puaProtection: z
          .union([z.literal(0), z.literal(1), z.literal(2)])
          .optional(),
        submitSamplesConsent: z
          .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
          .optional(),
      })
      .optional()
      .openapi({
        description: "細項覆蓋；與 all 同時提供時，custom 覆寫對應欄位。",
      }),
    status: profileStatusEnum.optional(),
  })
  .openapi("CreateDefenderPreset");

const defenderSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/profile-presets/defender",
  tags: ["Admin: profile presets"],
  security,
  summary: "建立 Defender 強制啟用 profile",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: defenderBody } } },
  },
  responses: {
    201: {
      description: "Profile created",
      content: { "application/json": { schema: successSchema(profileResponseSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ============================================================
// update-policy preset
// ============================================================

const updateBody = z
  .object({
    displayName: z.string().min(1).max(200),
    description: z.string().optional(),
    policy: z
      .object({
        autoUpdate: z
          .union([
            z.literal(0),
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(4),
            z.literal(5),
          ])
          .optional(),
        scheduledDay: z
          .union([
            z.literal(0),
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(4),
            z.literal(5),
            z.literal(6),
            z.literal(7),
          ])
          .optional(),
        scheduledHour: z.number().int().min(0).max(23).optional(),
        activeHoursStart: z.number().int().min(0).max(23).optional(),
        activeHoursEnd: z.number().int().min(0).max(23).optional(),
        activeHoursMaxRange: z.number().int().min(8).max(18).optional(),
        deferQualityDays: z.number().int().min(0).max(30).optional(),
        deferFeatureDays: z.number().int().min(0).max(365).optional(),
        pauseQuality: z.boolean().optional(),
        pauseFeature: z.boolean().optional(),
      })
      .openapi({
        description: "選填欄位；空物件代表不下任何 Update Policy。",
      }),
    status: profileStatusEnum.optional(),
  })
  .openapi("CreateUpdatePolicyPreset");

const updateSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/profile-presets/update-policy",
  tags: ["Admin: profile presets"],
  security,
  summary: "建立 Windows Update Policy profile（Schedule / Defer / ActiveHours / Pause）",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    201: {
      description: "Profile created",
      content: { "application/json": { schema: successSchema(profileResponseSchema) } },
    },
    ...commonErrorResponses,
  },
});

// ============================================================
// app + handlers
// ============================================================

export const profilePresetsApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
profilePresetsApp.use("/admin/*", adminAuth());

profilePresetsApp.openapi(blockedSitesSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");

  const cmd = body.sites
    ? buildIESiteZoneAssignment({ sites: body.sites, scope: body.scope })
    : buildBlockedSites(body.hosts, body.scope ?? "device");

  const row = await createProfile({
    tenantId,
    platform: "windows",
    displayName: body.displayName,
    description: body.description ?? null,
    payload: cmdsToPayload([cmd]),
    status: body.status,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "preset.create_blocked_sites",
    resourceType: "profile",
    resourceId: row.id,
    payload: {
      hosts: body.hosts,
      sites: body.sites,
      scope: body.scope,
      status: body.status,
    },
  });
  return c.json({ ok: true as const, data: toProfileDto(row) }, 201);
});

profilePresetsApp.openapi(defenderSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");

  const baseCmds = body.all ? buildDefenderEnforceAll() : [];
  const customCmds = body.custom
    ? buildDefenderEnforce(body.custom as DefenderEnforceInput)
    : [];
  // custom 覆蓋同 LocURI 的 baseCmds（後者保留 baseCmds 中未被覆寫的部分）
  const customTargets = new Set(customCmds.map((c) => c.target));
  const merged = [...baseCmds.filter((c) => !customTargets.has(c.target)), ...customCmds];

  if (merged.length === 0) {
    throw new AppError(400, "empty_preset", "至少需提供 all=true 或 custom 任一欄位");
  }

  const row = await createProfile({
    tenantId,
    platform: "windows",
    displayName: body.displayName,
    description: body.description ?? null,
    payload: cmdsToPayload(merged),
    status: body.status,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "preset.create_defender",
    resourceType: "profile",
    resourceId: row.id,
    payload: { all: body.all, custom: body.custom, status: body.status },
  });
  return c.json({ ok: true as const, data: toProfileDto(row) }, 201);
});

profilePresetsApp.openapi(updateSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");

  const cmds = buildUpdatePolicy(body.policy as UpdatePolicyInput);
  if (cmds.length === 0) {
    throw new AppError(400, "empty_preset", "policy 物件需至少一個欄位");
  }

  const row = await createProfile({
    tenantId,
    platform: "windows",
    displayName: body.displayName,
    description: body.description ?? null,
    payload: cmdsToPayload(cmds),
    status: body.status,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "preset.create_update_policy",
    resourceType: "profile",
    resourceId: row.id,
    payload: { policy: body.policy, status: body.status },
  });
  return c.json({ ok: true as const, data: toProfileDto(row) }, 201);
});
