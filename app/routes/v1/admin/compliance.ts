import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { getDeviceInTenant } from "~/services/devices.ts";
import {
  evaluateCompliance,
  type CompliancePolicy,
} from "~/services/compliance.ts";
import {
  batchEvaluatePolicy,
  createPolicy,
  deletePolicy,
  getDeviceHistory,
  getPolicy,
  listLatestResults,
  listPolicies,
  updatePolicy,
} from "~/services/compliance-batch.ts";

/**
 * Admin Compliance — 對單台 device 即時評估給定政策。
 *
 * MVP 不持久化結果。admin 自己組 CompliancePolicy 物件 POST 過來、
 * 拿到 ComplianceResult。等需要批量定期評估 + 歷史趨勢時再補
 * compliance_policies / device_compliance_status schema。
 */

const security = [{ BearerAuth: [] }];

const tenantDeviceParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
  deviceId: z.string().uuid().openapi({
    param: { name: "deviceId", in: "path" },
    description: "設備 UUID",
    example: "9d4c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c",
  }),
});

const compliancePolicySchema = z
  .object({
    id: z.string().min(1).openapi({
      description: "政策唯一識別碼（自訂）",
      example: "win10-baseline",
    }),
    name: z.string().min(1).openapi({
      description: "政策顯示名稱",
      example: "Windows 10 基線合規",
    }),
    minOSVersion: z.string().optional().openapi({
      description: "dotted-decimal；缺段視為 0（14.5 < 14.5.1）",
      example: "10.0.19045.4170",
    }),
    maxOfflineDays: z.number().positive().optional().openapi({
      description: "now - device.lastSeenAt 超過此值即違規",
      example: 7,
    }),
  })
  .openapi("CompliancePolicy");

const evaluateBody = z
  .object({
    policy: compliancePolicySchema,
  })
  .openapi("EvaluateComplianceInput");

const violationSchema = z
  .object({
    rule: z.enum(["min_os_version", "max_offline_days"]).openapi({
      description: "違反的規則名稱",
    }),
    expected: z.string().openapi({
      description: "政策期望值",
      example: "10.0.19045.4170",
    }),
    actual: z.string().nullable().openapi({
      description: "設備實際值（null 表示無法取得）",
      example: "10.0.19041.0",
    }),
    message: z.string().openapi({
      description: "人類可讀的違規說明",
      example: "OS version 10.0.19041.0 < required 10.0.19045.4170",
    }),
  })
  .openapi("ComplianceViolation");

const complianceResultSchema = z
  .object({
    policyId: z.string(),
    policyName: z.string(),
    compliant: z.boolean().openapi({
      description: "`true` 表示零違規，設備合規",
    }),
    violations: z.array(violationSchema).openapi({
      description: "違規項目清單（合規時為空陣列）",
    }),
    evaluatedAt: z.string().openapi({ description: "評估時間（ISO 8601 UTC）" }),
    device: z.object({
      id: z.string().uuid(),
      osVersion: z.string().nullable().openapi({ description: "設備回報的 OS 版本" }),
      lastSeenAt: z.string().nullable().openapi({ description: "設備最後上線時間" }),
    }),
  })
  .openapi("ComplianceResult");

const evaluateSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/compliance/evaluate",
  tags: ["合規評估"],
  security,
  summary: "即時評估單台設備的合規狀態（不持久化）",
  description: [
    "根據傳入的 `CompliancePolicy` 對象即時評估設備的合規狀態。結果不持久化到資料庫。",
    "",
    "**鑑權**：Bearer admin token。",
    "",
    "**支援的規則**：",
    "- `minOSVersion`：OS 版本下限（dotted-decimal 比較，缺段視為 0）",
    "- `maxOfflineDays`：離線天數上限（now − lastSeenAt）",
    "",
    "後續需要批量定期評估 + 歷史趨勢時再補持久化 schema。",
  ].join("\n"),
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: evaluateBody } } },
  },
  responses: {
    200: {
      description: "合規評估結果（含違規項目清單 + 設備快照）",
      content: {
        "application/json": { schema: successSchema(complianceResultSchema) },
      },
    },
    ...commonErrorResponses,
  },
});

