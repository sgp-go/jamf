/**
 * 合規政策批量評估 + 歷史(PRD §5.5)。
 *
 * 上層 service:
 *   - CRUD compliancePolicies
 *   - batchEvaluatePolicy:對該 tenant 所有 device 跑 evaluateCompliance,
 *     將結果寫入 deviceComplianceResults(append-only,保留歷史)
 *   - listLatestResults:取最新一次評估,可篩「只看不合規」
 *   - getDeviceHistory:設備歷史趨勢(時序倒序)
 *
 * 為什麼 append-only:歷史趨勢圖需要時序資料。資料保留靠 pg_cron 365 天清理
 * (跟 audit-webhook-retention 同一機制)。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  compliancePolicies,
  type CompliancePolicy as CompliancePolicyRow,
  deviceComplianceResults,
  type DeviceComplianceResult as DeviceComplianceResultRow,
} from "~/db/schema/compliance.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import {
  evaluateCompliance,
  type CompliancePolicy as PolicyEngineInput,
  type ComplianceResult,
} from "./compliance.ts";

// ============================================================
// CRUD
// ============================================================

export interface CompliancePolicyDto {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  minOSVersion: string | null;
  maxOfflineDays: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function toPolicyDto(row: CompliancePolicyRow): CompliancePolicyDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    minOSVersion: row.minOsVersion,
    maxOfflineDays: row.maxOfflineDays,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreatePolicyInput {
  name: string;
  description?: string | null;
  minOSVersion?: string | null;
  maxOfflineDays?: number | null;
  isActive?: boolean;
}

export async function createPolicy(opts: {
  tenantId: string;
  input: CreatePolicyInput;
}): Promise<CompliancePolicyDto> {
  if (
    opts.input.minOSVersion == null &&
    opts.input.maxOfflineDays == null
  ) {
    throw new AppError(
      400,
      "empty_policy",
      "Policy must specify at least one rule (minOSVersion or maxOfflineDays)",
    );
  }
  const [row] = await db
    .insert(compliancePolicies)
    .values({
      tenantId: opts.tenantId,
      name: opts.input.name,
      description: opts.input.description ?? null,
      minOsVersion: opts.input.minOSVersion ?? null,
      maxOfflineDays: opts.input.maxOfflineDays ?? null,
      isActive: opts.input.isActive ?? true,
    })
    .returning();
  return toPolicyDto(row);
}

export async function listPolicies(opts: {
  tenantId: string;
  activeOnly?: boolean;
}): Promise<CompliancePolicyDto[]> {
  const conds = [eq(compliancePolicies.tenantId, opts.tenantId)];
  if (opts.activeOnly) conds.push(eq(compliancePolicies.isActive, true));
  const rows = await db
    .select()
    .from(compliancePolicies)
    .where(and(...conds))
    .orderBy(desc(compliancePolicies.createdAt));
  return rows.map(toPolicyDto);
}

export async function getPolicy(opts: {
  tenantId: string;
  policyId: string;
}): Promise<CompliancePolicyDto> {
  const row = await db.query.compliancePolicies.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.policyId), eqOp(t.tenantId, opts.tenantId)),
  });
  if (!row) {
    throw new AppError(404, "policy_not_found", "Compliance policy not found");
  }
  return toPolicyDto(row);
}

export interface UpdatePolicyInput {
  name?: string;
  description?: string | null;
  minOSVersion?: string | null;
  maxOfflineDays?: number | null;
  isActive?: boolean;
}

export async function updatePolicy(opts: {
  tenantId: string;
  policyId: string;
  patch: UpdatePolicyInput;
}): Promise<CompliancePolicyDto> {
  const set: Record<string, unknown> = {};
  const p = opts.patch;
  if (p.name !== undefined) set.name = p.name;
  if (p.description !== undefined) set.description = p.description;
  if (p.minOSVersion !== undefined) set.minOsVersion = p.minOSVersion;
  if (p.maxOfflineDays !== undefined) set.maxOfflineDays = p.maxOfflineDays;
  if (p.isActive !== undefined) set.isActive = p.isActive;
  if (Object.keys(set).length === 0) {
    return getPolicy(opts);
  }
  const [row] = await db
    .update(compliancePolicies)
    .set(set)
    .where(
      and(
        eq(compliancePolicies.id, opts.policyId),
        eq(compliancePolicies.tenantId, opts.tenantId),
      ),
    )
    .returning();
  if (!row) {
    throw new AppError(404, "policy_not_found", "Compliance policy not found");
  }
  return toPolicyDto(row);
}

export async function deletePolicy(opts: {
  tenantId: string;
  policyId: string;
}): Promise<void> {
  const result = await db
    .delete(compliancePolicies)
    .where(
      and(
        eq(compliancePolicies.id, opts.policyId),
        eq(compliancePolicies.tenantId, opts.tenantId),
      ),
    )
    .returning({ id: compliancePolicies.id });
  if (result.length === 0) {
    throw new AppError(404, "policy_not_found", "Compliance policy not found");
  }
}

// ============================================================
// 批量評估
// ============================================================

export interface BatchEvaluateSummary {
  policyId: string;
  evaluatedAt: string;
  total: number;
  compliant: number;
  nonCompliant: number;
}

/**
 * 對指定 tenant 下所有已 enroll 設備跑該 policy。
 *
 * - 撈設備 columns: id / osVersion / lastSeenAt(僅 evaluateCompliance 需要)
 * - 純函式評估,結果批量 INSERT(append-only,保留歷史)
 * - 同次 evaluateAt 用同一 timestamp,方便後續按 evaluateAt 聚合
 */
