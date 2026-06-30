import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { apps, appAssignments, type App } from "~/db/schema/apps.ts";
import { AppError } from "~/lib/errors.ts";

/**
 * App 安裝包託管基礎設施。
 *
 * 存儲策略：本地檔案系統（MVP），生產可換 S3/Blob Storage（只需替換
 * writeFile / unlink / 下載 endpoint 的讀取邏輯）。
 *
 * 檔案佈局：
 *   data/apps/{appId}.{ext}
 *
 * 不在路徑中放 tenant_id 是為了：
 *   - 全平台共用 App (tenantId=null) 跟租戶私有 App 統一處理
 *   - 隔離由 service 層查詢時做（admin endpoint 必帶 tenantId）
 *   - 下載端點只需 appId 即可定位檔案
 */

const STORAGE_DIR = resolve(process.env.APPS_STORAGE_DIR ?? "data/apps");
const MAX_FILE_BYTES = Number(process.env.APPS_MAX_FILE_BYTES ?? 500 * 1024 * 1024);

/** 確保儲存目錄存在（首次上傳時建立）*/
function ensureStorageDir(): void {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

/** 副檔名對應 app_kind */
function inferAppKindFromFilename(
  filename: string,
): App["kind"] | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".msi")) return "msi";
  if (lower.endsWith(".exe")) return "exe";
  if (lower.endsWith(".msix") || lower.endsWith(".msixbundle") || lower.endsWith(".appx")) {
    return "msix";
  }
  if (lower.endsWith(".mobileconfig")) return "mobileconfig";
  return null;
}

function extensionFromKind(kind: App["kind"]): string {
  switch (kind) {
    case "msi":
      return "msi";
    case "exe":
      return "exe";
    case "msix":
      return "msix";
    case "mobileconfig":
      return "mobileconfig";
    case "ipa_custom":
      return "ipa";
    case "winget":
      // winget 不存本地檔案，但 extensionFromKind 在 deleteApp 路徑會被呼叫；
      // 回傳 dummy 值，呼叫端配合 row.fileUrl=null 判斷跳過 unlink
      return "winget";
  }
}

/** 對外可見的 App DTO（不洩漏內部檔案絕對路徑） */
export interface AppDto {
  id: string;
  tenantId: string | null;
  platform: App["platform"];
  kind: App["kind"];
  displayName: string;
  bundleId: string | null;
  version: string;
  fileUrl: string | null;
  fileHash: string | null;
  fileSizeBytes: number | null;
  signedBy: string | null;
  installArgs: string | null;
  iTunesStoreId: number | null;
  /** App 分類標籤（PRD §5.3），自由字串 */
  category: string | null;
  /** 已購買授權數;null = 無限制（PRD §5.3） */
  licenseCount: number | null;
  /** 授權備註（採購合同編號等） */
  licenseNotes: string | null;
  /** winget 包 ID（kind=winget 時必填），例 `Microsoft.VisualStudioCode` */
  wingetId: string | null;
  /** winget source 名稱：`winget`（公共）/ `msstore` / `cogrow-{tenantSlug}`（私有） */
  wingetSource: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: App, publicBaseUrl?: string): AppDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    platform: row.platform,
    kind: row.kind,
    displayName: row.displayName,
    bundleId: row.bundleId,
    version: row.version,
    fileUrl: row.fileUrl
      ? publicBaseUrl
        ? `${publicBaseUrl}${row.fileUrl}`
        : row.fileUrl
      : null,
    fileHash: row.fileHash,
    fileSizeBytes: row.fileSizeBytes,
    signedBy: row.signedBy,
    installArgs: row.installArgs,
    iTunesStoreId: row.iTunesStoreId,
    category: row.category,
    licenseCount: row.licenseCount,
    licenseNotes: row.licenseNotes,
    wingetId: row.wingetId,
    wingetSource: row.wingetSource,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface UploadAppInput {
  tenantId: string;
  displayName: string;
  version: string;
  /** 原始檔名（用於推斷副檔名 + kind）*/
  filename: string;
  /** 安裝包二進制內容 */
  fileBytes: Uint8Array;
  /** 顯式指定 kind；省略則從 filename 推斷 */
  kind?: App["kind"];
  /** Bundle ID（Windows MSI = ProductCode、iOS = bundleId、msix = PFN） */
  bundleId?: string | null;
  /** 安裝命令行（如 msi 的 "/quiet /norestart"） */
  installArgs?: string | null;
  /** 簽名者識別（如 "CoGrow Code Signing"），方便審計 */
  signedBy?: string | null;
  /** App 分類（PRD §5.3） */
  category?: string | null;
  /** 已購買授權數;null = 無限制（PRD §5.3） */
  licenseCount?: number | null;
  /** 授權備註（採購合同編號等） */
  licenseNotes?: string | null;
}