export const complianceAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
complianceAdminApp.use("/admin/*", adminAuth());

complianceAdminApp.openapi(evaluateSpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { policy } = c.req.valid("json");

  const device = await getDeviceInTenant({ tenantId, deviceId });
  const result = evaluateCompliance(
    {
      osVersion: device.osVersion ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
    },
    policy as CompliancePolicy,
  );

  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "compliance.evaluate",
    resourceType: "device",
    resourceId: deviceId,
    payload: {
      policy,
      compliant: result.compliant,
      violationCount: result.violations.length,
    },
  });

  return c.json(
    {
      ok: true as const,
      data: {
        ...result,
        device: {
          id: device.id,
          osVersion: device.osVersion ?? null,
          lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        },
      },
    },
    200,
  );
});

// ============================================================
// 批量政策 CRUD + 批量評估 + 結果查詢(PRD §5.5)
// ============================================================

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({
    param: { name: "tenantId", in: "path" },
    description: "租戶 UUID",
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

const tenantPolicyParam = tenantParam.extend({
  policyId: z.string().uuid().openapi({
    param: { name: "policyId", in: "path" },
    description: "合規政策 UUID",
    example: "00000000-0000-0000-0000-000000000010",
  }),
});

const policyDtoSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    minOSVersion: z.string().nullable(),
    maxOfflineDays: z.number().int().nullable(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("PersistedCompliancePolicy");

const createPolicyBody = z
  .object({
    name: z.string().min(1).max(128).openapi({
      description: "政策顯示名稱(tenant 內唯一)",
      example: "Windows 10 基線合規",
    }),
    description: z.string().nullable().optional().openapi({
      description: "**【選填】** 政策描述",
    }),
    minOSVersion: z.string().nullable().optional().openapi({
      description: "**【選填】** dotted-decimal,最低 OS 版本要求",
      example: "10.0.19045.4170",
    }),
    maxOfflineDays: z.number().int().positive().nullable().optional().openapi({
      description: "**【選填】** 最久允許離線天數",
      example: 7,
    }),
    isActive: z.boolean().default(true).openapi({
      description: "是否啟用(預設 true);僅啟用中的政策會被批量評估",
    }),
  })
  .openapi("CreateCompliancePolicyInput");

const createPolicySpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/compliance-policies",
  tags: ["合規評估"],
  security,
  summary: "建立合規政策",
  description: [
    "建立 tenant 級合規政策(持久化)。後續可用 `POST .../evaluate` 觸發批量評估。",
    "",
    "**鑑權**:Bearer admin token。",
    "",
    "**注意**:`minOSVersion` 與 `maxOfflineDays` 至少要設一項,否則 400。",
  ].join("\n"),
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: createPolicyBody } } },
  },
  responses: {
    201: {
      description: "建立成功,回傳完整政策",
      content: { "application/json": { schema: successSchema(policyDtoSchema) } },
    },
    ...commonErrorResponses,
  },
});

const listPoliciesSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/compliance-policies",
  tags: ["合規評估"],
  security,
  summary: "列出 tenant 下的合規政策",
  description: "回傳該 tenant 全部政策(預設含暫停)。\n\n**鑑權**:Bearer admin token。",
  request: {
    params: tenantParam,
    query: z.object({
      activeOnly: z.string().optional().openapi({
        param: { name: "activeOnly", in: "query" },
        description: "**【選填】** `true` 只列啟用中的政策",
      }),
    }),
  },
  responses: {
    200: {
      description: "政策陣列",
      content: { "application/json": { schema: successSchema(z.array(policyDtoSchema)) } },
    },
    ...commonErrorResponses,
  },
});

