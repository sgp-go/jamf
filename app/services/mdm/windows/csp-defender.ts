/**
 * Microsoft Defender CSP（W4）
 *
 * 教育場景需求：強制啟用本機防毒（防學生關掉），並能回報健康狀態。
 *
 * 兩組路徑：
 * 1. **Policy CSP / Defender**（Replace，int format）
 *    `./Device/Vendor/MSFT/Policy/Config/Defender/<PolicyName>`
 *    用於強制啟用 Realtime / Behavior / Cloud / IOAV / NetworkProtection / PUA。
 *    注意：開啟 Tamper Protection（Defender CSP）後，下列 Policy 變更會被
 *    Defender 自身擋掉；admin 流程必須先確認 Tamper 狀態。
 *
 * 2. **Defender CSP / Health**（Get）
 *    `./Device/Vendor/MSFT/Defender/Health/<Node>`
 *    回報 Realtime/Engine/Signature 等狀態，供 server 定期 query。
 *
 * MS 文件依據：
 *   - policy-csp-defender
 *   - defender-csp
 */
import type { SyncMLCommand } from "./syncml.ts";

const POLICY_PREFIX = "./Device/Vendor/MSFT/Policy/Config/Defender";
const HEALTH_PREFIX = "./Device/Vendor/MSFT/Defender/Health";

/**
 * Defender 強制啟用輸入（MVP）。
 *
 * 所有欄位都可選；省略 = 不下命令、保留裝置現狀。預設語義針對「強制全開」
 * 用例：buildDefenderEnforce({}) 不會產生任何命令。要全開請呼叫
 * buildDefenderEnforceAll()。
 */
export interface DefenderEnforceInput {
  /** Realtime 即時掃描 */
  realtimeMonitoring?: boolean;
  /** 行為監控（heuristic detection） */
  behaviorMonitoring?: boolean;
  /** Cloud-delivered protection */
  cloudProtection?: boolean;
  /** IOAV：掃描下載 / IE Attachments */
  ioavProtection?: boolean;
  /**
   * 網路防護模式：
   *   0=disabled / 1=block / 2=audit
   */
  networkProtection?: 0 | 1 | 2;
  /**
   * PUA（Potentially Unwanted Application）攔截：
   *   0=disabled / 1=block / 2=audit
   */
  puaProtection?: 0 | 1 | 2;
  /**
   * Sample 提交同意：
   *   0=Always prompt / 1=Send safe / 2=Never send / 3=Send all
   */
  submitSamplesConsent?: 0 | 1 | 2 | 3;
}

/**
 * 依輸入產生 Defender Policy 強制設定命令清單。
 *
 * 只對「有提供」的欄位發 Replace；省略欄位不動。
 */
export function buildDefenderEnforce(input: DefenderEnforceInput): SyncMLCommand[] {
  const cmds: SyncMLCommand[] = [];

  if (input.realtimeMonitoring !== undefined) {
    cmds.push(boolPolicy("AllowRealtimeMonitoring", input.realtimeMonitoring));
  }
  if (input.behaviorMonitoring !== undefined) {
    cmds.push(boolPolicy("AllowBehaviorMonitoring", input.behaviorMonitoring));
  }
  if (input.cloudProtection !== undefined) {
    cmds.push(boolPolicy("AllowCloudProtection", input.cloudProtection));
  }
  if (input.ioavProtection !== undefined) {
    cmds.push(boolPolicy("AllowIOAVProtection", input.ioavProtection));
  }
  if (input.networkProtection !== undefined) {
    cmds.push(intPolicy("EnableNetworkProtection", input.networkProtection));
  }
  if (input.puaProtection !== undefined) {
    cmds.push(intPolicy("PUAProtection", input.puaProtection));
  }
  if (input.submitSamplesConsent !== undefined) {
    cmds.push(intPolicy("SubmitSamplesConsent", input.submitSamplesConsent));
  }

  return cmds;
}

/**
 * 全開 helper：教育場景默認套餐，把所有 Defender 主要防護開到最嚴。
 *
 * - Realtime / Behavior / Cloud / IOAV：啟用
 * - NetworkProtection：1 (block)
 * - PUAProtection：1 (block)
 * - SubmitSamplesConsent：1 (Send safe samples)
 */
export function buildDefenderEnforceAll(): SyncMLCommand[] {
  return buildDefenderEnforce({
    realtimeMonitoring: true,
    behaviorMonitoring: true,
    cloudProtection: true,
    ioavProtection: true,
    networkProtection: 1,
    puaProtection: 1,
    submitSamplesConsent: 1,
  });
}

/** Defender Health 子節點（read-only） */
export type DefenderHealthNode =
  | "ProductStatus"
  | "RealTimeProtectionEnabled"
  | "BehaviorMonitorEnabled"
  | "IoavProtectionEnabled"
  | "NisEnabled"
  | "RebootRequired"
  | "FullScanRequired"
  | "EngineVersion"
  | "SignatureVersion"
  | "AntiMalwareVersion"
  | "QuickScanTime"
  | "FullScanTime"
  | "QuickScanSigVersion"
  | "FullScanSigVersion"
  | "TamperProtectionEnabled"
  | "DefenderEnabled";

const DEFAULT_HEALTH_NODES: DefenderHealthNode[] = [
  "ProductStatus",
  "RealTimeProtectionEnabled",
  "BehaviorMonitorEnabled",
  "TamperProtectionEnabled",
  "SignatureVersion",
  "EngineVersion",
  "QuickScanTime",
  "FullScanTime",
  "RebootRequired",
];

/**
 * 產生 Defender Health 查詢命令清單。
 *
 * 不提供 nodes → 回傳 DEFAULT_HEALTH_NODES 預設套餐。
 */
export function buildDefenderHealthQuery(
  nodes: DefenderHealthNode[] = DEFAULT_HEALTH_NODES,
): SyncMLCommand[] {
  if (nodes.length === 0) {
    throw new Error("buildDefenderHealthQuery: nodes 不可為空");
  }
  return nodes.map((node) => ({
    cmdId: "0",
    verb: "Get" as const,
    target: `${HEALTH_PREFIX}/${node}`,
  }));
}

/** Helper：bool → int 0/1，產生 Defender Policy Replace 命令 */
function boolPolicy(name: string, enabled: boolean): SyncMLCommand {
  return intPolicy(name, enabled ? 1 : 0);
}

/** Helper：產生 Defender Policy Replace 命令（int format） */
function intPolicy(name: string, value: number): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: `${POLICY_PREFIX}/${name}`,
    format: "int",
    data: String(value),
  };
}
