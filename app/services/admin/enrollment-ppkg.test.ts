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

// ──────────────────────────────────────────────────────────────
// WiFi 段 — 2026-05-28 Win10 ICD GUI export 反向工程 schema
// ──────────────────────────────────────────────────────────────

Deno.test("renderCustomizationsXml: WiFi 單個 WPA2-Personal SSID 完整段", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      wifi: [{ ssid: "SchoolWiFi", securityKey: "test12345" }],
    },
  });
  assertStringIncludes(xml, `<ConnectivityProfiles>`);
  assertStringIncludes(xml, `<WLAN>`);
  assertStringIncludes(xml, `<WLANSetting>`);
  assertStringIncludes(xml, `<WLANConfig SSID="SchoolWiFi" Name="SchoolWiFi">`);
  assertStringIncludes(xml, `<WLANXmlSettings>`);
  assertStringIncludes(xml, `<AutoConnect>True</AutoConnect>`);
  assertStringIncludes(xml, `<HiddenNetwork>False</HiddenNetwork>`);
  assertStringIncludes(xml, `<SecurityKey>test12345</SecurityKey>`);
  assertStringIncludes(xml, `<SecurityType>WPA2-Personal</SecurityType>`);
});

Deno.test("renderCustomizationsXml: WiFi Open 不應出現 SecurityKey 元素", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      wifi: [{ ssid: "OpenGuest", securityType: "Open" }],
    },
  });
  assertStringIncludes(xml, `<WLANConfig SSID="OpenGuest"`);
  assertStringIncludes(xml, `<SecurityType>Open</SecurityType>`);
  assertEquals(xml.includes("<SecurityKey>"), false);
});

Deno.test("renderCustomizationsXml: WiFi WPA2-Personal 缺 securityKey throw 400", () => {
  assertThrows(
    () =>
      renderCustomizationsXml({
        ...baseCtx,
        input: {
          ...baseCtx.input,
          wifi: [{ ssid: "ForgotPassword" }], // 預設 WPA2-Personal，但無 key
        },
      }),
    Error,
    "securityKey",
  );
});

Deno.test("renderCustomizationsXml: WiFi 多個 SSID 並列在同一 WLANSetting 內", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      wifi: [
        { ssid: "Net-A", securityKey: "aaa" },
        { ssid: "Net-B", securityKey: "bbb", autoConnect: false, hidden: true },
      ],
    },
  });
  assertStringIncludes(xml, `<WLANConfig SSID="Net-A"`);
  assertStringIncludes(xml, `<WLANConfig SSID="Net-B"`);
  // 第二個 SSID 自定義 autoConnect=false / hidden=true 都正確渲染
  assertStringIncludes(xml, `<AutoConnect>False</AutoConnect>`);
  assertStringIncludes(xml, `<HiddenNetwork>True</HiddenNetwork>`);
  // 兩個 WLANConfig 共用一個 WLANSetting 包裝
  const wlanSettingOpenCount = (xml.match(/<WLANSetting>/g) || []).length;
  assertEquals(wlanSettingOpenCount, 1);
});

Deno.test("renderCustomizationsXml: WiFi SSID 含特殊字元正確 escape", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      wifi: [{ ssid: `quote"&lt`, securityKey: "p" }],
    },
  });
  assertStringIncludes(xml, `SSID="quote&quot;&amp;lt"`);
});

// ──────────────────────────────────────────────────────────────
// Accounts/Users 段
// ──────────────────────────────────────────────────────────────

Deno.test("renderCustomizationsXml: localAccount 單個 Standard User 完整段", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: [
        { username: "student-01", password: "StudPass!1" },
      ],
    },
  });
  assertStringIncludes(xml, `<Accounts>`);
  assertStringIncludes(xml, `<Users>`);
  assertStringIncludes(xml, `<User UserName="student-01" Name="student-01">`);
  assertStringIncludes(xml, `<Password>StudPass!1</Password>`);
  // 預設 isAdmin=false → "Standard Users" (複數，2026-05-28 真機 export 驗證)
  assertStringIncludes(xml, `<UserGroup>Standard Users</UserGroup>`);
});

Deno.test("renderCustomizationsXml: localAccount isAdmin=true → Administrators", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: [
        { username: "admin-01", password: "AdminPass!1", isAdmin: true },
      ],
    },
  });
  // 2026-05-28 Win10 ICD GUI export 真機驗證：Administrators 複數
  assertStringIncludes(xml, `<UserGroup>Administrators</UserGroup>`);
});

Deno.test("renderCustomizationsXml: localAccount 多個 user 並列在同一 Users 內", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: [
        { username: "stu-a", password: "a" },
        { username: "stu-b", password: "b" },
        { username: "admin-a", password: "c", isAdmin: true },
      ],
    },
  });
  assertStringIncludes(xml, `<User UserName="stu-a"`);
  assertStringIncludes(xml, `<User UserName="stu-b"`);
  assertStringIncludes(xml, `<User UserName="admin-a"`);
  const usersOpenCount = (xml.match(/<Users>/g) || []).length;
  assertEquals(usersOpenCount, 1);
  // 兩個 standard + 一個 admin
  const standardCount = (xml.match(/<UserGroup>Standard Users<\/UserGroup>/g) || []).length;
  const adminCount = (xml.match(/<UserGroup>Administrators<\/UserGroup>/g) || []).length;
  assertEquals(standardCount, 2);
  assertEquals(adminCount, 1);
});

Deno.test("renderCustomizationsXml: localAccount username/password 含特殊字元正確 escape", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: [
        { username: `quo"te`, password: `p&w<x>` },
      ],
    },
  });
  assertStringIncludes(xml, `UserName="quo&quot;te" Name="quo&quot;te"`);
  assertStringIncludes(xml, `<Password>p&amp;w&lt;x&gt;</Password>`);
});

// ──────────────────────────────────────────────────────────────
// 組合
// ──────────────────────────────────────────────────────────────

Deno.test("renderCustomizationsXml: enrollment + wifi + localAccounts 三段共存", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      wifi: [{ ssid: "S", securityKey: "k" }],
      localAccounts: [{ username: "u", password: "p" }],
    },
  });
  assertStringIncludes(xml, `<AuthPolicy>OnPremise</AuthPolicy>`);
  assertStringIncludes(xml, `<WLANConfig SSID="S"`);
  assertStringIncludes(xml, `<User UserName="u"`);
});

Deno.test("renderCustomizationsXml: XML 格式骨架正確（PackageConfig + Settings + Customizations）", () => {
  const xml = renderCustomizationsXml(baseCtx);
  assertStringIncludes(xml, `<?xml version="1.0" encoding="utf-8"?>`);
  assertStringIncludes(xml, `<WindowsCustomizations>`);
  assertStringIncludes(xml, `<PackageConfig xmlns="urn:schemas-Microsoft-com:Windows-ICD-Package-Config.v1.0">`);
  assertStringIncludes(xml, `<Settings xmlns="urn:schemas-microsoft-com:windows-provisioning">`);
  assertStringIncludes(xml, `</WindowsCustomizations>`);
});