const updatePolicyBody = z
  .object({
    name: z.string().min(1).max(128).optional(),
    description: z.string().nullable().optional(),
    minOSVersion: z.string().nullable().optional(),
    maxOfflineDays: z.number().int().positive().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("UpdateCompliancePolicyInput");

const updatePolicySpec = createRoute({
  method: "patch",
  path: "/admin/tenants/{tenantId}/compliance-policies/{policyId}",
  tags: ["合規評估"],
  security,
  summary: "更新合規政策(三態 patch)",
  description: "省略=不動 / null=清空 / 值=寫入。\n\n**鑑權**:Bearer admin token。",
  request: {
    params: tenantPolicyParam,
    body: { content: { "application/json": { schema: updatePolicyBody } } },
  },
  responses: {
    200: {
      description: "更新後的政策",
      content: { "application/json": { schema: successSchema(policyDtoSchema) } },
    },
    ...commonErrorResponses,
  },
});

const deletePolicySpec = createRoute({
  method: "delete",
  path: "/admin/tenants/{tenantId}/compliance-policies/{policyId}",
  tags: ["合規評估"],
  security,
  summary: "刪除合規政策(cascade 清歷史)",
  description: "刪除政策時,FK cascade 一併清掉該政策下所有 `device_compliance_results`。\n\n**鑑權**:Bearer admin token。",
  request: { params: tenantPolicyParam },
  responses: {
    204: { description: "刪除成功" },
    ...commonErrorResponses,
  },
});

const batchSummarySchema = z
  .object({
    policyId: z.string().uuid(),
    evaluatedAt: z.string(),
    total: z.number().int().openapi({ description: "本次評估的設備總數" }),
    compliant: z.number().int().openapi({ description: "合規數" }),
    nonCompliant: z.number().int().openapi({ description: "不合規數" }),
  })
  .openapi("BatchEvaluateSummary");

const batchEvaluateSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/compliance-policies/{policyId}/evaluate",
  tags: ["合規評估"],
  security,
  summary: "批量評估該政策對 tenant 所有設備",
  description: [
    "對該 policy 跑批量評估,持久化結果到 `device_compliance_results`(append-only)。",
    "",
    "**鑑權**:Bearer admin token。",
    "",
    "**處理範圍**:tenant 下所有 `mdm_devices`(無論 enrollment 狀態,osVersion / lastSeenAt 缺失視為違規)。",
    "",
    "**注意**:政策需 `isActive=true`,否則 400。同 policy 重複評估會累積歷史紀錄(supports 趨勢圖)。",
  ].join("\n"),
  request: { params: tenantPolicyParam },
  responses: {
    200: {
      description: "評估完成,回傳統計",
      content: { "application/json": { schema: successSchema(batchSummarySchema) } },
    },
    ...commonErrorResponses,
  },
});

const resultDtoSchema = z
  .object({
    id: z.string().uuid(),
    policyId: z.string().uuid(),
    deviceId: z.string().uuid(),
    compliant: z.boolean(),
    violations: z.array(z.unknown()),
    evaluatedAt: z.string(),
  })
  .openapi("ComplianceResultRow");

const listResultsSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/compliance-policies/{policyId}/results",
  tags: ["合規評估"],
  security,
  summary: "查詢政策最新評估結果(每台設備最近一筆)",
  description: [
    "回傳該政策下**每台設備的最新評估結果**(`DISTINCT ON device_id ORDER BY evaluated_at DESC`)。",
    "",
    "**鑑權**:Bearer admin token。",
    "",
    "**篩選**:`?onlyNonCompliant=true` 只回不合規設備(PRD §5.5「篩選查看所有不合規設備」)。",
  ].join("\n"),
  request: {
    params: tenantPolicyParam,
    query: z.object({
      onlyNonCompliant: z.string().optional().openapi({
        param: { name: "onlyNonCompliant", in: "query" },
        description: "**【選填】** `true` 只回不合規設備",
      }),
    }),
  },
  responses: {
    200: {
      description: "結果陣列",
      content: { "application/json": { schema: successSchema(z.array(resultDtoSchema)) } },
    },
    ...commonErrorResponses,
  },
});

