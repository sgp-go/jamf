import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@^1";
import { buildVpnProfile, buildVpnRemove } from "./csp-vpn.ts";

Deno.test("buildVpnProfile: IKEv2 最小輸入 → Add ProfileXML 含 EAP wrapper", () => {
  const cmd = buildVpnProfile({
    profileName: "School-VPN",
    serverHost: "vpn.school.edu.tw",
    protocol: "IKEv2",
  });
  assertEquals(cmd.verb, "Add");
  assertEquals(cmd.target, "./Vendor/MSFT/VPNv2/School-VPN/ProfileXML");
  assertEquals(cmd.format, "chr");
  assertStringIncludes(cmd.data!, "<NativeProtocolType>IKEv2</NativeProtocolType>");
  assertStringIncludes(cmd.data!, "<Servers>vpn.school.edu.tw</Servers>");
  // Win10+ IKEv2 必須 EAP wrapper 而非直接 <UserMethod>MSChapv2</UserMethod>
  assertStringIncludes(cmd.data!, "<UserMethod>Eap</UserMethod>");
  assertStringIncludes(cmd.data!, "<EapHostConfig");
  // EAP Type=26 是 MSCHAPv2
  assertStringIncludes(cmd.data!, "<Type>26</Type>");
  // 預設不應出現 L2tpPsk 節點
  assertEquals(cmd.data!.includes("L2tpPsk"), false);
});

Deno.test("buildVpnProfile: L2TP 用直接 <UserMethod>MSChapv2</UserMethod>（無 EAP wrapper）", () => {
  const cmd = buildVpnProfile({
    profileName: "Legacy",
    serverHost: "h",
    protocol: "L2TP",
    l2tpPsk: "psk",
  });
  assertStringIncludes(cmd.data!, "<UserMethod>MSChapv2</UserMethod>");
  assertEquals(cmd.data!.includes("EapHostConfig"), false);
});

Deno.test("buildVpnProfile: L2TP 必須提供 l2tpPsk", () => {
  assertThrows(
    () =>
      buildVpnProfile({
        profileName: "x",
        serverHost: "y",
        protocol: "L2TP",
      }),
    Error,
    "l2tpPsk",
  );
});

Deno.test("buildVpnProfile: L2TP + PSK → 含 L2tpPsk 節點", () => {
  const cmd = buildVpnProfile({
    profileName: "Legacy-VPN",
    serverHost: "10.0.0.1",
    protocol: "L2TP",
    l2tpPsk: "shared-secret",
  });
  assertStringIncludes(cmd.data!, "<NativeProtocolType>L2TP</NativeProtocolType>");
  assertStringIncludes(cmd.data!, "<L2tpPsk>shared-secret</L2tpPsk>");
});

Deno.test("buildVpnProfile: profileName 含 / 拋錯", () => {
  assertThrows(
    () =>
      buildVpnProfile({
        profileName: "bad/name",
        serverHost: "x",
        protocol: "IKEv2",
      }),
    Error,
    "/",
  );
});

Deno.test("buildVpnProfile: dnsSuffix + trustedNetworkDetection 出現在 XML", () => {
  const cmd = buildVpnProfile({
    profileName: "p",
    serverHost: "h",
    protocol: "IKEv2",
    dnsSuffix: "school.edu.tw",
    trustedNetworkDetection: ["campus.edu.tw", "lab.edu.tw"],
  });
  assertStringIncludes(cmd.data!, "<DnsSuffix>school.edu.tw</DnsSuffix>");
  assertStringIncludes(
    cmd.data!,
    "<TrustedNetworkDetection>campus.edu.tw</TrustedNetworkDetection>",
  );
  assertStringIncludes(
    cmd.data!,
    "<TrustedNetworkDetection>lab.edu.tw</TrustedNetworkDetection>",
  );
});

Deno.test("buildVpnProfile: ForceTunnel 設 RoutingPolicyType", () => {
  const cmd = buildVpnProfile({
    profileName: "p",
    serverHost: "h",
    protocol: "IKEv2",
    routingPolicy: "ForceTunnel",
  });
  assertStringIncludes(cmd.data!, "<RoutingPolicyType>ForceTunnel</RoutingPolicyType>");
});

Deno.test("buildVpnProfile: rememberCredentials 預設 true, alwaysOn 預設 false", () => {
  const cmd = buildVpnProfile({
    profileName: "p",
    serverHost: "h",
    protocol: "IKEv2",
  });
  assertStringIncludes(cmd.data!, "<RememberCredentials>true</RememberCredentials>");
  assertStringIncludes(cmd.data!, "<AlwaysOn>false</AlwaysOn>");
});

Deno.test("buildVpnProfile: PSK 含 XML 特殊字元（&<>）被 escape", () => {
  const cmd = buildVpnProfile({
    profileName: "p",
    serverHost: "h",
    protocol: "L2TP",
    l2tpPsk: "a&b<c>d",
  });
  assertStringIncludes(cmd.data!, "<L2tpPsk>a&amp;b&lt;c&gt;d</L2tpPsk>");
});

Deno.test("buildVpnProfile: profileName 含 URL-encode 字元（空白）", () => {
  const cmd = buildVpnProfile({
    profileName: "Home WiFi",
    serverHost: "h",
    protocol: "IKEv2",
  });
  // URL-encode：空白 → %20
  assertEquals(cmd.target, "./Vendor/MSFT/VPNv2/Home%20WiFi/ProfileXML");
});

Deno.test("buildVpnRemove: Delete VPNv2/{name}", () => {
  const cmd = buildVpnRemove("Old-Profile");
  assertEquals(cmd.verb, "Delete");
  assertEquals(cmd.target, "./Vendor/MSFT/VPNv2/Old-Profile");
});
