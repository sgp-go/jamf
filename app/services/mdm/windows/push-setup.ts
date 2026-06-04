/**
 * 設備 WNS push 自動配置（教育場景：註冊後自動讓設備具備秒級推送能力）。
 *
 * push 通道是「兩段式」依賴鏈,本模組負責前半段(註冊時可立即下發):
 *   1. 下發 push 簽名 cert 到設備信任庫(Root + TrustedPeople)→ 否則 MSIX sideload
 *      報 0x800B0109
 *   2. 派送 push-capable MSIX(Add + Exec HostedInstall)
 *
 * 後半段(push-config)必須等 MSIX 真正裝好才能下發(PFN CSP 要求對應 MSIX 已安裝,
 * 否則失敗),由 command.ts 在收到設備上報「push MSIX installed」的 inventory 後自動觸發。
 *
 * 見 brain：projects/jamf-explore/wiki/windows-mdm-anti-unenroll.md 同系列的 push 設計。
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { enqueueWindowsCommand } from "./command.ts";
import { buildInstallTrustedCert } from "./csp-cert.ts";
import {
  buildAppInventoryConfig,
  buildAppInventoryFetch,
  buildMsixInstall,
  buildMsixInstallAddNode,
  buildSetPollInterval,
} from "./csp.ts";
import { listAppsByTenant } from "~/services/apps.ts";

/**
 * push 簽名 cert（DER）相對專案根的路徑。
 *
 * ⚠️ 此檔**不入 git**（data/ 被 gitignore）——它是某環境 push MSIX 的配套簽名公鑰，
 * 綁該環境的 Store 註冊/PFN/WNS，跨環境無意義。各環境部署時自行生成並放到此路徑
 * （build push MSIX 時 Export-Certificate 導出的 .cer），見
 * docs/windows-deployment/device-provisioning-guide.md §9。缺檔時 push 配置會被 enrollment hook
 * 的 try-catch 攔下（不影響基本納管，命令仍走 polling）。
 */
const PUSH_CERT_PATH = "data/push-cert.cer";

export interface SetupPushResult {
  certThumbprint: string;
  pfn: string;
  contentUri: string;
  commandUuids: string[];
}

/**
 * 為單台設備啟動 push 配置流程：下發信任 cert + 派送 push MSIX。
 *
 * @throws 若 WNS_PFN 未配 / push MSIX(bundleId=PFN)未上傳 / cert 檔案缺失
 */
export async function setupDevicePush(opts: {
  udid: string;
  tenantId: string;
}): Promise<SetupPushResult> {
  const pfn = Deno.env.get("WNS_PFN");
  if (!pfn) throw new Error("WNS_PFN not configured");

  // 1. 讀 push cert → base64(DER) + SHA1 thumbprint
  const der = readFileSync(PUSH_CERT_PATH);
  const certDerBase64 = der.toString("base64");
  const thumbprint = createHash("sha1").update(der).digest("hex").toUpperCase();

  // 2. 查 push MSIX app（約定 bundleId = PFN）
  const apps = await listAppsByTenant(opts.tenantId);
  const pushApp = apps.find((a) => a.kind === "msix" && a.bundleId === pfn);
  if (!pushApp || !pushApp.fileUrl) {
    throw new Error(`push MSIX app (bundleId=${pfn}) not found for tenant ${opts.tenantId}`);
  }

  // 3. contentUri 用 tenant 配置的 publicBaseUrl（設備可達的穩定公網域名），
  //    不依賴請求 host（手動端點 curl localhost 會拿到 localhost）。
  const cfg = await db.query.selfMdmConfigs.findFirst({
    where: eq(selfMdmConfigs.tenantId, opts.tenantId),
    columns: { publicBaseUrl: true },
  });
  if (!cfg?.publicBaseUrl) {
    throw new Error(`publicBaseUrl not configured for tenant ${opts.tenantId}`);
  }
  const contentUri = `${cfg.publicBaseUrl.replace(/\/+$/, "")}${pushApp.fileUrl}`;

  const commandUuids: string[] = [];

  // 3. 下發信任 cert（Root + TrustedPeople：自簽 cert sideload 需兩個 store）
  for (const store of ["Root", "TrustedPeople"] as const) {
    commandUuids.push(
      await enqueueWindowsCommand({
        deviceUdid: opts.udid,
        commandType: "InstallTrustedCert",
        command: buildInstallTrustedCert({ thumbprint, certDerBase64, store }),
      }),
    );
  }

  // 4. 派送 push MSIX（兩段式 Add + Exec HostedInstall）
  commandUuids.push(
    await enqueueWindowsCommand({
      deviceUdid: opts.udid,
      commandType: "MsixInstallAdd",
      command: buildMsixInstallAddNode(pfn),
    }),
  );
  commandUuids.push(
    await enqueueWindowsCommand({
      deviceUdid: opts.udid,
      commandType: "MsixInstall",
      command: buildMsixInstall({ packageFamilyName: pfn, contentUri, isLOB: true }),
    }),
  );

  // 5. 密集 poll：加快「裝完→上報→push-config→channel」整條往返（教育場景默認套餐）
  for (
    const cmd of buildSetPollInterval({
      intervalFirst: 2,
      countFirst: 10,
      intervalRest: 15,
    })
  ) {
    commandUuids.push(
      await enqueueWindowsCommand({
        deviceUdid: opts.udid,
        commandType: "SetPollInterval",
        command: cmd,
      }),
    );
  }

  // 6. 初始 inventory query（設條件 + 取一次），啟動 command.ts 的自愈循環：
  //    設備裝完 push MSIX 後上報 inventory → 自動觸發 push-config → ChannelURI 落庫。
  commandUuids.push(
    await enqueueWindowsCommand({
      deviceUdid: opts.udid,
      commandType: "AppInventoryConfig",
      command: buildAppInventoryConfig(),
    }),
  );
  commandUuids.push(
    await enqueueWindowsCommand({
      deviceUdid: opts.udid,
      commandType: "AppInventoryFetch",
      command: buildAppInventoryFetch(),
    }),
  );

  return { certThumbprint: thumbprint, pfn, contentUri, commandUuids };
}