const deviceHistoryParam = tenantParam.extend({
  deviceId: z.string().uuid().openapi({
    param: { name: "deviceId", in: "path" },
    description: "設備 UUID",
  }),
});

const deviceHistorySpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/compliance-history",
  tags: ["合規評估"],
  security,
  summary: "查詢設備合規歷史(時序倒序,跨所有 policy)",
  description: [
    "回傳該設備被評估過的全部紀錄,時序倒序(供 PRD §5.5 趨勢圖)。",
    "",
    "**鑑權**:Bearer admin token。",
    "",
    "**限制**:`limit` 預設 100,最大 500。",
  ].join("\n"),
  request: {
    params: deviceHistoryParam,
    query: z.object({
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "**【選填】** 回傳筆數上限(1-500,預設 100)",
      }),
    }),
  },
  responses: {
    200: {
      description: "歷史陣列(時序倒序)",
      content: { "application/json": { schema: successSchema(z.array(resultDtoSchema)) } },
    },
    ...commonErrorResponses,
  },
});

// ── Handlers ──

complianceAdminApp.openapi(createPolicySpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const input = c.req.valid("json");
  const row = await createPolicy({ tenantId, input });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "compliance_policy.create",
    resourceType: "compliance_policy",
    resourceId: row.id,
    payload: input,
  });
  return c.json({ ok: true as const, data: row }, 201);
});

complianceAdminApp.openapi(listPoliciesSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const { activeOnly } = c.req.valid("query");
  const rows = await listPolicies({
    tenantId,
    activeOnly: activeOnly === "true",
  });
  return c.json({ ok: true as const, data: rows }, 200);
});

complianceAdminApp.openapi(updatePolicySpec, async (c) => {
  const { tenantId, policyId } = c.req.valid("param");
  const patch = c.req.valid("json");
  const row = await updatePolicy({ tenantId, policyId, patch });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "compliance_policy.update",
    resourceType: "compliance_policy",
    resourceId: policyId,
    payload: patch,
  });
  return c.json({ ok: true as const, data: row }, 200);
});

complianceAdminApp.openapi(deletePolicySpec, async (c) => {
  const { tenantId, policyId } = c.req.valid("param");
  await deletePolicy({ tenantId, policyId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "compliance_policy.delete",
    resourceType: "compliance_policy",
    resourceId: policyId,
  });
  return c.body(null, 204);
});

complianceAdminApp.openapi(batchEvaluateSpec, async (c) => {
  const { tenantId, policyId } = c.req.valid("param");
  const summary = await batchEvaluatePolicy({ tenantId, policyId });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "compliance_policy.batch_evaluate",
    resourceType: "compliance_policy",
    resourceId: policyId,
    payload: { ...summary },
  });
  return c.json({ ok: true as const, data: summary }, 200);
});

complianceAdminApp.openapi(listResultsSpec, async (c) => {
  const { tenantId, policyId } = c.req.valid("param");
  const { onlyNonCompliant } = c.req.valid("query");
  const rows = await listLatestResults({
    tenantId,
    policyId,
    onlyNonCompliant: onlyNonCompliant === "true",
  });
  return c.json({ ok: true as const, data: rows }, 200);
});

complianceAdminApp.openapi(deviceHistorySpec, async (c) => {
  const { tenantId, deviceId } = c.req.valid("param");
  const { limit } = c.req.valid("query");
  const parsedLimit = limit ? Math.min(Math.max(1, Number(limit) || 100), 500) : undefined;
  const rows = await getDeviceHistory({ tenantId, deviceId, limit: parsedLimit });
  return c.json({ ok: true as const, data: rows }, 200);
});
