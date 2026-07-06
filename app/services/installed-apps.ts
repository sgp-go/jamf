/**
 * MSI / Win32 已裝軟體清單服務（PRD §4.2 App 安裝清單 Inventory）。
 *
 * Agent 上報策略：**全量替換** —— Agent 每次上報 = 該設備當前完整清單快照，
 * backend upsert 全部 + 刪除本次沒回報的 row（依 lastSyncedAt < now 的 stale row）。
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  mdmInstalledWin32Apps,
  type MdmInstalledWin32App,
  type NewMdmInstalledWin32App,
} from "~/db/schema/installed-apps.ts";

export interface InstalledAppReport {
  uninstallKey: string;
  displayName: string;
  displayVersion?: string | null;
  publisher?: string | null;
  installDate?: string | null;
  estimatedSizeKb?: number | null;
  uninstallString?: string | null;
}

export interface ReplaceInstalledAppsResult {
  upserted: number;
  removed: number;
}

/**
 * Agent 全量上報：upsert 傳入的每筆 + 刪除本設備上其他所有沒在本次 payload 的 row。
 * 用 transaction 保證原子（部分成功會導致清單狀態不一致）。
 */
export async function replaceInstalledApps(opts: {
  tenantId: string;
  deviceId: string;
  apps: InstalledAppReport[];
}): Promise<ReplaceInstalledAppsResult> {
  const now = new Date();
  const uniqueKeys = new Set<string>();
  const rows: NewMdmInstalledWin32App[] = [];
  for (const a of opts.apps) {
    // Agent 端可能上報重複的 uninstallKey（例如同名雙 hive）；去重取首個
    if (uniqueKeys.has(a.uninstallKey)) continue;
    uniqueKeys.add(a.uninstallKey);
    rows.push({
      tenantId: opts.tenantId,
      deviceId: opts.deviceId,
      uninstallKey: a.uninstallKey,
      displayName: a.displayName,
      displayVersion: a.displayVersion ?? null,
      publisher: a.publisher ?? null,
      installDate: a.installDate ?? null,
      estimatedSizeKb: a.estimatedSizeKb ?? null,
      uninstallString: a.uninstallString ?? null,
      lastSyncedAt: now,
    });
  }

  return await db.transaction(async (tx) => {
    // 1) upsert 本次全部 row（onConflict 更新 metadata + lastSyncedAt）
    if (rows.length > 0) {
      await tx
        .insert(mdmInstalledWin32Apps)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            mdmInstalledWin32Apps.deviceId,
            mdmInstalledWin32Apps.uninstallKey,
          ],
          set: {
            displayName: sql`excluded.display_name`,
            displayVersion: sql`excluded.display_version`,
            publisher: sql`excluded.publisher`,
            installDate: sql`excluded.install_date`,
            estimatedSizeKb: sql`excluded.estimated_size_kb`,
            uninstallString: sql`excluded.uninstall_string`,
            lastSyncedAt: now,
          },
        });
    }
    // 2) 刪 stale row（lastSyncedAt < now 表示本次沒上報）
    const removed = await tx
      .delete(mdmInstalledWin32Apps)
      .where(
        and(
          eq(mdmInstalledWin32Apps.deviceId, opts.deviceId),
          lt(mdmInstalledWin32Apps.lastSyncedAt, now),
        ),
      )
      .returning({ id: mdmInstalledWin32Apps.id });

    return { upserted: rows.length, removed: removed.length };
  });
}

export async function listInstalledApps(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<MdmInstalledWin32App[]> {
  return db
    .select()
    .from(mdmInstalledWin32Apps)
    .where(
      and(
        eq(mdmInstalledWin32Apps.tenantId, opts.tenantId),
        eq(mdmInstalledWin32Apps.deviceId, opts.deviceId),
      ),
    );
}
