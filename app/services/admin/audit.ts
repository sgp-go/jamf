import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { auditLogs, type AuditLog, type NewAuditLog } from "~/db/schema/audit.ts";

/**
 * Audit log service：寫入 + 查詢。
 *
 * 設計取捨：
 * - 寫入 fire-and-forget（catch error 但不 throw）— audit 失敗不該擋業務流
 * - 查詢用 core query db.select（不用 findMany，per project memory drizzle list 慢）
 * - actor 由 caller 提供；helper extractActor / extractRequestMeta 統一從 hono ctx 抓
 */

export interface LogAuditInput {
  tenantId: string;
  /** "admin:<email>" / "service:<key>" / "system" */
  actor: string;
  /** 動詞短語：device.transfer / profile.assign / app.install / preset.create_blocked_sites */
  action: string;
  /** 操作對象類型：device / profile / app / tenant / preset / compliance */
  resourceType: string;
  resourceId?: string | null;
  /** 操作 diff 或 request body 摘要 */
  payload?: Record<string, unknown> | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 寫一條 audit log。永不拋錯（業務流不該被 audit 失敗擋）。
 * 失敗時印 console.error 讓 ops 看見。
 */
export async function logAudit(input: LogAuditInput): Promise<void> {
  try {
    const row: NewAuditLog = {
      tenantId: input.tenantId,
      actor: input.actor,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      payload: input.payload ?? null,
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    };
    await db.insert(auditLogs).values(row);
  } catch (err) {
    console.error("[audit] logAudit failed:", err);
  }
}

export interface ListAuditOptions {
  tenantId: string;
  page: number;
  limit: number;
  /** 過濾：action 前綴匹配（如 "profile." 抓 profile.* 全部） */
  actionPrefix?: string;
  /** 過濾：resourceType 完全相等 */
  resourceType?: string;
  /** 過濾：actor 前綴匹配（如 "admin:" 抓所有 admin 操作） */
  actorPrefix?: string;
  /** 過濾：created_at >= since */
  since?: Date;
  /** 過濾：created_at < until */
  until?: Date;
}

export interface ListAuditResult {
  rows: AuditLog[];
  total: number;
}

/**
 * 從 hono Context 抽 actor / IP / UA / request-id 元資料。
 *
 * actor 優先讀 X-Actor header（admin UI 顯式傳人類可讀身份，如
 * "admin:jay@cogrow.com"）；缺省用 "admin:bearer"。
 *
 * IP 嘗試 X-Forwarded-For（反向代理場景）→ X-Real-IP → fallback null。
 *
 * 用 minimal duck-typed interface 而非 import hono Context generic，避免 zod-openapi
 * 推出的窄 Context 型別與通用 Context<any> 不相容。
 */
interface HasHeaderAccess {
  req: { header(name: string): string | undefined };
}

export function extractAuditMeta(c: HasHeaderAccess): {
  actor: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
} {
  const actor = c.req.header("x-actor") ?? "admin:bearer";
  const forwarded = c.req.header("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    null;
  const userAgent = c.req.header("user-agent") ?? null;
  const requestId = c.req.header("x-request-id") ?? null;
  return { actor, ip, userAgent, requestId };
}

function buildAuditWhere(opts: Omit<ListAuditOptions, "page" | "limit">): SQL {
  const conditions: SQL[] = [eq(auditLogs.tenantId, opts.tenantId)];

  if (opts.actionPrefix) {
    conditions.push(sql`${auditLogs.action} LIKE ${opts.actionPrefix + "%"}`);
  }
  if (opts.resourceType) {
    conditions.push(eq(auditLogs.resourceType, opts.resourceType));
  }
  if (opts.actorPrefix) {
    conditions.push(sql`${auditLogs.actor} LIKE ${opts.actorPrefix + "%"}`);
  }
  if (opts.since) {
    conditions.push(gte(auditLogs.createdAt, opts.since));
  }
  if (opts.until) {
    conditions.push(lt(auditLogs.createdAt, opts.until));
  }

  return conditions.length === 1 ? conditions[0] : and(...conditions)!;
}

export async function listAuditLogs(opts: ListAuditOptions): Promise<ListAuditResult> {
  const where = buildAuditWhere(opts);

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db.select({ value: sql<number>`count(*)` }).from(auditLogs).where(where),
  ]);

  return {
    rows,
    total: Number(totalRows[0]?.value ?? 0),
  };
}

/** 每批撈取筆數（匯出用，平衡記憶體與往返次數） */
const EXPORT_BATCH_SIZE = 5000;
/** 單次匯出上限。超過時 truncated=true，caller 應提示用 since/until 縮小範圍 */
export const EXPORT_MAX_ROWS = 100_000;

export interface ExportAuditResult {
  rows: AuditLog[];
  /** true = 結果被 EXPORT_MAX_ROWS 截斷，未涵蓋全部符合條件的紀錄 */
  truncated: boolean;
}

/**
 * 匯出用查詢：批次撈取至上限，不做 count。
 *
 * ⚠️ caller 必須傳 `until`（建議用請求當下時間封頂）：audit 是 append-only +
 * desc 排序，匯出期間新寫入會讓 offset 分頁位移產生重複列；有 until 上界即穩定。
 */
export async function listAuditLogsExport(
  opts: Omit<ListAuditOptions, "page" | "limit"> & { until: Date },
): Promise<ExportAuditResult> {
  const where = buildAuditWhere(opts);
  const rows: AuditLog[] = [];

  while (rows.length < EXPORT_MAX_ROWS) {
    const batchLimit = Math.min(EXPORT_BATCH_SIZE, EXPORT_MAX_ROWS - rows.length);
    const batch = await db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(batchLimit)
      .offset(rows.length);
    rows.push(...batch);
    if (batch.length < batchLimit) {
      return { rows, truncated: false };
    }
  }

  // 撈滿上限後再探一筆，確認是否真的截斷
  const probe = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(1)
    .offset(rows.length);
  return { rows, truncated: probe.length > 0 };
}
