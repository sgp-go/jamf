import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { apps } from "~/db/schema/apps.ts";
import { mdmCommands, mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";

/**
 * Agent App 一鍵安裝流程：把「給設備派 Agent App」這個業務動作封裝為單一 API。
 *
 * 對台灣後端視角就是一個 endpoint，內部我方做三件事：
 *   1. 為該設備簽發 Agent Token（hex string），只回給呼叫端一次，DB 只存 sha256 hash
 *   2. 透過 Registry CSP 在設備 HKLM 寫入 Agent 配置（device_id + token + endpoint）
 *   3. 透過 EDA-CSP 派發 Agent .msi（指向 /apps/{appId}/download/...）
 *
 * 順序：先寫註冊表後派 .msi。Agent Service 安裝完啟動時讀註冊表已就緒，
 * 避免 race condition（詳見 brain/wiki/agent-app-device-binding.md）。
 *
 * 命令進 mdm_commands 隊列後由 OMA-DM 協議層拉走透過 SyncML 派發到設備。
 * 完成狀態由協議層更新（status: queued → sent → acknowledged）。
 * Webhook agent.installed 在 acknowledged 時觸發（W2-W3 接協議層 ack 流程）。
 */

const DEFAULT_REGISTRY_PATH = "SOFTWARE/Policies/CoGrowMDM/Agent";

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
   * 自訂註冊表路徑。預設 SOFTWARE/Policies/CoGrowMDM/Agent。
   * 通常不需改；只有客戶要走自己 publisher 命名空間時用。
   */
  registryPath?: string;
}

export interface InstallAgentResult {
  deviceId: string;
  /** 一次性返回給呼叫端的 raw token；DB 只保存 hash。後續無法復原。 */
  agentToken: string;
  /** 對應排入 mdm_commands 的命令 ID（Registry + Agent App install 3 條 SyncML 命令）*/
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

  const registryPath = input.registryPath ?? DEFAULT_REGISTRY_PATH;
  const tenantId = input.tenantId;

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

    // 2. 排入 3 條 SyncML 命令到 mdm_commands 隊列
    //    OMA-DM 協議層會從 status=queued 拉走、生成 SyncML、透過 push/poll 送到設備
    const commands = [
      {
        commandType: "registry_set" as const,
        cspPath:
          `./Device/Vendor/MSFT/Registry/HKLM/${registryPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}`,
        syncmlVerb: "Replace",
        syncmlData: JSON.stringify({
          values: {
            device_id: device.id,
            agent_token: agentToken,
            api_endpoint: input.apiEndpoint,
            tenant_id: tenantId,
          },
        }),
        syncmlFormat: "registry_batch",
      },
      {
        commandType: "msi_install" as const,
        cspPath:
          `./Device/Vendor/MSFT/EnterpriseDesktopAppManagement/MSI/${app.bundleId}/DownloadInstall`,
        syncmlVerb: "Add",
        syncmlData: JSON.stringify({
          productId: app.bundleId,
          productVersion: app.version,
          contentUri: app.fileUrl,
          fileHashHex: app.fileHash,
          commandLine: app.installArgs ?? "/quiet /norestart",
        }),
        syncmlFormat: "chr",
      },
      {
        commandType: "msi_status_query" as const,
        cspPath:
          `./Device/Vendor/MSFT/EnterpriseDesktopAppManagement/MSI/${app.bundleId}/Status`,
        syncmlVerb: "Get",
        syncmlData: null,
        syncmlFormat: null,
      },
    ];

    const inserted = await tx
      .insert(mdmCommands)
      .values(
        commands.map((c) => ({
          tenantId,
          deviceId: device.id,
          commandUuid: crypto.randomUUID(),
          platform: "windows" as const,
          commandType: c.commandType,
          status: "queued" as const,
          requestPayload: {
            cspPath: c.cspPath,
            syncmlVerb: c.syncmlVerb,
            syncmlFormat: c.syncmlFormat,
            syncmlData: c.syncmlData,
            // 給後續審計 / 重放使用的 install-agent context
            installAgent: {
              appId: app.id,
              appVersion: app.version,
              appBundleId: app.bundleId,
            },
          },
          cspPath: c.cspPath,
          syncmlVerb: c.syncmlVerb,
          syncmlData: c.syncmlData,
          syncmlFormat: c.syncmlFormat ?? undefined,
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