/**
 * 上傳並儲存安裝包。
 *
 * 同步流程（單次 request 完成）：
 *  1. 推斷／驗證 kind
 *  2. 寫檔到 data/apps/{appId}.{ext}
 *  3. 計算 SHA-256
 *  4. INSERT apps row
 *
 * fileUrl 存的是相對路徑（如 /api/v1/apps/{appId}/download/{name}.msi），
 * 對外回傳時可由 service 層拼上 publicBaseUrl。
 */
export async function uploadApp(input: UploadAppInput): Promise<App> {
  if (input.fileBytes.byteLength === 0) {
    throw new AppError(400, "empty_file", "Uploaded file is empty");
  }
  if (input.fileBytes.byteLength > MAX_FILE_BYTES) {
    throw new AppError(
      413,
      "file_too_large",
      `File exceeds max size ${MAX_FILE_BYTES} bytes`,
    );
  }

  const inferred = inferAppKindFromFilename(input.filename);
  const kind = input.kind ?? inferred;
  if (!kind) {
    throw new AppError(
      400,
      "unknown_app_kind",
      `Cannot infer app kind from filename "${input.filename}"; specify "kind" explicitly`,
    );
  }
  if (kind === "ipa_custom") {
    throw new AppError(
      400,
      "ipa_custom_no_binary",
      "iOS Custom App is distributed via ABM/ASM; do not upload IPA binary",
    );
  }

  const platform: App["platform"] = kind === "msi" || kind === "exe" || kind === "msix"
    ? "windows"
    : "apple";

  ensureStorageDir();

  const fileHash = createHash("sha256").update(input.fileBytes).digest("hex");

  // 先 insert 拿 id，再用 id 寫檔
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const [row] = await db
    .insert(apps)
    .values({
      tenantId: input.tenantId,
      platform,
      kind,
      displayName: input.displayName,
      bundleId: input.bundleId ?? null,
      version: input.version,
      fileHash,
      fileSizeBytes: input.fileBytes.byteLength,
      installArgs: input.installArgs ?? null,
      signedBy: input.signedBy ?? null,
      category: input.category ?? null,
      licenseCount: input.licenseCount ?? null,
      licenseNotes: input.licenseNotes ?? null,
    })
    .returning();
  if (!row) {
    throw new Error("Insert apps returned no row");
  }

  const ext = extensionFromKind(kind);
  const storedFilename = `${row.id}.${ext}`;
  const storagePath = join(STORAGE_DIR, storedFilename);

  try {
    await writeFile(storagePath, input.fileBytes);
  } catch (err) {
    // 寫檔失敗回滾 DB row 避免懸掛
    await db.delete(apps).where(eq(apps.id, row.id));
    throw new AppError(
      500,
      "file_write_failed",
      `Failed to write app binary: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fileUrl = `/api/v1/apps/${row.id}/download/${encodeURIComponent(safeName)}`;
  const [updated] = await db
    .update(apps)
    .set({ fileUrl })
    .where(eq(apps.id, row.id))
    .returning();
  return updated ?? row;
}

/**
 * winget App 上架（不上傳二進制）。
 *
 * 跟 uploadApp 的差異：
 * - 無 file binary、無 SHA-256、無 storage path
 * - kind 強制 `winget`、platform 強制 `windows`
 * - wingetId + wingetSource 必填（source 預設 `winget` 公共源）
 * - 同 tenant 同 wingetId 唯一（由 DB unique index 強制）
 *
 * 版本字串 `version` 接受 `latest`（winget 預設裝最新）或具體版本（`1.95.0`）。
 */
export interface CreateWingetAppInput {
  tenantId: string;
  wingetId: string;
  displayName: string;
  /** 預設 `winget` 公共源 */
  wingetSource?: string;
  /** 預設 `latest`，winget 不需固定版本 */
  version?: string;
  category?: string | null;
  licenseCount?: number | null;
  licenseNotes?: string | null;
}

export async function createWingetApp(input: CreateWingetAppInput): Promise<App> {
  if (!input.wingetId || input.wingetId.trim().length === 0) {
    throw new AppError(400, "missing_winget_id", "wingetId is required");
  }
  if (!input.displayName || input.displayName.trim().length === 0) {
    throw new AppError(400, "missing_display_name", "displayName is required");
  }

  const wingetId = input.wingetId.trim();
  const wingetSource = (input.wingetSource ?? "winget").trim();
  const version = (input.version ?? "latest").trim();

  try {
    const [row] = await db
      .insert(apps)
      .values({
        tenantId: input.tenantId,
        platform: "windows",
        kind: "winget",
        displayName: input.displayName,
        version,
        wingetId,
        wingetSource,
        category: input.category ?? null,
        licenseCount: input.licenseCount ?? null,
        licenseNotes: input.licenseNotes ?? null,
      })
      .returning();
    if (!row) {
      throw new Error("Insert apps returned no row");
    }
    return row;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("apps_tenant_winget_id_uq")) {
      throw new AppError(
        409,
        "winget_app_already_exists",
        `winget app "${wingetId}" already exists for this tenant`,
      );
    }
    throw err;
  }
}

export async function listAppsByTenant(
  tenantId: string,
  opts?: { category?: string },
): Promise<App[]> {
  const conds = [eq(apps.tenantId, tenantId)];
  if (opts?.category) {
    conds.push(eq(apps.category, opts.category));
  }
  return db
    .select()
    .from(apps)
    .where(and(...conds))
    .orderBy(desc(apps.createdAt));
}

/**
 * 更新 App metadata（不動檔案）— 分類、授權數、備註、displayName 等。
 *
 * 三態 patch 語意：
 *   - undefined：不動
 *   - null：清空（category=null / licenseCount=null）
 *   - 具體值：寫入
 *
 * 注意：file / version / fileHash / kind 不可此處改（檔案邏輯不一致風險），
 * 要換二進制請刪了重傳。
 */
export interface UpdateAppMetadataInput {
  displayName?: string;
  bundleId?: string | null;
  installArgs?: string | null;
  signedBy?: string | null;
  category?: string | null;
  licenseCount?: number | null;
  licenseNotes?: string | null;
}

export async function updateAppMetadata(opts: {
  tenantId: string;
  appId: string;
  patch: UpdateAppMetadataInput;
}): Promise<App> {
  const existing = await getAppById({ appId: opts.appId, tenantId: opts.tenantId });
  if (existing.tenantId !== opts.tenantId) {
    throw new AppError(403, "forbidden", "App belongs to another tenant");
  }
  const set: Record<string, unknown> = {};
  const p = opts.patch;
  if (p.displayName !== undefined) set.displayName = p.displayName;
  if (p.bundleId !== undefined) set.bundleId = p.bundleId;
  if (p.installArgs !== undefined) set.installArgs = p.installArgs;
  if (p.signedBy !== undefined) set.signedBy = p.signedBy;
  if (p.category !== undefined) set.category = p.category;
  if (p.licenseCount !== undefined) set.licenseCount = p.licenseCount;
  if (p.licenseNotes !== undefined) set.licenseNotes = p.licenseNotes;
  if (Object.keys(set).length === 0) {
    return existing;
  }
  const [updated] = await db
    .update(apps)
    .set(set)
    .where(eq(apps.id, opts.appId))
    .returning();
  if (!updated) {
    throw new AppError(404, "app_not_found", "App not found");
  }
  return updated;
}

/**
 * 授權使用情況統計（PRD §5.3「平台追蹤已派發數量,超過授權數量時警示」）。
 *
 * - assigned：所有 active 派發（pending / installing / installed），代表「佔用授權」的數
 * - installed：實際安裝完成（status=installed）
 * - licenseCount：總授權數，null 視為無限制
 * - overLimit：licenseCount 非 null 且 assigned > licenseCount
 *
 * 計算邏輯故意算 distinct device_id：同台設備同 app 多次 assignment（如重派）只算一個佔用。
 */
export interface AppLicenseUsage {
  appId: string;
  licenseCount: number | null;
  assigned: number;
  installed: number;
  overLimit: boolean;
  remaining: number | null;
}

export async function getAppLicenseUsage(opts: {
  tenantId: string;
  appId: string;
}): Promise<AppLicenseUsage> {
  const app = await getAppById({ appId: opts.appId, tenantId: opts.tenantId });
  const rows = await db
    .select({
      assigned: sql<number>`COUNT(DISTINCT CASE WHEN ${appAssignments.status} IN ('pending','installing','installed') THEN ${appAssignments.deviceId} END)::int`,
      installed: sql<number>`COUNT(DISTINCT CASE WHEN ${appAssignments.status} = 'installed' THEN ${appAssignments.deviceId} END)::int`,
    })
    .from(appAssignments)
    .where(eq(appAssignments.appId, opts.appId));
  const assigned = rows[0]?.assigned ?? 0;
  const installed = rows[0]?.installed ?? 0;
  const limit = app.licenseCount;
  const overLimit = limit !== null && assigned > limit;
  const remaining = limit === null ? null : Math.max(0, limit - assigned);
  return {
    appId: opts.appId,
    licenseCount: limit,
    assigned,
    installed,
    overLimit,
    remaining,
  };
}

export async function getAppById(opts: {
  appId: string;
  tenantId?: string;
}): Promise<App> {
  const row = await db.query.apps.findFirst({
    where: (t, { and: andOp, eq: eqOp }) => {
      const cond = eqOp(t.id, opts.appId);
      return opts.tenantId !== undefined ? andOp(cond, eqOp(t.tenantId, opts.tenantId)) : cond;
    },
  });
  if (!row) {
    throw new AppError(404, "app_not_found", "App not found");
  }
  return row;
}

export async function deleteApp(opts: { appId: string; tenantId: string }): Promise<void> {
  const row = await getAppById(opts);
  if (row.tenantId !== opts.tenantId) {
    throw new AppError(403, "forbidden", "App belongs to another tenant");
  }
  if (row.fileUrl) {
    const ext = extensionFromKind(row.kind);
    const storagePath = join(STORAGE_DIR, `${row.id}.${ext}`);
    try {
      await unlink(storagePath);
    } catch {
      // 檔案不存在不算錯，繼續刪 DB row
    }
  }
  await db.delete(apps).where(eq(apps.id, row.id));
}

/**
 * 從 DB row 解析出實體檔案的絕對路徑（供下載 endpoint 用）。
 * 找不到檔案會拋 404（DB row 存在但檔案缺失，視為損壞狀態）。
 */
export async function resolveAppFile(appId: string): Promise<{
  path: string;
  size: number;
  filename: string;
  kind: App["kind"];
}> {
  const row = await getAppById({ appId });
  if (!row.fileUrl) {
    throw new AppError(404, "app_has_no_binary", "App has no binary file");
  }
  const ext = extensionFromKind(row.kind);
  const storagePath = join(STORAGE_DIR, `${row.id}.${ext}`);
  let size: number;
  try {
    const s = await stat(storagePath);
    size = s.size;
  } catch {
    throw new AppError(404, "app_file_missing", "App binary missing on disk");
  }
  return {
    path: storagePath,
    size,
    filename: `${row.displayName}-${row.version}.${ext}`,
    kind: row.kind,
  };
}

export { toDto as toAppDto };
