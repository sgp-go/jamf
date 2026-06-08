/**
 * 合規政策評估引擎（W4）
 *
 * 純函式：給定 device 摘要 + policy 規則 → 合規結果 + 違規清單。
 *
 * MVP 規則（plan §5）：
 *   - min_os_version：device.osVersion 必須 >= policy.minOSVersion
 *   - max_offline_days：now - device.lastSeenAt 必須 <= policy.maxOfflineDays
 *
 * 不持久化規則表；admin 流程把 policy 物件存於應用層即可。等需要 admin CRUD
 * 時再補 DB schema（compliance_policies + device_compliance_status）。
 */

export interface CompliancePolicy {
  /** 政策唯一識別 */
  id: string;
  /** 顯示名稱 */
  name: string;
  /**
   * 最低 OS 版本（含）。支援 dotted-decimal：
   *   - macOS 14.5 / 14.5.1
   *   - Windows 10.0.19045.4170
   * 比較規則：逐段數值大小比較；缺失段視為 0。
   */
  minOSVersion?: string;
  /** 最久允許離線天數（小數允許） */
  maxOfflineDays?: number;
}

export type ComplianceRuleKey = "min_os_version" | "max_offline_days";

export interface ComplianceViolation {
  rule: ComplianceRuleKey;
  expected: string;
  actual: string | null;
  message: string;
}

export interface ComplianceResult {
  policyId: string;
  policyName: string;
  compliant: boolean;
  violations: ComplianceViolation[];
  evaluatedAt: string;
}

export interface DeviceForCompliance {
  osVersion: string | null;
  lastSeenAt: Date | string | null;
}

/**
 * 解析 dotted-decimal 版本字串為段陣列。
 * 非數字段視為 0；前後空白、leading "v"、build 後綴 (-rc1 等) 截斷。
 */
export function parseVersion(s: string | null | undefined): number[] {
  if (!s) return [];
  const trimmed = s.trim().replace(/^v/i, "");
  const numeric = trimmed.split(/[-+]/)[0] ?? "";
  if (!numeric) return [];
  return numeric.split(".").map((seg) => {
    const n = Number.parseInt(seg, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * 比較兩個 dotted-decimal 版本字串：
 *   返回 <0：a < b
 *   返回  0：a == b
 *   返回 >0：a > b
 */
export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * 評估單台 device 對單條 policy 的合規狀態。
 *
 * 違規不會 throw；空輸入 / 缺欄位視為「該規則無法評估，記為違規 (actual=null)」。
 *
 * @param device 必要欄位：osVersion + lastSeenAt
 * @param policy 政策物件
 * @param now 用來計算離線天數，預設 current time（便於測試 inject）
 */
export function evaluateCompliance(
  device: DeviceForCompliance,
  policy: CompliancePolicy,
  now: Date = new Date(),
): ComplianceResult {
  const violations: ComplianceViolation[] = [];

  if (policy.minOSVersion !== undefined) {
    const actual = device.osVersion;
    if (!actual) {
      violations.push({
        rule: "min_os_version",
        expected: policy.minOSVersion,
        actual: null,
        message: `device.osVersion 未知，無法評估 minOSVersion=${policy.minOSVersion}`,
      });
    } else if (compareVersion(actual, policy.minOSVersion) < 0) {
      violations.push({
        rule: "min_os_version",
        expected: policy.minOSVersion,
        actual,
        message: `OS 版本 ${actual} 低於最低要求 ${policy.minOSVersion}`,
      });
    }
  }

  if (policy.maxOfflineDays !== undefined) {
    const last = toDate(device.lastSeenAt);
    if (last === null) {
      violations.push({
        rule: "max_offline_days",
        expected: String(policy.maxOfflineDays),
        actual: null,
        message: `device.lastSeenAt 未知，無法評估 maxOfflineDays=${policy.maxOfflineDays}`,
      });
    } else {
      const diffDays = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > policy.maxOfflineDays) {
        violations.push({
          rule: "max_offline_days",
          expected: String(policy.maxOfflineDays),
          actual: diffDays.toFixed(2),
          message: `離線 ${diffDays.toFixed(1)} 天，超過上限 ${policy.maxOfflineDays} 天`,
        });
      }
    }
  }

  return {
    policyId: policy.id,
    policyName: policy.name,
    compliant: violations.length === 0,
    violations,
    evaluatedAt: now.toISOString(),
  };
}

function toDate(v: Date | string | null): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
