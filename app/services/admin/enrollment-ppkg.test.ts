import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@^1";
import { renderCustomizationsXml, type RenderContext } from "./enrollment-ppkg.ts";

const baseCtx: RenderContext = {
  tenant: { slug: "demo", displayName: "Demo School" },
  cfg: { publicBaseUrl: "https://mdm.example.com" },
  input: {
    tenantId: "00000000-0000-0000-0000-000000000000",
    upn: "enrollment@demo.example.com",
    secret: "P@ssw0rd!",
  },
};

Deno.test("renderCustomizationsXml: OnPremise（預設）含 Workplace/Enrollments 完整段", () => {
  const xml = renderCustomizationsXml(baseCtx);
  assertStringIncludes(xml, `<UPN UPN="enrollment@demo.example.com" Name="enrollment@demo.example.com">`);
  assertStringIncludes(xml, `<AuthPolicy>OnPremise</AuthPolicy>`);
  assertStringIncludes(
    xml,
    `<DiscoveryServiceFullUrl>https://mdm.example.com/EnrollmentServer/Discovery.svc</DiscoveryServiceFullUrl>`,
  );
  assertStringIncludes(xml, `<Secret>P@ssw0rd!</Secret>`);
});

Deno.test("renderCustomizationsXml: publicBaseUrl trailing slash 不重複", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    cfg: { publicBaseUrl: "https://mdm.example.com/" },
  });
  assertStringIncludes(
    xml,
    "https://mdm.example.com/EnrollmentServer/Discovery.svc",
  );
  // 不該出現 // 雙斜線
  assertEquals(
    xml.includes("https://mdm.example.com//EnrollmentServer"),
    false,
  );
});

Deno.test("renderCustomizationsXml: Name=cogrow-{slug}-{date}", () => {
  const xml = renderCustomizationsXml(baseCtx);
  const m = xml.match(/<Name>(cogrow-demo-\d{4}-\d{2}-\d{2})<\/Name>/);
  assertEquals(m !== null, true);
});

Deno.test("renderCustomizationsXml: displayName 為 null fallback 到 slug", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    tenant: { slug: "demo", displayName: null },
  });
  assertStringIncludes(xml, "for tenant demo</Notes>");
});

Deno.test("renderCustomizationsXml: UPN 含特殊字元正確 escape (XML attribute)", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      upn: `quote"test&lt@domain`,
    },
  });
  assertStringIncludes(xml, `UPN="quote&quot;test&amp;lt@domain"`);
});

Deno.test("renderCustomizationsXml: secret 含 & < > 正確 escape (XML text)", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: { ...baseCtx.input, secret: "p&w<x>!" },
  });
  assertStringIncludes(xml, `<Secret>p&amp;w&lt;x&gt;!</Secret>`);
});

Deno.test("renderCustomizationsXml: authPolicy=Certificate throw 501（未驗證 schema）", () => {
  assertThrows(
    () =>
      renderCustomizationsXml({
        ...baseCtx,
        input: { ...baseCtx.input, authPolicy: "Certificate" },
      }),
    Error,
    "authPolicy=Certificate schema 未經",
  );
});

Deno.test("renderCustomizationsXml: wifi[] 提供 throw 501（未驗證 schema）", () => {
  assertThrows(
    () =>
      renderCustomizationsXml({
        ...baseCtx,
        input: {
          ...baseCtx.input,
          wifi: [{ ssid: "School-WiFi", password: "p" }],
        },
      }),
    Error,
    "WiFi (ConnectivityProfiles/WLANSetting) schema 未經",
  );
});

Deno.test("renderCustomizationsXml: localAccounts[] 提供 throw 501（未驗證 schema）", () => {
  assertThrows(
    () =>
      renderCustomizationsXml({
        ...baseCtx,
        input: {
          ...baseCtx.input,
          localAccounts: [{ username: "student", password: "p", isAdmin: false }],
        },
      }),
    Error,
    "LocalAccounts (Accounts/Users) schema 未經",
  );
});

Deno.test("renderCustomizationsXml: XML 格式骨架正確（PackageConfig + Settings + Customizations）", () => {
  const xml = renderCustomizationsXml(baseCtx);
  assertStringIncludes(xml, `<?xml version="1.0" encoding="utf-8"?>`);
  assertStringIncludes(xml, `<WindowsCustomizations>`);
  assertStringIncludes(xml, `<PackageConfig xmlns="urn:schemas-Microsoft-com:Windows-ICD-Package-Config.v1.0">`);
  assertStringIncludes(xml, `<Settings xmlns="urn:schemas-microsoft-com:windows-provisioning">`);
  assertStringIncludes(xml, `</WindowsCustomizations>`);
});
