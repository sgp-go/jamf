/**
 * Firewall CSP FirewallRules 派發（PRD §5.4）
 *
 * LocURI 樹：./Vendor/MSFT/Firewall/MdmStore/FirewallRules/{RuleId}/{Prop}
 *
 * Verb 語義（微軟 CSP 限制）：
 *   - Add：每個 rule 一組 Add 平鋪（每個 Prop 一條 SyncMLCommand）—— 首次或 diff 新增
 *   - Delete：對 `.../FirewallRules/{RuleId}` 整個節點發，刪整條 rule
 *   - Replace（部分屬性）：**不支援**；修改 rule 必須 Delete + Add
 *
 * 大小寫敏感：
 *   - Direction："In" / "Out"
 *   - Action：Type="0"（Block）/ "1"（Allow）—— 微軟 spec 用 int
 *   - Protocol：TCP=6, UDP=17, Any=* (實際 spec 用數字或省略)
 *   - Profiles：bitmask int（1=Domain 2=Private 4=Public，7=All）
 *
 * ruleId 命名：呼叫端傳 UUID（backend 生成），避免多 tenant 撞名。CSP 節點名不可含 `/`。
 *
 * 詳見 MS docs Firewall-csp：
 * https://learn.microsoft.com/windows/client-management/mdm/firewall-csp
 */
import type { SyncMLCommand } from "./syncml.ts";

export type FirewallRuleDirection = "in" | "out";
export type FirewallRuleAction = "allow" | "block";
export type FirewallRuleProtocol = "tcp" | "udp" | "any";

export interface FirewallRuleInput {
  /** UUID（backend 生成），將作為 CSP node key。禁止含 `/` */
  ruleId: string;
  /** 顯示名（GUI 可見） */
  name: string;
  description?: string | null;
  direction: FirewallRuleDirection;
  action: FirewallRuleAction;
  protocol?: FirewallRuleProtocol;
  /** "80,443,8000-8100" 或 null=any */
  localPortRanges?: string | null;
  remotePortRanges?: string | null;
  localAddressRanges?: string | null;
  remoteAddressRanges?: string | null;
  /** 互斥於 appPackageFamilyName */
  appFilePath?: string | null;
  appPackageFamilyName?: string | null;
  /** bitmask：1=Domain 2=Private 4=Public，預設 7 */
  profiles?: number;
  /** 預設 true */
  enabled?: boolean;
}

const FIREWALL_RULES_BASE = "./Vendor/MSFT/Firewall/MdmStore/FirewallRules";

function assertRuleId(ruleId: string): void {
  if (!ruleId || ruleId.includes("/")) {
    throw new Error(
      `buildFirewallRule: ruleId 不可為空且不可含 "/"（${ruleId}）`,
    );
  }
}

function protocolToNumber(p: FirewallRuleProtocol): string | null {
  switch (p) {
    case "tcp":
      return "6";
    case "udp":
      return "17";
    case "any":
      return null; // 省略 Protocol 節點 = 任意
  }
}

/**
 * 生成一條 rule 的 Add 命令組（多條 SyncMLCommand，每 Prop 一條）。
 * 呼叫端把多條 rule 的命令 concat 起來一次派發 atomic 語義由呼叫端外層保證。
 */
export function buildFirewallRuleAdd(rule: FirewallRuleInput): SyncMLCommand[] {
  assertRuleId(rule.ruleId);
  const base = `${FIREWALL_RULES_BASE}/${rule.ruleId}`;
  const cmds: SyncMLCommand[] = [];
  const addChr = (path: string, val: string) =>
    cmds.push({ cmdId: "0", verb: "Add", target: path, format: "chr", data: val });
  const addInt = (path: string, val: string) =>
    cmds.push({ cmdId: "0", verb: "Add", target: path, format: "int", data: val });
  const addBool = (path: string, val: boolean) =>
    cmds.push({
      cmdId: "0",
      verb: "Add",
      target: path,
      format: "bool",
      data: val ? "true" : "false",
    });

  // Name（必填）
  addChr(`${base}/Name`, rule.name);
  // Direction
  addChr(`${base}/Direction`, rule.direction === "in" ? "In" : "Out");
  // Action.Type：0=Block，1=Allow（微軟 spec 用 int）
  addInt(`${base}/Action/Type`, rule.action === "allow" ? "1" : "0");
  // Protocol（tcp=6, udp=17, any=省略）
  const proto = protocolToNumber(rule.protocol ?? "any");
  if (proto !== null) addInt(`${base}/Protocol`, proto);
  // Ports
  if (rule.localPortRanges) addChr(`${base}/LocalPortRanges`, rule.localPortRanges);
  if (rule.remotePortRanges) addChr(`${base}/RemotePortRanges`, rule.remotePortRanges);
  // Addresses
  if (rule.localAddressRanges) {
    addChr(`${base}/LocalAddressRanges`, rule.localAddressRanges);
  }
  if (rule.remoteAddressRanges) {
    addChr(`${base}/RemoteAddressRanges`, rule.remoteAddressRanges);
  }
  // App target（Win32 exe 或 UWP PFN 互斥）
  if (rule.appFilePath && rule.appPackageFamilyName) {
    throw new Error(
      `buildFirewallRule: appFilePath 與 appPackageFamilyName 互斥（rule=${rule.name}）`,
    );
  }
  if (rule.appFilePath) addChr(`${base}/App/FilePath`, rule.appFilePath);
  if (rule.appPackageFamilyName) {
    addChr(`${base}/App/PackageFamilyName`, rule.appPackageFamilyName);
  }
  // Profiles bitmask（預設 7 = Domain+Private+Public）
  addInt(`${base}/Profiles`, String(rule.profiles ?? 7));
  // Enabled（預設 true）
  addBool(`${base}/Enabled`, rule.enabled ?? true);
  return cmds;
}

/**
 * 刪除一條 rule：Delete `.../FirewallRules/{RuleId}` 整節點。
 */
export function buildFirewallRuleDelete(ruleId: string): SyncMLCommand {
  assertRuleId(ruleId);
  return {
    cmdId: "0",
    verb: "Delete",
    target: `${FIREWALL_RULES_BASE}/${ruleId}`,
  };
}

/**
 * 批量：把「要刪的 ruleId 列表」+「要新增的 rule 列表」轉成 SyncML 命令序列。
 *
 * Diff 邏輯（哪些 ruleId 該進 toDelete / 哪些 rule 該進 toAdd）**由 service 層負責**，
 * CSP helper 只做機械翻譯。這樣 caller 對「unchanged / updated」有明確控制：
 *   - unchanged：兩邊都不放
 *   - updated：id 同時放 toDelete + rule 放 toAdd（CSP 不支援 partial Replace）
 *   - added：只放 toAdd
 *   - removed：只放 toDelete
 *
 * 命令順序：先 Delete 再 Add，避免同 ruleId 立刻 Add 撞「已存在」錯誤。
 */
export function buildFirewallRulesDiff(
  toDelete: readonly string[],
  toAdd: readonly FirewallRuleInput[],
): SyncMLCommand[] {
  const cmds: SyncMLCommand[] = [];
  for (const id of toDelete) cmds.push(buildFirewallRuleDelete(id));
  for (const rule of toAdd) cmds.push(...buildFirewallRuleAdd(rule));
  return cmds;
}