export async function batchEvaluatePolicy(opts: {
  tenantId: string;
  policyId: string;
}): Promise<BatchEvaluateSummary> {
  const policy = await getPolicy(opts);
  if (!policy.isActive) {
    throw new AppError(
      400,
      "policy_inactive",
      "Cannot evaluate an inactive policy",
    );
  }
  const policyForEngine: PolicyEngineInput = {
    id: policy.id,
    name: policy.name,
    minOSVersion: policy.minOSVersion ?? undefined,
    maxOfflineDays: policy.maxOfflineDays ?? undefined,
  };

  const devices = await db
    .select({
      id: mdmDevices.id,
      osVersion: mdmDevices.osVersion,
      lastSeenAt: mdmDevices.lastSeenAt,
    })
    .from(mdmDevices)
    .where(eq(mdmDevices.tenantId, opts.tenantId));

  const evaluatedAt = new Date();
  const rows: Array<{
    tenantId: string;
    policyId: string;
    deviceId: string;
    compliant: boolean;
    violations: unknown[];
    evaluatedAt: Date;
  }> = [];
  let compliant = 0;
  let nonCompliant = 0;

  for (const d of devices) {
    const r: ComplianceResult = evaluateCompliance(
      { osVersion: d.osVersion, lastSeenAt: d.lastSeenAt },
      policyForEngine,
      evaluatedAt,
    );
    rows.push({
      tenantId: opts.tenantId,
      policyId: opts.policyId,
      deviceId: d.id,
      compliant: r.compliant,
      violations: r.violations,
      evaluatedAt,
    });
    if (r.compliant) compliant++;
    else nonCompliant++;
  }

  if (rows.length > 0) {
    // Postgres 預設單 INSERT 不能超 ~65k 參數(每筆 7 欄 → 上限約 9k 設備),
    // 8000 台 PRD 規模仍在範圍內;真上萬時改 chunk 即可
    await db.insert(deviceComplianceResults).values(rows);
  }

  return {
    policyId: opts.policyId,
    evaluatedAt: evaluatedAt.toISOString(),
    total: devices.length,
    compliant,
    nonCompliant,
  };
}

// ============================================================
// 查詢
// ============================================================

export interface ComplianceResultDto {
  id: string;
  policyId: string;
  deviceId: string;
  compliant: boolean;
  violations: unknown[];
  evaluatedAt: string;
}

function toResultDto(row: DeviceComplianceResultRow): ComplianceResultDto {
  return {
    id: row.id,
    policyId: row.policyId,
    deviceId: row.deviceId,
    compliant: row.compliant,
    violations: row.violations,
    evaluatedAt: row.evaluatedAt.toISOString(),
  };
}

/**
 * 取 policy 最新一次評估的所有設備結果(同 evaluatedAt)。
 *
 * 用 DISTINCT ON 取每台設備最近一筆,而非依賴「同 batch 的 evaluatedAt 相同」假設
 * — 真實情況可能跨多次 evaluate,我們要的是「設備當前狀態」。
 *
 * @param onlyNonCompliant true 時只回不合規設備(PRD §5.5「設備清單可篩選查看所有不合規」)
 */
export async function listLatestResults(opts: {
  tenantId: string;
  policyId: string;
  onlyNonCompliant?: boolean;
}): Promise<ComplianceResultDto[]> {
  const onlyNc = opts.onlyNonCompliant === true;
  const rows = await db.execute<{
    id: string;
    policy_id: string;
    device_id: string;
    compliant: boolean;
    violations: unknown[];
    evaluated_at: Date;
  }>(sql`
    SELECT DISTINCT ON (device_id)
      id, policy_id, device_id, compliant, violations, evaluated_at
    FROM device_compliance_results
    WHERE tenant_id = ${opts.tenantId} AND policy_id = ${opts.policyId}
    ORDER BY device_id, evaluated_at DESC
  `);
  const filtered = onlyNc ? rows.filter((r) => !r.compliant) : rows;
  return filtered.map((r) => ({
    id: r.id,
    policyId: r.policy_id,
    deviceId: r.device_id,
    compliant: r.compliant,
    violations: r.violations,
    evaluatedAt: new Date(r.evaluated_at).toISOString(),
  }));
}

/**
 * 設備合規歷史(時序倒序,跨所有 policy)。
 * 供 PRD §5.5 「歷史趨勢」查詢。
 */
export async function getDeviceHistory(opts: {
  tenantId: string;
  deviceId: string;
  limit?: number;
}): Promise<ComplianceResultDto[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = await db
    .select()
    .from(deviceComplianceResults)
    .where(
      and(
        eq(deviceComplianceResults.tenantId, opts.tenantId),
        eq(deviceComplianceResults.deviceId, opts.deviceId),
      ),
    )
    .orderBy(desc(deviceComplianceResults.evaluatedAt))
    .limit(limit);
  return rows.map(toResultDto);
}
