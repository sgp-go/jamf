import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { generatePpkgCustomizations } from "~/services/admin/enrollment-ppkg.ts";

/**
 * GET /api/v1/admin/tenants/{tenantId}/enrollment/ppkg-config
 *
 * 生成 USB PPKG 用 customizations.xml（填本 tenant 的 publicBaseUrl + slug；
 * admin 自帶 upn + secret query 不持久化）。返回 XML 文本，admin 拿到後 SCP 到
 * Win10 工具機跑 ICD build 出 .ppkg（見 agent-app/scripts/ppkg/build-ppkg.ps1）。
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});

const ppkgQuery = z.object({
  upn: z.string().min(3).openapi({
    example: "enrollment@school.local",
    description: "Enrollment 服務帳號 UPN（必須含 @），bulk enrollment 用",
  }),
  secret: z.string().min(1).openapi({
    description:
      "OnPremise=password / Certificate=thumbprint / Federated=token；目前固定 OnPremise",
  }),
});

const ppkgConfigSpec = createRoute({
  method: "get",
  path: "/admin/tenants/{tenantId}/enrollment/ppkg-config",
  tags: ["Admin: install-agent"],
  security: [{ BearerAuth: [] }],
  summary: "生成 USB PPKG 用 customizations.xml（含 tenant publicBaseUrl + admin 帶 enrollment 凭据）",
  request: { params: tenantParam, query: ppkgQuery },
  responses: {
    200: {
      description: "customizations.xml 文本（caller 用 ICD build 出 .ppkg）",
      content: {
        "application/xml": {
          schema: z.string().openapi({
            description:
              "Windows Provisioning customization XML（Schema：Common/Workplace/Enrollments）",
          }),
        },
      },
    },
    ...commonErrorResponses,
  },
});

export const enrollmentPpkgAdminApp = new OpenAPIHono({
  defaultHook: validationFailedHook,
});
enrollmentPpkgAdminApp.use("/admin/*", adminAuth());

enrollmentPpkgAdminApp.openapi(ppkgConfigSpec, async (c) => {
  const { tenantId } = c.req.valid("param");
  const { upn, secret } = c.req.valid("query");
  const { xml, filename } = await generatePpkgCustomizations({
    tenantId,
    upn,
    secret,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "enrollment.ppkg_generate",
    resourceType: "tenant",
    resourceId: tenantId,
    // 不記 secret；只記 upn + xml size 供追蹤
    payload: { upn, filename, xmlBytes: xml.length },
  });
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(xml, 200);
});
