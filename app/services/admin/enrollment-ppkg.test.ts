import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@^1";
import { renderCustomizationsXml, type RenderContext } from "./enrollment-ppkg.ts";

// WiFi 必填（2026-06-25 改）——base fixture 帶一個預設 SSID，避免每個 test 都得自帶
const baseCtx: RenderContext = {
  tenant: { slug: "demo", displayName: "Demo School" },
  cfg: { publicBaseUrl: "https://mdm.example.com" },
  deviceGroup: null,
  input: {
    tenantId: "00000000-0000-0000-0000-000000000000",
    upn: "enrollment@demo.example.com",
    secret: "P@ssw0rd!",
    wifi: [{ ssid: "Default-WiFi", securityKey: "default-pass" }],
  },
};

Deno.test("renderCustomizationsXml: OnPremise（預設）含 Workplace/Enrollments 完整段", () => {
  const xml = renderCustomizationsXml(baseCtx);
  assertStringIncludes(xml, `<UPN UPN="enrollment@demo.example.com" Name="enrollment@demo.example.com">`);
  assertStringIncludes(xml, `<AuthPolicy>OnPremise</AuthPolicy>`);
  assertStringIncludes(
    xml,
    `<DiscoveryServiceFullUrl>https://mdm.example.com/t/demo/EnrollmentServer/Discovery.svc</DiscoveryServiceFullUrl>`,
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
    "https://mdm.example.com/t/demo/EnrollmentServer/Discovery.svc",
  );
  // 不該出現 // 雙斜線
  assertEquals(
    xml.includes("https://mdm.example.com//t"),
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
// WiFi 段 — 必填（2026-06-25 真機驗證後改硬性）+ schema 反向工程
// ──────────────────────────────────────────────────────────────

Deno.test("renderCustomizationsXml: wifi=[] 空陣列 → throw 400（必填防線）", () => {
  assertThrows(
    () =>
      renderCustomizationsXml({
        ...baseCtx,
        // deno-lint-ignore no-explicit-any
        input: { ...baseCtx.input, wifi: [] as any },
      }),
    Error,
    "must contain at least 1 SSID",
  );
});

Deno.test("renderCustomizationsXml: wifi 缺失（TS as any 繞過）→ throw 400", () => {
  assertThrows(
    () => {
      const input = { ...baseCtx.input };
      // deno-lint-ignore no-explicit-any
      delete (input as any).wifi;
      // deno-lint-ignore no-explicit-any
      return renderCustomizationsXml({ ...baseCtx, input: input as any });
    },
    Error,
    "must contain at least 1 SSID",
  );
});

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

// ──────────────────────────────────────────────────────────────
// OOBE skip 段 — 2026-06-25 Win10 ICD GUI export 反向工程 schema
// ──────────────────────────────────────────────────────────────

Deno.test("renderCustomizationsXml: skipOobe=true 渲染 HideOobe 段", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: { ...baseCtx.input, skipOobe: true },
  });
  assertStringIncludes(xml, `<OOBE>`);
  assertStringIncludes(xml, `<Desktop>`);
  assertStringIncludes(xml, `<HideOobe>True</HideOobe>`);
});

Deno.test("renderCustomizationsXml: skipOobe 不傳/false → 不渲染 OOBE 段", () => {
  const xmlOmitted = renderCustomizationsXml(baseCtx);
  assertEquals(xmlOmitted.includes("<OOBE>"), false);
  assertEquals(xmlOmitted.includes("<HideOobe>"), false);

  const xmlFalse = renderCustomizationsXml({
    ...baseCtx,
    input: { ...baseCtx.input, skipOobe: false },
  });
  assertEquals(xmlFalse.includes("<OOBE>"), false);
});

// ──────────────────────────────────────────────────────────────
// ProvisioningCommands 段 — 強制首次登入改密
// ──────────────────────────────────────────────────────────────

Deno.test("renderCustomizationsXml: forceChangePasswordAtNextLogon=true 渲染 net user 命令 + dmwapp keepalive", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: [
        {
          username: "student",
          password: "TempPass!1",
          forceChangePasswordAtNextLogon: true,
        },
      ],
    },
  });
  assertStringIncludes(xml, `<ProvisioningCommands>`);
  assertStringIncludes(xml, `<DeviceContext>`);
  // CommandLine 現在合併 dmwapp keepalive + net user；& 在 XML 裡 escape 成 &amp;
  assertStringIncludes(xml, `sc start dmwappushservice`);
  assertStringIncludes(xml, `schtasks /Create /TN CoGrowDmwappKeepalive`);
  assertStringIncludes(xml, `net user student /logonpasswordchg:yes`);
});

Deno.test("renderCustomizationsXml: 多個 forceChangePasswordAtNextLogon 串成 && 鏈", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: [
        { username: "stu-a", password: "a", forceChangePasswordAtNextLogon: true },
        { username: "stu-b", password: "b" }, // 不強制 → 不進命令
        { username: "stu-c", password: "c", forceChangePasswordAtNextLogon: true },
      ],
    },
  });
  // 注意 && 在 XML text 內會被 escape 成 &amp;&amp;（escapeXmlText 處理）
  assertStringIncludes(
    xml,
    `net user stu-a /logonpasswordchg:yes &amp;&amp; net user stu-c /logonpasswordchg:yes`,
  );
  // stu-b 不該出現在 ProvisioningCommands 段（但仍在 Accounts 段）
  assertEquals(
    xml.includes("net user stu-b /logonpasswordchg:yes"),
    false,
  );
});

