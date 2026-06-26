import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { apps } from "~/db/schema/apps.ts";
import { mdmCommands, mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import {
  buildLapsAdmxInstall,
  buildLapsRotation,
  buildLockAdmxInstall,
  buildPpkgRemovalAdmxInstall,
  buildSelfUninstallAdmxInstall,
  buildMsiInstall,
  buildMsiStatusQuery,
} from "~/services/mdm/windows/csp.ts";
import { getActiveSelfMdmConfig } from "~/services/mdm/self-mdm-config.ts";
import { enqueueWindowsCommand, triggerWnsPush } from "~/services/mdm/windows/command.ts";
import { publishCommandEvent } from "~/services/mdm/command-events.ts";
import type { SyncMLCommand } from "~/services/mdm/windows/syncml.ts";
import { encryptSecret } from "~/lib/secrets.ts";
import { generateLapsPassword } from "~/services/laps.ts";
import { mdmWindowsBitlocker } from "~/db/schema/bitlocker.ts";
import { mdmWindowsLaps } from "~/db/schema/laps.ts";
import {
  buildBitLockerAdmxInstall,
  buildBitLockerEnable,
} from "~/services/mdm/windows/csp-bitlocker.ts";

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
   * Agent App 上報用的 base URL（如 https://api.cogrow.com/api/v1）。
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

  // 取文件下載基底 URL（appDownloadBaseUrl 優先，未設時回退 publicBaseUrl）。
  // 分離管理通道 URL 和文件下載 URL，讓 MSI 可從局域網 / CDN 下載不走公網。
  const config = await getActiveSelfMdmConfig();
  const downloadBase = (config.appDownloadBaseUrl ?? config.publicBaseUrl).replace(/\/+$/, "");
  const contentUri = `${downloadBase}${app.fileUrl}`;

  // 配置注入：Registry CSP 在 Win10 22H2 不可用（所有 LocURI 不分 verb 都回 404），
  // 改由 msiexec public property 帶進 MsiInstallJob 的 CommandLine，MSI 安裝時寫入
  // HKLM\SOFTWARE\Policies\CoGrowMDM\Agent（見 win-agent-app Product.wxs RegistryValue
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

  // 組裝成 mdm_commands 行：
  //   - policy_admx_install：一次性 ingest Lock + LAPS 自定義 ADMX
  //   - MSI 派發 = Add（建 job）+ Exec（觸發下載安裝）+ Status（查進度）
  //   - LAPS 輪換：自動生成隨機密碼，Agent 啟動後 LapsWatcher 讀 registry 執行改密
  const lapsPassword = generateLapsPassword();
  const lapsPasswordEnc = encryptSecret(lapsPassword);
  const lapsRotationId = crypto.randomUUID();
  const lapsAdminAccount = "Administrator";
  const lapsCmd = buildLapsRotation({
    newPassword: lapsPassword,
    adminAccount: lapsAdminAccount,
    rotationId: lapsRotationId,
  });

  // ADMX + MSI 命令（批量 INSERT，同一事務）
  const commandRows: {
    commandType: string;
    cmd: SyncMLCommand;
    commandUuid: string;
  }[] = [
    { commandType: "policy_admx_install", cmd: buildLockAdmxInstall(), commandUuid: crypto.randomUUID() },
    { commandType: "policy_admx_install", cmd: buildLapsAdmxInstall(), commandUuid: crypto.randomUUID() },
    { commandType: "policy_admx_install", cmd: buildPpkgRemovalAdmxInstall(), commandUuid: crypto.randomUUID() },
    { commandType: "policy_admx_install", cmd: buildSelfUninstallAdmxInstall(), commandUuid: crypto.randomUUID() },
    { commandType: "policy_admx_install", cmd: buildBitLockerAdmxInstall(), commandUuid: crypto.randomUUID() },
    { commandType: "msi_install", cmd: msiInstall, commandUuid: crypto.randomUUID() },
    { commandType: "msi_install", cmd: msiInstallExec, commandUuid: crypto.randomUUID() },
    { commandType: "msi_status_query", cmd: msiStatus, commandUuid: crypto.randomUUID() },
  ];
  // LAPS rotation 不入批量 INSERT——單獨在事務後 enqueue，保證 queued_at 晚於 ADMX，
  // 避免同一 SyncML session 裡 ADMX 還沒生效就收到 Replace（→ 500）。

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
        commandRows.map(({ commandType, cmd, commandUuid }) => ({
          tenantId,
          deviceId: device.id,
          commandUuid,
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

  // 此路徑直插 mdm_commands（事務原子性需求）繞過 queueWindowsCommand，
  // 故在事務提交後補發 command.queued（fire-and-forget，與集中掛鉤行為一致）
  for (const { commandType, cmd, commandUuid } of commandRows) {
    publishCommandEvent({
      tenantId,
      deviceId: device.id,
      commandUuid,
      commandType,
      status: "queued",
      platform: "windows",
      cspPath: cmd.target,
    });
  }

  // LAPS：事務提交後單獨 enqueue，queued_at 自然晚於 ADMX ingest，
  // 確保設備在後續 SyncML session 才拉到 LAPS Replace（ADMX 已生效）。
  if (!device.udid) {
    throw new AppError(500, "device_missing_udid", "Windows device missing udid after enrollment");
  }
  const lapsCommandUuid = await enqueueWindowsCommand({
    deviceUdid: device.udid,
    commandType: "LapsRotatePassword",
    command: lapsCmd[0],
  });
  await db.insert(mdmWindowsLaps).values({
    tenantId,
    deviceId: device.id,
    rotationId: lapsRotationId,
    adminAccount: lapsAdminAccount,
    passwordEnc: lapsPasswordEnc,
    status: "pending",
    commandUuid: lapsCommandUuid,
    triggeredBy: "auto",
  });

  // BitLocker：同樣在事務後 enqueue，確保 ADMX 已生效
  const bitlockerEncryptionId = crypto.randomUUID();
  const bitlockerCmd = buildBitLockerEnable({ encryptionId: bitlockerEncryptionId });
  const bitlockerCommandUuid = await enqueueWindowsCommand({
    deviceUdid: device.udid,
    commandType: "BitLockerEnable",
    command: bitlockerCmd[0],
  });
  await db.insert(mdmWindowsBitlocker).values({
    tenantId,
    deviceId: device.id,
    encryptionId: bitlockerEncryptionId,
    encryptionMethod: "XtsAes256",
    status: "pending",
    commandUuid: bitlockerCommandUuid,
    triggeredBy: "auto",
  });
  console.log(
    `[Win MDM] BitLocker enable 已排入: encryptionId=${bitlockerEncryptionId} udid=${device.udid}`,
  );

  // fire-and-forget WNS push 喚醒設備秒級拉命令。雖然 LAPS + BitLocker 走
  // enqueueWindowsCommand 已內建觸發過，這裡顯式再 push 一次作為防禦——若未來某
  // tenant 配置關閉 LAPS / BitLocker，主要的 MSI install 命令直插事務不會被任何
  // 隱式 push 觸發，手動升級既有設備就喪失秒級喚醒。
  triggerWnsPush(device.udid).catch((e) => {
    console.warn(
      `[install-agent] WNS push 觸發失敗（不影響 enqueue）: ${e instanceof Error ? e.message : String(e)}`,
    );
  });

  return {
    deviceId: device.id,
    agentToken,
    commandIds: [...result.commandIds, lapsCommandUuid, bitlockerCommandUuid],
  };
}

export interface IssueAgentTokenResult {
  deviceId: string;
  /** 一次性返回給呼叫端的 raw token；DB 只保存 hash。後續無法復原。 */
  agentToken: string;
  issuedAt: string;
}

/**
 * 為設備簽發（或重新簽發）Agent Token，不派發 App。
 *
 * 用途：
 *   - **iOS**：走 ABM Custom App + Managed App Configuration 分發，沒有 Windows
 *     install-agent 的 MSI 注入鏈路，token 需單獨簽發後由管理員注入 Jamf managed
 *     config 的 `agentToken` 鍵。
 *   - **任何平台**：「不重派 App 只換 token」（撤銷疑似洩漏的 token）。
 *
 * 簽發後設備的 agent_token_hash 非 null → 後續上報強制驗 Bearer
 * （見 {@link authorizeAgentReport}）。raw token 僅此回傳一次，DB 只存 sha256 hash；
 * 舊 token 立即失效（hash 被覆蓋）。
 */
export async function issueAgentTokenForDevice(opts: {
  tenantId: string;
  deviceId: string;
}): Promise<IssueAgentTokenResult> {
  const device = await db.query.mdmDevices.findFirst({
    where: (t, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(t.id, opts.deviceId), eqOp(t.tenantId, opts.tenantId)),
    columns: { id: true },
  });
  if (!device) {
    throw new AppError(404, "device_not_found", "Device not found");
  }

  // 與 install-agent 同款：32 bytes random hex（256 bit 熵），SHA-256 存 DB
  const agentToken = randomBytes(32).toString("hex");
  const agentTokenHash = createHash("sha256").update(agentToken).digest("hex");
  const issuedAt = new Date();

  await db
    .update(mdmDevices)
    .set({ agentTokenHash, agentTokenIssuedAt: issuedAt })
    .where(eq(mdmDevices.id, device.id));

  return { deviceId: device.id, agentToken, issuedAt: issuedAt.toISOString() };
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

// authorizeAgentReport / extractBearerToken 已抽到 ~/services/agent-auth.ts
// （Agent telemetry 服務需要它們，但不應依賴本模組的 Windows MSI 派發邏輯）。
