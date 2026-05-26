import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { apps, type App } from "~/db/schema/apps.ts";
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

export async function listAppsByTenant(
  tenantId: string,
): Promise<App[]> {
  return db
    .select()
    .from(apps)
    .where(eq(apps.tenantId, tenantId))
    .orderBy(desc(apps.createdAt));
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