Deno.test("renderCustomizationsXml: 沒有 forceChangePasswordAtNextLogon 仍渲染 dmwapp keepalive（不含 net user）", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: [
        { username: "stu-only", password: "p" }, // 不強制
      ],
    },
  });
  // ProvisioningCommands 段必存在（首次 enroll 期 Agent 未裝，須 PPKG 側撐起 dmwapp keepalive）
  assertStringIncludes(xml, `<ProvisioningCommands>`);
  assertStringIncludes(xml, `sc start dmwappushservice`);
  assertStringIncludes(xml, `schtasks /Create /TN CoGrowDmwappKeepalive`);
  // 但不含 net user 段
  assertEquals(xml.includes("/logonpasswordchg"), false);
});

Deno.test("renderCustomizationsXml: 完全沒 localAccounts 也渲染 dmwapp keepalive", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: undefined,
    },
  });
  assertStringIncludes(xml, `<ProvisioningCommands>`);
  assertStringIncludes(xml, `sc start dmwappushservice`);
  assertStringIncludes(xml, `schtasks /Create /TN CoGrowDmwappKeepalive`);
});

Deno.test("renderCustomizationsXml: username 含非安全字符 → throw 400（batch injection 防線）", () => {
  // username 含 `&` → 直接 batch injection
  assertThrows(
    () =>
      renderCustomizationsXml({
        ...baseCtx,
        input: {
          ...baseCtx.input,
          localAccounts: [
            {
              username: "stu&whoami",
              password: "p",
              forceChangePasswordAtNextLogon: true,
            },
          ],
        },
      }),
    Error,
    "含非安全字符",
  );

  // 中文 / 空格也應被擋（Windows 本機帳號允許但對 batch 不安全）
  assertThrows(
    () =>
      renderCustomizationsXml({
        ...baseCtx,
        input: {
          ...baseCtx.input,
          localAccounts: [
            {
              username: "stu 01",
              password: "p",
              forceChangePasswordAtNextLogon: true,
            },
          ],
        },
      }),
    Error,
    "含非安全字符",
  );
});

Deno.test("renderCustomizationsXml: username 安全字符（A-Za-z0-9._-）放行", () => {
  // 不應 throw
  const xml = renderCustomizationsXml({
    ...baseCtx,
    input: {
      ...baseCtx.input,
      localAccounts: [
        {
          username: "stu_01.test-a",
          password: "p",
          forceChangePasswordAtNextLogon: true,
        },
      ],
    },
  });
  assertStringIncludes(xml, `net user stu_01.test-a /logonpasswordchg:yes`);
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

// ──────────────────────────────────────────────────────────────
// device_group 段：PPKG DiscoveryUrl 嵌入 /g/{code}，設備 enroll 即歸組
// ──────────────────────────────────────────────────────────────

Deno.test("renderCustomizationsXml: deviceGroup 帶入 DiscoveryUrl /g/{code} 段", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    deviceGroup: { code: "guangfu-es", displayName: "光復國小" },
  });
  assertStringIncludes(
    xml,
    "<DiscoveryServiceFullUrl>https://mdm.example.com/t/demo/g/guangfu-es/EnrollmentServer/Discovery.svc</DiscoveryServiceFullUrl>",
  );
});

Deno.test("renderCustomizationsXml: deviceGroup=null 時 DiscoveryUrl 不含 /g/ 段（向後相容）", () => {
  const xml = renderCustomizationsXml(baseCtx);
  assertStringIncludes(
    xml,
    "<DiscoveryServiceFullUrl>https://mdm.example.com/t/demo/EnrollmentServer/Discovery.svc</DiscoveryServiceFullUrl>",
  );
  assertEquals(xml.includes("/g/"), false);
});

Deno.test("renderCustomizationsXml: deviceGroup 帶 displayName 進 Notes（tenant / group 雙標）", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    deviceGroup: { code: "guangfu-es", displayName: "光復國小" },
  });
  assertStringIncludes(xml, "for tenant Demo School / 光復國小</Notes>");
});

Deno.test("renderCustomizationsXml: deviceGroup displayName=null 時 Notes fallback 到 code", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    deviceGroup: { code: "guangfu-es", displayName: null },
  });
  assertStringIncludes(xml, "for tenant Demo School / guangfu-es</Notes>");
});

Deno.test("renderCustomizationsXml: deviceGroup 帶入 Name=cogrow-{slug}-{code}-{date}", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    deviceGroup: { code: "guangfu-es", displayName: "光復國小" },
  });
  const m = xml.match(/<Name>(cogrow-demo-guangfu-es-\d{4}-\d{2}-\d{2})<\/Name>/);
  assertEquals(m !== null, true);
});

Deno.test("renderCustomizationsXml: publicBaseUrl trailing slash + deviceGroup 不重複斜線", () => {
  const xml = renderCustomizationsXml({
    ...baseCtx,
    cfg: { publicBaseUrl: "https://mdm.example.com/" },
    deviceGroup: { code: "guangfu-es", displayName: null },
  });
  assertStringIncludes(
    xml,
    "https://mdm.example.com/t/demo/g/guangfu-es/EnrollmentServer/Discovery.svc",
  );
  assertEquals(xml.includes("https://mdm.example.com//t"), false);
});
