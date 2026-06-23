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
 * SCP 到有 ADK 的 Win10 工具機跑 ICD build 出 .ppkg（見 win-agent-app/scripts/ppkg/）。
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
  deviceGroupId: z.string().uuid().optional().openapi({
    description: [
      "**【選填】** 設備 enroll 後自動歸屬的 device_group UUID（學校）。",
      "**帶值**：PPKG DiscoveryUrl 嵌入 `/g/{group.code}` 段，設備 enroll 時自動寫入 mdm_devices.device_group_id。",
      "**省略**：生成「教育局通用 PPKG」。首次 enroll 設備 device_group_id 落 null（直屬 tenant，後續可透過 PATCH /tenants/{tid}/devices/{did} 分配）；重 enroll 既有設備則**保留原 device_group_id 不變**（避免通用 PPKG 誤清學校歸屬）。想顯式清空既有設備的歸屬，請走 PATCH /tenants/{tid}/devices/{did} body `{deviceGroupId: null}`，不要靠重 enroll。",
      "**校驗**：group 必須屬於同一 tenant（否則 404 device_group_not_found）；group.code 必須符合 [a-z0-9_-]{1,64}（否則 400 device_group_code_not_url_safe）。",
      "**fail-safe**：設備 enroll 時若 PPKG 引用的 group code 已被刪 / 改名，後端保留設備既有 device_group_id（首次 enroll 則為 null），不阻斷 enrollment，server 寫 warn log。",
    ].join("\n\n"),
    example: "a1b2c3d4-5e6f-7a8b-9c0d-e1f2a3b4c5d6",
  }),
  upn: z.string().min(3).openapi({
    example: "enrollment@school.local",
    description: "Enrollment 服務帳號 UPN（必須含 @），bulk enrollment 用",
  }),
  secret: z.string().min(1).openapi({
    description:
      "OnPremise=password / Certificate=thumbprint / Federated=token；目前固定 OnPremise",
  }),
  authPolicy: z.enum(["OnPremise", "Certificate"]).optional().openapi({
    description: "**【選填】** 預設 OnPremise；Certificate 尚未驗證 schema（會回 501）",
  }),
  wifi: z.array(wifiSchema).optional().openapi({
    description: "**【選填】** WiFi profile 清單（PPKG 安裝後預配，OOBE 即自動連網）",
  }),
  localAccounts: z.array(localAccountSchema).optional().openapi({
    description: "**【選填】** 本機帳號清單（學生 Standard + IT Admin）",
  }),
});

const ppkgConfigSpec = createRoute({
  method: "post",
  path: "/admin/tenants/{tenantId}/enrollment/ppkg-config",
  tags: ["批次註冊"],
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
    deviceGroupId: body.deviceGroupId,
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
      deviceGroupId: body.deviceGroupId ?? null,
    },
  });
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(xml, 200);
});
