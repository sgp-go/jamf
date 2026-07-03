import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";
import {
  buildFirewallRuleAdd,
  buildFirewallRuleDelete,
  buildFirewallRulesDiff,
  type FirewallRuleInput,
} from "./csp-firewall-rules.ts";

const RULE_ID = "1c31f8b0-0000-4000-8000-000000000001";

function baseRule(overrides: Partial<FirewallRuleInput> = {}): FirewallRuleInput {
  return {
    ruleId: RULE_ID,
    name: "Block Steam",
    direction: "out",
    action: "block",
    ...overrides,
  };
}

Deno.test("buildFirewallRuleAdd: 最小輸入生成必要 Prop 命令組", () => {
  const cmds = buildFirewallRuleAdd(baseRule());
  const base = `./Vendor/MSFT/Firewall/MdmStore/FirewallRules/${RULE_ID}`;

  // 每 cmd 都是 Add
  for (const c of cmds) assertEquals(c.verb, "Replace");
  // 必含 Name / Direction / Action.Type / Profiles / Enabled
  const targets = cmds.map((c) => c.target);
  assertEquals(targets.includes(`${base}/Name`), true);
  assertEquals(targets.includes(`${base}/Direction`), true);
  assertEquals(targets.includes(`${base}/Action/Type`), true);
  assertEquals(targets.includes(`${base}/Profiles`), true);
  assertEquals(targets.includes(`${base}/Enabled`), true);

  // Action.Type：block = "0"
  const actionCmd = cmds.find((c) => c.target === `${base}/Action/Type`);
  assertEquals(actionCmd?.format, "int");
  assertEquals(actionCmd?.data, "0");

  // Direction：out → "Out"（大寫首）
  const dirCmd = cmds.find((c) => c.target === `${base}/Direction`);
  assertEquals(dirCmd?.data, "Out");

  // 預設 protocol=any → 不生成 Protocol 節點
  assertEquals(targets.includes(`${base}/Protocol`), false);

  // 預設 profiles=7
  const profCmd = cmds.find((c) => c.target === `${base}/Profiles`);
  assertEquals(profCmd?.data, "7");

  // 預設 enabled=true
  const enCmd = cmds.find((c) => c.target === `${base}/Enabled`);
  assertEquals(enCmd?.data, "true");
});

Deno.test("buildFirewallRuleAdd: protocol tcp → int 6，udp → 17", () => {
  const tcp = buildFirewallRuleAdd(baseRule({ protocol: "tcp" }));
  const udp = buildFirewallRuleAdd(baseRule({ protocol: "udp" }));
  const base = `./Vendor/MSFT/Firewall/MdmStore/FirewallRules/${RULE_ID}`;
  assertEquals(
    tcp.find((c) => c.target === `${base}/Protocol`)?.data,
    "6",
  );
  assertEquals(
    udp.find((c) => c.target === `${base}/Protocol`)?.data,
    "17",
  );
});

Deno.test("buildFirewallRuleAdd: allow → Action.Type=1", () => {
  const cmds = buildFirewallRuleAdd(baseRule({ action: "allow" }));
  const base = `./Vendor/MSFT/Firewall/MdmStore/FirewallRules/${RULE_ID}`;
  assertEquals(
    cmds.find((c) => c.target === `${base}/Action/Type`)?.data,
    "1",
  );
});

Deno.test("buildFirewallRuleAdd: 帶 port / address / app path 生成對應命令", () => {
  const cmds = buildFirewallRuleAdd(
    baseRule({
      protocol: "tcp",
      localPortRanges: "80,443",
      remotePortRanges: "8000-8100",
      localAddressRanges: "10.0.0.0/8",
      remoteAddressRanges: "192.168.1.1",
      appFilePath: "C:\\Program Files\\Steam\\Steam.exe",
    }),
  );
  const base = `./Vendor/MSFT/Firewall/MdmStore/FirewallRules/${RULE_ID}`;
  assertEquals(
    cmds.find((c) => c.target === `${base}/LocalPortRanges`)?.data,
    "80,443",
  );
  assertEquals(
    cmds.find((c) => c.target === `${base}/RemotePortRanges`)?.data,
    "8000-8100",
  );
  assertEquals(
    cmds.find((c) => c.target === `${base}/LocalAddressRanges`)?.data,
    "10.0.0.0/8",
  );
  assertEquals(
    cmds.find((c) => c.target === `${base}/RemoteAddressRanges`)?.data,
    "192.168.1.1",
  );
  assertEquals(
    cmds.find((c) => c.target === `${base}/App/FilePath`)?.data,
    "C:\\Program Files\\Steam\\Steam.exe",
  );
});

