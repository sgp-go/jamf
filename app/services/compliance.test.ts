import { assertEquals } from "jsr:@std/assert@^1";
import {
  parseVersion,
  compareVersion,
  evaluateCompliance,
  type CompliancePolicy,
} from "./compliance.ts";

Deno.test("parseVersion: 純數字段", () => {
  assertEquals(parseVersion("14.5.1"), [14, 5, 1]);
  assertEquals(parseVersion("10.0.19045.4170"), [10, 0, 19045, 4170]);
});

Deno.test("parseVersion: 空 / null → []", () => {
  assertEquals(parseVersion(""), []);
  assertEquals(parseVersion(null), []);
  assertEquals(parseVersion(undefined), []);
});

Deno.test("parseVersion: trim + leading v + 後綴截斷", () => {
  assertEquals(parseVersion("  v14.5.1-rc1 "), [14, 5, 1]);
  assertEquals(parseVersion("v1.0+build.4"), [1, 0]);
});

Deno.test("parseVersion: 非數字段視為 0", () => {
  assertEquals(parseVersion("14.x.1"), [14, 0, 1]);
});

Deno.test("compareVersion: 同版本回傳 0", () => {
  assertEquals(compareVersion("14.5.1", "14.5.1"), 0);
});

Deno.test("compareVersion: 主版本不同", () => {
  const r1 = compareVersion("14.0.0", "13.9.9");
  const r2 = compareVersion("13.0.0", "14.0.0");
  assertEquals(r1 > 0, true);
  assertEquals(r2 < 0, true);
});

Deno.test("compareVersion: 缺段視為 0（14.5 < 14.5.1）", () => {
  const r = compareVersion("14.5", "14.5.1");
  assertEquals(r < 0, true);
});

Deno.test("compareVersion: Windows build 數字大量", () => {
  const r = compareVersion("10.0.19045.4170", "10.0.19045.3996");
  assertEquals(r > 0, true);
});

Deno.test("evaluateCompliance: 完全合規（無 violation）", () => {
  const policy: CompliancePolicy = {
    id: "p1",
    name: "Win10 baseline",
    minOSVersion: "10.0.19045.0",
    maxOfflineDays: 7,
  };
  const now = new Date("2026-05-28T12:00:00Z");
  const result = evaluateCompliance(
    {
      osVersion: "10.0.19045.4170",
      lastSeenAt: new Date("2026-05-27T08:00:00Z"),
    },
    policy,
    now,
  );
  assertEquals(result.compliant, true);
  assertEquals(result.violations, []);
  assertEquals(result.policyId, "p1");
  assertEquals(result.policyName, "Win10 baseline");
});

Deno.test("evaluateCompliance: OS 版本不達標", () => {
  const policy: CompliancePolicy = {
    id: "p1",
    name: "x",
    minOSVersion: "10.0.19045.4170",
  };
  const result = evaluateCompliance(
    { osVersion: "10.0.19045.3996", lastSeenAt: new Date() },
    policy,
  );
  assertEquals(result.compliant, false);
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0].rule, "min_os_version");
  assertEquals(result.violations[0].expected, "10.0.19045.4170");
  assertEquals(result.violations[0].actual, "10.0.19045.3996");
});

Deno.test("evaluateCompliance: OS 版本未知 → 違規 actual=null", () => {
  const policy: CompliancePolicy = {
    id: "p1",
    name: "x",
    minOSVersion: "14.0.0",
  };
  const result = evaluateCompliance(
    { osVersion: null, lastSeenAt: new Date() },
    policy,
  );
  assertEquals(result.compliant, false);
  assertEquals(result.violations[0].actual, null);
});

Deno.test("evaluateCompliance: 離線超過 maxOfflineDays", () => {
  const policy: CompliancePolicy = {
    id: "p1",
    name: "x",
    maxOfflineDays: 7,
  };
  const now = new Date("2026-05-28T00:00:00Z");
  const last = new Date("2026-05-18T00:00:00Z"); // 10 天前
  const result = evaluateCompliance({ osVersion: "1.0", lastSeenAt: last }, policy, now);
  assertEquals(result.compliant, false);
  assertEquals(result.violations[0].rule, "max_offline_days");
  assertEquals(result.violations[0].expected, "7");
});

Deno.test("evaluateCompliance: lastSeenAt=null → 違規 actual=null", () => {
  const policy: CompliancePolicy = {
    id: "p1",
    name: "x",
    maxOfflineDays: 7,
  };
  const result = evaluateCompliance(
    { osVersion: "1.0", lastSeenAt: null },
    policy,
  );
  assertEquals(result.compliant, false);
  assertEquals(result.violations[0].actual, null);
});

Deno.test("evaluateCompliance: lastSeenAt 接受 ISO string", () => {
  const policy: CompliancePolicy = {
    id: "p1",
    name: "x",
    maxOfflineDays: 30,
  };
  const now = new Date("2026-05-28T00:00:00Z");
  const result = evaluateCompliance(
    { osVersion: "1.0", lastSeenAt: "2026-05-20T00:00:00Z" },
    policy,
    now,
  );
  assertEquals(result.compliant, true);
});

Deno.test("evaluateCompliance: 多違規同時上報", () => {
  const policy: CompliancePolicy = {
    id: "p1",
    name: "strict",
    minOSVersion: "14.0.0",
    maxOfflineDays: 1,
  };
  const now = new Date("2026-05-28T00:00:00Z");
  const result = evaluateCompliance(
    {
      osVersion: "13.0.0",
      lastSeenAt: new Date("2026-05-20T00:00:00Z"),
    },
    policy,
    now,
  );
  assertEquals(result.compliant, false);
  assertEquals(result.violations.length, 2);
  assertEquals(result.violations[0].rule, "min_os_version");
  assertEquals(result.violations[1].rule, "max_offline_days");
});

Deno.test("evaluateCompliance: 政策無欄位 → 永遠合規", () => {
  const policy: CompliancePolicy = { id: "p1", name: "noop" };
  const result = evaluateCompliance(
    { osVersion: null, lastSeenAt: null },
    policy,
  );
  assertEquals(result.compliant, true);
  assertEquals(result.violations, []);
});

Deno.test("evaluateCompliance: 結果含 evaluatedAt ISO 字串", () => {
  const policy: CompliancePolicy = { id: "p1", name: "x" };
  const now = new Date("2026-05-28T10:30:00Z");
  const result = evaluateCompliance(
    { osVersion: "1.0", lastSeenAt: new Date() },
    policy,
    now,
  );
  assertEquals(result.evaluatedAt, "2026-05-28T10:30:00.000Z");
});
