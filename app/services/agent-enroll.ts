import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { AppError } from "~/lib/errors.ts";

/**
 * Agent 自助註冊（Intune 共存 / 遙測-only 場景）。
 *
 * 自建 MDM 的正規路徑是 install-agent 經 EDA-CSP 給「每台」設備注入唯一 token
 * （MSI property）。但存量設備若仍歸 Intune 管，OMA-DM 通道被 Intune 佔用、我方無法
 * 逐台注入；Intune 只能把「同一個」安裝命令行派給 N 台。故走共享密鑰自註冊：
 * Intune 下發的 MSI 只帶 tenant 級共享密鑰，Agent 首啟帶密鑰 + 序號來換 per-device token。
 *
 * 換到 token 後，一切上報（usage / reports / installed-apps ...）走與部署通道無關的
 * Bearer 鑑權（見 agent-auth.ts），與 install-agent 派發的設備完全一致。
 *
 * ⚠️ 能力邊界：這類設備 selfMdmManaged=false —— 我方只收遙測，管理面（鎖定 / wipe /
 * LAPS / CSP 策略）仍歸 Intune，自建 MDM 不對其下 OMA-DM 命令。
 *
 * 本模組刻意不依賴 Control 側的 install-agent.ts（不引入 Windows MSI 派發 / CSP 依賴圖），
 * 讓 Agent telemetry 服務可獨立部署（與 agent-auth.ts 同一分離原則）。token 生成沿用
 * 專案既有慣例（32 bytes hex + sha256 存庫），與 install-agent 的簽發等價。
 */

export interface GenerateEnrollmentSecretResult {
  /** 明文僅此一次回傳；DB 只存 sha256 hash，後續無法復原。 */
  enrollmentSecret: string;
  issuedAt: string;
}

/**
 * 生成 / 輪換 tenant 的 Agent 自註冊共享密鑰。舊密鑰立即失效（覆蓋 hash）。
 * @throws AppError 404 若該 tenant 尚未初始化 self_mdm_config。
 */
export async function generateAgentEnrollmentSecret(opts: {
  tenantId: string;
}): Promise<GenerateEnrollmentSecretResult> {
  // 24 bytes = 48 hex chars：足夠熵，且純 hex 在 msiexec 命令行 / Intune 安裝參數裡無需轉義。
  const enrollmentSecret = randomBytes(24).toString("hex");
  const issuedAt = new Date();
  const [row] = await db
    .update(selfMdmConfigs)
    .set({
      agentEnrollmentSecretHash: createHash("sha256").update(enrollmentSecret).digest("hex"),
      agentEnrollmentSecretIssuedAt: issuedAt,
    })
    .where(eq(selfMdmConfigs.tenantId, opts.tenantId))
    .returning({ id: selfMdmConfigs.id });
  if (!row) {
    throw new AppError(
      404,
      "mdm_config_not_found",
      "此 tenant 無 MDM 配置（先 POST /admin/tenants/{tenantId}/mdm-config 初始化）",
    );
  }
  return { enrollmentSecret, issuedAt: issuedAt.toISOString() };
}

/**
 * 撤銷自助註冊密鑰（關閉該 tenant 的設備自助換 token）。冪等：無配置也不報錯。
 * 已簽發的 per-device token 不受影響（照常鑑權）。
 */
export async function clearAgentEnrollmentSecret(opts: {
  tenantId: string;
}): Promise<void> {
  await db
    .update(selfMdmConfigs)
    .set({ agentEnrollmentSecretHash: null, agentEnrollmentSecretIssuedAt: null })
    .where(eq(selfMdmConfigs.tenantId, opts.tenantId));
}

export interface EnrollAgentResult {
  deviceId: string;
  /** raw token；僅此回傳一次，DB 只存 sha256 hash。 */
  agentToken: string;
  issuedAt: string;
}

/**
 * 設備自助註冊：驗共享密鑰 → 按 (tenant, serial) upsert 一台 windows agent-only 設備
 * → 簽發 per-device token。可重入：同序號再註冊 = 重簽 token（舊 token 立即失效），
 * 覆蓋 MSI 重裝 / token 遺失的補救場景。
 *
 * 與 install-agent 的差異：不派 MSI、不下 CSP、不寫 agentAppId；設備標記 agent_only +
 * selfMdmManaged=false（沿用 resolveAgentDevice 對 iOS BYOD 的 agent_only 慣例，
 * platform=windows 區分平台）。
 *
 * @throws AppError 403 未開啟自助註冊 / 401 密鑰不符。
 */
export async function enrollAgentDevice(opts: {
  tenantId: string;
  serialNumber: string;
  enrollmentSecret: string;
  udid?: string | null;
}): Promise<EnrollAgentResult> {
  const config = await db.query.selfMdmConfigs.findFirst({
    where: eq(selfMdmConfigs.tenantId, opts.tenantId),
    columns: { agentEnrollmentSecretHash: true },
  });
  if (!config?.agentEnrollmentSecretHash) {
    throw new AppError(
      403,
      "agent_enroll_disabled",
      "此 tenant 未開啟 Agent 自助註冊（先 POST /admin/tenants/{tenantId}/agent-enrollment-secret 生成密鑰）",
    );
  }
  // sha256 結果定長 → 直接字串比對即時序安全；不匹配不區分 device 是否存在，統一 401。
  if (createHash("sha256").update(opts.enrollmentSecret).digest("hex") !== config.agentEnrollmentSecretHash) {
    throw new AppError(401, "enrollment_secret_invalid", "Invalid enrollment secret");
  }

  // upsert：(tenant, serial) 已有則重用（重簽 token）；否則建 windows agent-only row。
  const existing = await db.query.mdmDevices.findFirst({
    where: and(
      eq(mdmDevices.tenantId, opts.tenantId),
      eq(mdmDevices.serialNumber, opts.serialNumber),
    ),
    columns: { id: true },
  });
  let deviceId: string;
  if (existing) {
    deviceId = existing.id;
  } else {
    const [created] = await db
      .insert(mdmDevices)
      .values({
        tenantId: opts.tenantId,
        serialNumber: opts.serialNumber,
        udid: opts.udid ?? null,
        platform: "windows",
        enrollmentType: "agent_only",
        enrollmentStatus: "pending",
        selfMdmManaged: false,
      })
      .returning({ id: mdmDevices.id });
    if (!created) {
      throw new AppError(500, "device_upsert_failed", "Failed to create device row");
    }
    deviceId = created.id;
  }

  // 簽發 per-device token（沿用 install-agent / agent-token 慣例：32 bytes hex + sha256 存庫）。
  const agentToken = randomBytes(32).toString("hex");
  const issuedAt = new Date();
  await db
    .update(mdmDevices)
    .set({ agentTokenHash: createHash("sha256").update(agentToken).digest("hex"), agentTokenIssuedAt: issuedAt })
    .where(eq(mdmDevices.id, deviceId));

  return { deviceId, agentToken, issuedAt: issuedAt.toISOString() };
}
