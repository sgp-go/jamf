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
