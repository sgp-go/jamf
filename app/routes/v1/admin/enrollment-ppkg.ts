import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses } from "~/lib/api.ts";
import { adminAuth } from "~/middleware/admin-auth.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { extractAuditMeta, logAudit } from "~/services/admin/audit.ts";
import { generatePpkgCustomizations } from "~/services/admin/enrollment-ppkg.ts";

/**
 * POST /api/v1/admin/tenants/{tenantId}/enrollment/ppkg-config
 *
 * 生成 USB PPKG 用 customizations.xml（填本 tenant 的 publicBaseUrl + slug；
 * admin 自帶 enrollment 凭据 + 可選 WiFi / 本機帳號）。返回 XML 文本，admin 拿到後
 * SCP 到有 ADK 的 Win10 工具機跑 ICD build 出 .ppkg（見 agent-app/scripts/ppkg/）。
 *
 * 改 POST（原 GET）：要傳 wifi[] / localAccounts[] 陣列，且 secret/password 不該進 URL query。
 *
 * 教育場景一個 PPKG 可一次配齊：
 *   - enrollment：MDM 納管（OnPremise，已驗證）
 *   - wifi：開機自動連校園網（否則 OOBE 要手動連網才能完成納管）
 *   - localAccounts：建學生標準帳號（isAdmin=false → Standard Users）+ IT 管理帳號
 */

const tenantParam = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
});

const wifiSchema = z.object({
  ssid: z.string().min(1).openapi({ example: "Campus-WiFi" }),
  securityType: z.enum(["Open", "WEP", "WPA2-Personal"]).optional().openapi({
    description: "預設 WPA2-Personal；Open 不需 securityKey",
  }),
  securityKey: z.string().optional().openapi({
    description: "WPA2-Personal / WEP 必填；Open 忽略",
  }),
  autoConnect: z.boolean().optional(),
  hidden: z.boolean().optional().openapi({ description: "SSID 是否隱藏（不廣播）" }),
});

const localAccountSchema = z.object({
  username: z.string().min(1).openapi({ example: "student" }),
  password: z.string().min(1),
  isAdmin: z.boolean().optional().openapi({
    description: "true=Administrators；省略/false=Standard Users（學生用）",
  }),
});

const ppkgBody = z.object({
  upn: z.string().min(3).openapi({
    example: "enrollment@school.local",
    description: "Enrollment 服務帳號 UPN（必須含 @），bulk enrollment 用",
  }),
  secret: z.string().min(1).openapi({
    description:
      "OnPremise=password / Certificate=thumbprint / Federated=token；目前固定 OnPremise",
  }),
  authPolicy: z.enum(["OnPremise", "Certificate"]).optional().openapi({
    description: "預設 OnPremise；Certificate 尚未驗證 schema（會回 501）",
  }),
  wifi: z.array(wifiSchema).optional().openapi({
    description: "WiFi profile 清單（PPKG 安裝後預配，OOBE 即自動連網）",
  }),
  localAccounts: z.array(localAccountSchema).optional().openapi({
    description: "本機帳號清單（學生 Standard + IT Admin）",
  }),
});

const ppkgConfigSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/enrollment/ppkg-config",
  tags: ["Admin: install-agent"],
  security: [{ BearerAuth: [] }],
  summary:
    "生成 USB PPKG 用 customizations.xml（enrollment + 可選 WiFi + 本機帳號；含 tenant publicBaseUrl）",
  request: {
    params: tenantParam,
    body: { content: { "application/json": { schema: ppkgBody } } },
  },
  responses: {
    200: {
      description: "customizations.xml 文本（caller 用 ICD build 出 .ppkg）",
      content: {
        "application/xml": {
          schema: z.string().openapi({
            description:
              "Windows Provisioning customization XML（Schema：Common/Workplace/Enrollments + 可選 ConnectivityProfiles/Accounts）",
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
  const body = c.req.valid("json");
  const { xml, filename } = await generatePpkgCustomizations({
    tenantId,
    upn: body.upn,
    secret: body.secret,
    authPolicy: body.authPolicy,
    wifi: body.wifi,
    localAccounts: body.localAccounts,
  });
  await logAudit({
    ...extractAuditMeta(c),
    tenantId,
    action: "enrollment.ppkg_generate",
    resourceType: "tenant",
    resourceId: tenantId,
    // 不記 secret / 帳號密碼 / WiFi 金鑰；只記非敏感摘要供追蹤
    payload: {
      upn: body.upn,
      filename,
      xmlBytes: xml.length,
      wifiCount: body.wifi?.length ?? 0,
      accountCount: body.localAccounts?.length ?? 0,
    },
  });
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(xml, 200);
});