Deno.test("buildFirewallRuleAdd: UWP PFN 生成 App/PackageFamilyName", () => {
  const cmds = buildFirewallRuleAdd(
    baseRule({ appPackageFamilyName: "Microsoft.WindowsCalculator_8wekyb3d8bbwe" }),
  );
  const base = `./Vendor/MSFT/Firewall/MdmStore/FirewallRules/${RULE_ID}`;
  assertStringIncludes(
    cmds.find((c) => c.target === `${base}/App/PackageFamilyName`)?.data ?? "",
    "Microsoft.WindowsCalculator",
  );
});

Deno.test("buildFirewallRuleAdd: appFilePath + appPackageFamilyName 互斥拋錯", () => {
  assertThrows(
    () =>
      buildFirewallRuleAdd(
        baseRule({
          appFilePath: "C:\\x.exe",
          appPackageFamilyName: "y_z",
        }),
      ),
    Error,
    "互斥",
  );
});

Deno.test("buildFirewallRuleAdd: ruleId 含 '/' 拋錯", () => {
  assertThrows(
    () => buildFirewallRuleAdd(baseRule({ ruleId: "bad/id" })),
    Error,
    "不可含",
  );
});

Deno.test("buildFirewallRuleAdd: ruleId 空拋錯", () => {
  assertThrows(
    () => buildFirewallRuleAdd(baseRule({ ruleId: "" })),
    Error,
  );
});

Deno.test("buildFirewallRuleAdd: profiles bitmask 3 = Domain+Private", () => {
  const cmds = buildFirewallRuleAdd(baseRule({ profiles: 3 }));
  const base = `./Vendor/MSFT/Firewall/MdmStore/FirewallRules/${RULE_ID}`;
  assertEquals(
    cmds.find((c) => c.target === `${base}/Profiles`)?.data,
    "3",
  );
});

Deno.test("buildFirewallRuleDelete: 對整節點發 Delete", () => {
  const cmd = buildFirewallRuleDelete(RULE_ID);
  assertEquals(cmd.verb, "Delete");
  assertEquals(
    cmd.target,
    `./Vendor/MSFT/Firewall/MdmStore/FirewallRules/${RULE_ID}`,
  );
});

Deno.test("buildFirewallRulesDiff: 全新（old 空 + new 兩條）→ 全 Add，無 Delete", () => {
  const r1 = baseRule({ ruleId: "aaaaaaaa-0000-4000-8000-000000000001", name: "R1" });
  const r2 = baseRule({ ruleId: "bbbbbbbb-0000-4000-8000-000000000002", name: "R2" });
  const cmds = buildFirewallRulesDiff([], [r1, r2]);
  const deletes = cmds.filter((c) => c.verb === "Delete");
  const adds = cmds.filter((c) => c.verb === "Replace");
  assertEquals(deletes.length, 0);
  // 每條 rule 至少 5 個 Add（Name/Direction/Action.Type/Profiles/Enabled）
  assertEquals(adds.length >= 10, true);
});

Deno.test("buildFirewallRulesDiff: 全刪（old 兩條 + new 空）→ 兩條 Delete、無 Add", () => {
  const cmds = buildFirewallRulesDiff(
    ["aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"],
    [],
  );
  const deletes = cmds.filter((c) => c.verb === "Delete");
  const adds = cmds.filter((c) => c.verb === "Replace");
  assertEquals(deletes.length, 2);
  assertEquals(adds.length, 0);
});

Deno.test("buildFirewallRulesDiff: 增刪同時 → Delete 排在 Add 之前（避免同 ruleId Add 撞已存在）", () => {
  const oldId = "aaaaaaaa-0000-4000-8000-000000000001";
  const newRule = baseRule({
    ruleId: "bbbbbbbb-0000-4000-8000-000000000002",
    name: "New",
  });
  const cmds = buildFirewallRulesDiff([oldId], [newRule]);
  const firstDeleteIdx = cmds.findIndex((c) => c.verb === "Delete");
  const firstAddIdx = cmds.findIndex((c) => c.verb === "Replace");
  assertEquals(firstDeleteIdx >= 0, true);
  assertEquals(firstAddIdx >= 0, true);
  assertEquals(firstDeleteIdx < firstAddIdx, true);
});

Deno.test("buildFirewallRulesDiff: updated rule（同 id 既在 old 也在 new）→ Delete 舊 + Add 新", () => {
  const sameId = "cccccccc-0000-4000-8000-000000000003";
  const updated = baseRule({ ruleId: sameId, name: "Updated" });
  // 呼叫端把 updated 的 id 同時放 oldRuleIds 和 newRules
  const cmds = buildFirewallRulesDiff([sameId], [updated]);
  const deletes = cmds.filter((c) => c.verb === "Delete");
  const adds = cmds.filter((c) => c.verb === "Replace");
  assertEquals(deletes.length, 1);
  assertEquals(deletes[0].target.endsWith(sameId), true);
  // Add 至少 5 條（Name/Direction/Action.Type/Profiles/Enabled）
  assertEquals(adds.length >= 5, true);
});
