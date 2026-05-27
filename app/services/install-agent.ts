import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { apps } from "~/db/schema/apps.ts";
import { mdmCommands, mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { buildMsiInstall, buildMsiStatusQuery } from "~/services/mdm/windows/csp.ts";
import { getActiveSelfMdmConfig } from "~/services/mdm/self-mdm-config.ts";
import type { SyncMLCommand } from "~/services/mdm/windows/syncml.ts";

/**
 * Agent App 一鍵安裝流程：把「給設備派 Agent App」這個業務動作封裝為單一 API。
 *
 * 對台灣後端視角就是一個 endpoint，內部我方做兩件事：
 *   1. 為該設備簽發 Agent Token（hex string），只回給呼叫端一次，DB 只存 sha256 hash
 *   2. 透過 EDA-CSP 派發 Agent .msi，並把 device_id/token/endpoint/tenant 以
 *      msiexec public property 帶進 MsiInstallJob 的 CommandLine，由 MSI 安裝時
 *      寫入 HKLM（Registry CSP 在 Win10 22H2 已不可用 → 所有 LocURI 回 404）。
 *
 * 配置隨 MSI 原子落地，Agent Service 安裝完啟動時讀 HKLM 已就緒，無 race
 * （device-binding 演進詳見 brain/wiki/agent-app-device-binding.md）。
 *
 * 命令進 mdm_commands 隊列後由 OMA-DM 協議層拉走透過 SyncML 派發到設備。
 * 完成狀態由協議層更新（status: queued → sent → acknowledged）。
 * Webhook agent.installed 在 acknowledged 時觸發（W2-W3 接協議層 ack 流程）。
 */

export interface InstallAgentInput {
  tenantId: string;
  deviceId: string;
  appId: string;
  /**
   * Agent App 上報用的 base URL（如 https://api.cogrow.com/api/agent/v1）。
   * 注入到 HKLM 給 Agent Service 啟動讀取。
   */
  apiEndpoint: string;
  /**
   * @deprecated HKLM 路徑現由 agent MSI（Product.wxs）固定為
   * SOFTWARE\Policies\CoGrowMDM\Agent，此參數已不生效（保留兼容舊呼叫端）。
   */
  registryPath?: string;
}

export interface InstallAgentResult {
  deviceId: string;
  /** 一次性返回給呼叫端的 raw token；DB 只保存 hash。後續無法復原。 */
  agentToken: string;
  /** 排入 mdm_commands 的命令 ID（MSI Add + Exec + Status，共 3 條）*/
  commandIds: string[];
}

/**
 * 為 device 派發 Agent App + 注入配置。
 *
 * 失敗情境：device 不存在、device 非 windows、app 不存在 / 非 .msi / 非 windows、
 * app 沒上傳 binary（fileUrl=null）。皆拋 AppError，handler 統一轉成 4xx。
 */
export async function installAgentOnDevice(
  input: InstallAgentInput,
): Promise<InstallAgentResult> {
  const device = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, input.deviceId), eqOp(t.tenantId, input.tenantId)),
  });
  if (!device) {
    throw new AppError(404, "device_not_found", "Device not found");
  }
  if (device.platform !== "windows") {
    throw new AppError(
      400,
      "device_not_windows",
      "install-agent currently only supports Windows; iOS uses Managed App Configuration via ABM",
    );
  }

  const app = await db.query.apps.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, input.appId),
  });
  if (!app) {
    throw new AppError(404, "app_not_found", "Agent app not found");
  }
  if (app.tenantId !== null && app.tenantId !== input.tenantId) {
    throw new AppError(403, "forbidden", "App belongs to another tenant");
  }
  if (app.platform !== "windows" || (app.kind !== "msi" && app.kind !== "exe")) {
    throw new AppError(
      400,
      "unsupported_app_kind",
      "Agent app must be Windows .msi or .exe for install-agent flow",
    );
  }
  if (!app.fileUrl || !app.fileHash || !app.bundleId) {
    throw new AppError(
      400,
      "app_not_ready",
      "Agent app missing fileUrl / fileHash / bundleId (MSI ProductCode)",
    );
  }

  // 簽發 token：32 bytes random hex（256 bit 熵），SHA-256 存 DB
  const agentToken = randomBytes(32).toString("hex");
  const agentTokenHash = createHash("sha256").update(agentToken).digest("hex");

  const tenantId = input.tenantId;

  // 取 active config 的 publicBaseUrl 拼 MSI 下載 URL。
  // 設備的 EnterpriseDesktopAppManagement 需要完整公網 HTTPS URL，
  // app.fileUrl 只是相對路徑（/api/v1/apps/{id}/download/...），必須在此拼上 baseUrl。
  const config = await getActiveSelfMdmConfig();
  const baseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  const contentUri = `${baseUrl}${app.fileUrl}`;

  // 配置注入：Registry CSP 在 Win10 22H2 不可用（所有 LocURI 不分 verb 都回 404），
  // 改由 msiexec public property 帶進 MsiInstallJob 的 CommandLine，MSI 安裝時寫入
  // HKLM\SOFTWARE\Policies\CoGrowMDM\Agent（見 agent-app Product.wxs RegistryValue
  // 與 RegistryConfig.cs KeyPath）。值皆 UUID/hex/URL（無空格），不需引號。
  const configProps = [
    `DEVICE_ID=${device.id}`,
    `AGENT_TOKEN=${agentToken}`,
    `API_ENDPOINT=${input.apiEndpoint}`,
    `TENANT_ID=${tenantId}`,
  ].join(" ");
  const installCommandLine = `${app.installArgs ?? "/quiet /norestart"} ${configProps}`;

  // csp.ts 純函數生成「終態」SyncML 命令——command.ts 取出後直接下發。
  //   1. MSI DownloadInstall：Add + MsiInstallJob XML（CommandLine 帶配置 property）
  //   2. MSI Status：Get（供後端輪詢安裝進度）
  let msiInstall: SyncMLCommand;
  let msiInstallExec: SyncMLCommand;
  let msiStatus: SyncMLCommand;
  try {
    msiInstall = buildMsiInstall({
      productId: app.bundleId,
      productVersion: app.version,
      contentUri,
      fileHashHex: app.fileHash,
      commandLine: installCommandLine,
    });
    // EDA-CSP DownloadInstall 兩段式（真機驗證）：Add 創建 install job（設備端
    // 狀態停在 Ready，不會自動下載），必須再 Exec 同一 LocURI 才觸發 BITS 下載 +
    // msiexec 安裝。缺 Exec → job 永遠停在 Ready。對齊 MSIX HostedInstall 的
    // Add+Exec 模式。Exec 復用 Add 的 target/data（MsiInstallJob XML）。
    msiInstallExec = { ...msiInstall, cmdId: "0", verb: "Exec" as const };
    msiStatus = buildMsiStatusQuery(app.bundleId);
  } catch (err) {
    // buildMsiInstall 內部 normalizeProductId 對非 GUID 的 bundleId 拋 TypeError
    throw new AppError(
      400,
      "invalid_product_code",
      `app.bundleId 必須是合法 MSI ProductCode GUID：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 組裝成 mdm_commands 行：MSI 派發 = Add（建 job）+ Exec（觸發下載安裝）+
  // Status（查進度）三條；cspPath/verb/data/format 皆終態
  const commandRows: {
    commandType: "msi_install" | "msi_status_query";
    cmd: SyncMLCommand;
  }[] = [
    { commandType: "msi_install" as const, cmd: msiInstall }, // Add：創建 job
    { commandType: "msi_install" as const, cmd: msiInstallExec }, // Exec：觸發下載安裝
    { commandType: "msi_status_query" as const, cmd: msiStatus },
  ];

  const result = await db.transaction(async (tx) => {
    // 1. 更新 device 上的 token 紀錄
    await tx
      .update(mdmDevices)
      .set({
        agentTokenHash,
        agentTokenIssuedAt: new Date(),
        agentAppId: app.id,
      })
      .where(eq(mdmDevices.id, device.id));

    // 2. 批次排入終態命令到 mdm_commands 隊列
    //    OMA-DM 協議層會從 status=queued 拉走、包成 SyncML、透過 push/poll 送到設備
    const inserted = await tx
      .insert(mdmCommands)
      .values(
        commandRows.map(({ commandType, cmd }) => ({
          tenantId,
          deviceId: device.id,
          commandUuid: crypto.randomUUID(),
          platform: "windows" as const,
          commandType,
          status: "queued" as const,
          requestPayload: {
            cspPath: cmd.target,
            syncmlVerb: cmd.verb,
            syncmlFormat: cmd.format ?? null,
            syncmlData: cmd.data ?? null,
            // 給後續審計 / 重放使用的 install-agent context
            installAgent: {
              appId: app.id,
              appVersion: app.version,
              appBundleId: app.bundleId,
            },
          },
          cspPath: cmd.target,
          syncmlVerb: cmd.verb,
          syncmlData: cmd.data ?? null,
          syncmlFormat: cmd.format ?? undefined,
        })),
      )
      .returning({ id: mdmCommands.id });

    return { commandIds: inserted.map((r) => r.id) };
  });

  return {
    deviceId: device.id,
    agentToken,
    commandIds: result.commandIds,
  };
}

/**
 * 驗證 Agent 上報時帶的 token 是否匹配該 device 的 hash。
 *
 * timing-safe 比對由 sha256 結果長度固定保證等長，可直接 string equal。
 * 不匹配時不洩漏「device 存在但 token 錯」vs「device 不存在」的差異
 * （都拋 401，由 handler 包成統一 error）。
 */
export async function verifyAgentToken(opts: {
  deviceId: string;
  token: string;
}): Promise<boolean> {
  const row = await db.query.mdmDevices.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, opts.deviceId),
    columns: { agentTokenHash: true },
  });
  if (!row?.agentTokenHash) return false;
  const presented = createHash("sha256").update(opts.token).digest("hex");
  return presented === row.agentTokenHash;
}

/**
 * Agent endpoint 鑑權門檻：
 *
 * - 若 device 已透過 install-agent 簽發 token（agent_token_hash 非 null）→
 *   要求必須帶 Authorization: Bearer <token>，且匹配；不過拋 401
 * - 若 device 尚未簽發 token（agent_token_hash=null）→ 視為「opt-out」尚未啟用
 *   token 機制，允許不帶 token 上報（兼容 iOS 既有 Agent App 行為）
 *
 * 這個設計讓 Windows install-agent 流程跑完後自動進入「強制 token」模式，
 * iOS 暫不變；後續 iOS 走 Managed App Configuration 注入 token 後同樣升級為強制。
 *
 * @param device device row（必須含 agent_token_hash 欄位）
 * @param token  從 Authorization: Bearer 取出的 raw token（無則為 null）
 */
export async function authorizeAgentReport(opts: {
  device: { id: string; agentTokenHash: string | null };
  token: string | null;
}): Promise<void> {
  const { device, token } = opts;
  // 未簽發 token → 兼容模式（iOS 既有）
  if (!device.agentTokenHash) return;

  if (!token) {
    throw new AppError(
      401,
      "agent_token_required",
      "Device has agent token issued; request must include Authorization: Bearer <token>",
    );
  }
  const presented = createHash("sha256").update(token).digest("hex");
  if (presented !== device.agentTokenHash) {
    throw new AppError(401, "agent_token_invalid", "Invalid agent token");
  }
}

/** 從 Authorization header 解出 Bearer token 值；無則 null。 */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1] ?? null;
}
