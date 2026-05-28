import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses, successSchema } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
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
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
  deviceId: z.string().uuid().openapi({ param: { name: "deviceId", in: "path" } }),
});

const compliancePolicySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
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
    rule: z.enum(["min_os_version", "max_offline_days"]),
    expected: z.string(),
    actual: z.string().nullable(),
    message: z.string(),
  })
  .openapi("ComplianceViolation");

const complianceResultSchema = z
  .object({
    policyId: z.string(),
    policyName: z.string(),
    compliant: z.boolean(),
    violations: z.array(violationSchema),
    evaluatedAt: z.string(),
    device: z.object({
      id: z.string().uuid(),
      osVersion: z.string().nullable(),
      lastSeenAt: z.string().nullable(),
    }),
  })
  .openapi("ComplianceResult");

const evaluateSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/devices/{deviceId}/compliance/evaluate",
  tags: ["Admin: compliance"],
  security,
  summary: "對指定 device 即時評估合規政策（不持久化）",
  request: {
    params: tenantDeviceParam,
    body: { content: { "application/json": { schema: evaluateBody } } },
  },
  responses: {
    200: {
      description: "Compliance result（compliant=true 表示零違規）",
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
