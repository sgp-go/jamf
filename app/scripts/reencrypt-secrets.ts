/**
 * 金鑰輪換 CLI：把所有 `*_enc` 欄位從舊金鑰重新加密為新金鑰。
 *
 * 配套文檔：docs/encryption-key-management.md §6（輪換）。對應 SOP 的維護窗口前提——
 * 跑此腳本前須暫停所有會寫 `*_enc` 欄位的操作（install-agent / laps-rotate /
 * mdm-config / jamf-instances 寫入 / DEP token 上傳）。
 *
 * 顯式傳入新舊兩把金鑰（不從 env 讀），避免靠切換 DATA_ENCRYPTION_KEY 製造併發污染。
 *
 * 兩種跑法：
 *   1. dry-run（預設）：逐行用 old-key 解密驗證 + 統計，**不寫庫**。先跑這個確認全部能解開。
 *      deno task reencrypt-secrets --old-key <base64> --new-key <base64>
 *   2. --execute：在單一事務內全表重寫，中途任一行失敗 → 整體 rollback。
 *      deno task reencrypt-secrets --old-key <base64> --new-key <base64> --execute
 *
 * 輪換完成後，把進程 env 的 DATA_ENCRYPTION_KEY 切為 new-key 並重啟服務（見 SOP §6 步驟 4-6）。
 *
 * 退出碼：0=成功（dry-run 全部可解 / execute 寫入完成）；1=錯誤（金鑰不符、解密失敗等）。
 */

import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  depTokens,
  jamfInstances,
  mdmWindowsBitlocker,
  mdmWindowsLaps,
  selfMdmConfigs,
} from "~/db/schema/index.ts";
import {
  decryptWith,
  encryptWith,
  isEncrypted,
  parseKeyBase64,
} from "~/lib/secrets.ts";

// deno-lint-ignore no-explicit-any
type AnyTable = any;

/** 要輪換的表與其加密欄位（屬性名 = Drizzle camelCase 欄位名）。 */
const TARGETS: { label: string; table: AnyTable; columns: string[] }[] = [
  { label: "jamf_instances", table: jamfInstances, columns: ["clientSecretEnc"] },
  { label: "mdm_windows_laps", table: mdmWindowsLaps, columns: ["passwordEnc"] },
  {
    label: "mdm_windows_bitlocker",
    table: mdmWindowsBitlocker,
    columns: ["recoveryPasswordEnc"],
  },
  {
    label: "self_mdm_configs",
    table: selfMdmConfigs,
    columns: ["apnsKeyPemEnc", "caKeyPemEnc", "vendorKeyPemEnc"],
  },
  {
    label: "dep_tokens",
    table: depTokens,
    columns: ["consumerSecretEnc", "accessSecretEnc"],
  },
];

interface TargetStats {
  label: string;
  rows: number;
  fieldsReencrypted: number;
  legacyUpgraded: number;
}

function fail(message: string): never {
  console.error(`[reencrypt] ✗ ${message}`);
  Deno.exit(1);
}

async function run() {
  const flags = parseArgs(Deno.args, {
    string: ["old-key", "new-key"],
    boolean: ["execute"],
    default: { execute: false },
  });

  if (!flags["old-key"] || !flags["new-key"]) {
    fail("必須提供 --old-key 與 --new-key（base64 編碼的 32 bytes 金鑰）");
  }

  let oldKey: Buffer;
  let newKey: Buffer;
  try {
    oldKey = parseKeyBase64(flags["old-key"]);
    newKey = parseKeyBase64(flags["new-key"]);
  } catch (e) {
    fail(`金鑰解析失敗：${e instanceof Error ? e.message : String(e)}`);
  }

  if (oldKey.equals(newKey)) {
    fail("--old-key 與 --new-key 相同，無需輪換");
  }

  const execute = flags.execute === true;
  console.log(
    `[reencrypt] 模式：${execute ? "EXECUTE（寫庫，單事務）" : "DRY-RUN（僅驗證，不寫庫）"}`,
  );

  // 處理單一 runner（db 或 tx）下的全部 target，回傳統計。
  // dry-run 與 execute 共用此邏輯：差別只在最後是否真的 UPDATE。
  // deno-lint-ignore no-explicit-any
  const processAll = async (runner: any): Promise<TargetStats[]> => {
    const stats: TargetStats[] = [];
    for (const target of TARGETS) {
      const rows = await runner.select().from(target.table);
      let fieldsReencrypted = 0;
      let legacyUpgraded = 0;

      for (const row of rows) {
        const r = row as Record<string, string | null>;
        const setObj: Record<string, string> = {};

        for (const col of target.columns) {
          const val = r[col];
          if (!val) continue; // null / 空字串：跳過

          let plain: string;
          if (isEncrypted(val)) {
            try {
              plain = decryptWith(oldKey, val);
            } catch {
              fail(
                `${target.label}.${col} (id=${r.id}) 用 old-key 解密失敗——` +
                  `金鑰不符，或該行已用 new-key 加密（重複執行？）。已中止，未寫入任何資料。`,
              );
            }
          } else {
            plain = val; // legacy 明文 → 直接用 new-key 升級為密文
            legacyUpgraded++;
          }
          setObj[col] = encryptWith(newKey, plain);
          fieldsReencrypted++;
        }

        if (execute && Object.keys(setObj).length > 0) {
          await runner.update(target.table).set(setObj).where(
            eq(target.table.id, r.id),
          );
        }
      }

      stats.push({
        label: target.label,
        rows: rows.length,
        fieldsReencrypted,
        legacyUpgraded,
      });
    }
    return stats;
  };

  const stats = execute
    ? await db.transaction((tx) => processAll(tx))
    : await processAll(db);

  console.log("\n[reencrypt] 結果：");
  let totalFields = 0;
  let totalLegacy = 0;
  for (const s of stats) {
    console.log(
      `  ${s.label.padEnd(24)} rows=${s.rows}  重加密欄位=${s.fieldsReencrypted}` +
        (s.legacyUpgraded > 0 ? `  （其中 legacy 明文升級=${s.legacyUpgraded}）` : ""),
    );
    totalFields += s.fieldsReencrypted;
    totalLegacy += s.legacyUpgraded;
  }
  console.log(`  合計：重加密 ${totalFields} 個欄位，legacy 升級 ${totalLegacy} 個`);

  if (execute) {
    console.log(
      "\n[reencrypt] ✓ 寫入完成。下一步：將服務 env 的 DATA_ENCRYPTION_KEY 切為 new-key 並重啟，" +
        "抽樣驗證 laps-password / bitlocker-recovery 可正常解密（SOP §6 步驟 4-6）。",
    );
  } else {
    console.log(
      "\n[reencrypt] ✓ DRY-RUN 通過：全部密文均可用 old-key 解開。確認無誤後加 --execute 正式輪換。",
    );
  }
  Deno.exit(0);
}

run().catch((e) => fail(e instanceof Error ? e.message : String(e)));
