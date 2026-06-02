import { db } from "~/db/client.ts";
import { apps } from "~/db/schema/apps.ts";
import { AppError } from "~/lib/errors.ts";
import {
  getRolloutHealth,
  rolloutAgentVersion,
  type RolloutHealthResult,
  type RolloutResult,
} from "~/services/agent-rollout.ts";
import {
  decideRollback,
  type RollbackDecision,
  type RollbackPolicy,
} from "~/services/agent-rollback-decision.ts";

/**
 * 自動回滾編排：把 brain/wiki/agent-rollback-strategy.md §3 的回滾決策流程自動化。
 *
 *   查灰度健康 → 決策（silent 超閾值？）→ 構建 roll-forward 包 → 註冊為新 app →
 *   用既有灰度端點把 roll-forward 派給壞 build 設備（silent ∪ upgraded）。
 *
 * ⭐ 所有副作用（查健康 / 構建 / 註冊 / 派發）都經 {@link AutoRollbackDeps} 注入：
 *   - 生產：makeDefaultDeps() 接真實 getRolloutHealth / pwsh build-rollforward.ps1 / DB / 灰度派發。
 *   - 本地/單測：注入 stub，純邏輯（決策 + 串接）在 Mac 全測，不需 Windows/真機。
 *   - dryRun：只查健康 + 決策 + 出計畫，不構建不派發（運維先看再決定）。
 *
 * 為何回滾走「發更高版本號的 roll-forward 包」而非派舊版：MSI MajorUpgrade 擋 downgrade。
 * 為何壞 build 崩潰的設備仍收得到回滾命令：OMA-DM 系統通道獨立於崩潰的 agent。
 * 完整設計見 agent-rollback-strategy.md。
 */

/** 已構建並託管完成、可直接註冊為 app 的 roll-forward 產物。 */
export interface RollforwardArtifact {
  /** roll-forward 包版本號（須 > 壞版本，否則 MajorUpgrade 拒裝） */
  version: string;
  /** MSI SHA-256（EDA-CSP install 完整性驗證），存 app.fileHash */
  sha256: string;
  /** MSI ProductCode GUID，存 app.bundleId（buildMsiInstall 需要） */
  productCode: string;
  /** 已託管的下載路徑（相對 publicBaseUrl 或絕對 URL），存 app.fileUrl */
  fileUrl: string;
  fileSizeBytes?: number;
}

export interface BuildRollforwardRequest {
  /** 已知好版本的 git ref（build-rollforward.ps1 -SourceRef） */
  sourceRef: string;
  /** 目標版本號（build-rollforward.ps1 -Version） */
  version: string;
}

export interface AutoRollbackInput {
  tenantId: string;
  /** 當前（疑似壞）版本的 agent app id —— 健康判定的目標版本來自此 app.version */
  appId: string;
  apiEndpoint: string;
  /** 健康靜默窗口（分鐘）；曾上報但超此窗口無上報判 silent */
  windowMinutes: number;
  policy: RollbackPolicy;
  /** 已知好版本的 git ref（roll-forward 源碼） */
  sourceRef: string;
  /** roll-forward 包版本號（須 > 壞版本） */
  rollforwardVersion: string;
  /** dry-run：只查健康 + 決策 + 出計畫，不構建不派發 */
  dryRun?: boolean;
}

/** 注入的副作用集合（生產用 makeDefaultDeps，測試用 stub）。 */
export interface AutoRollbackDeps {
  getHealth: (o: {
    tenantId: string;
    appId: string;
    windowMinutes: number;
  }) => Promise<RolloutHealthResult>;
  build: (req: BuildRollforwardRequest) => Promise<RollforwardArtifact>;
  /** 把 roll-forward 產物註冊為新 app（同租戶/平台/kind），回傳新 appId。 */
  registerApp: (o: {
    tenantId: string;
    baseAppId: string;
    artifact: RollforwardArtifact;
    sourceRef: string;
  }) => Promise<string>;
  /** 把 roll-forward app 派給指定設備（複用灰度 deviceIds 選擇）。 */
  dispatch: (o: {
    tenantId: string;
    appId: string;
    apiEndpoint: string;
    deviceIds: string[];
  }) => Promise<RolloutResult>;
}

export interface AutoRollbackPlan {
  sourceRef: string;
  rollforwardVersion: string;
  /** 回滾派發目標數（silent ∪ upgraded） */
  targetCount: number;
}

export interface AutoRollbackResult {
  /** 是否實際執行了回滾（dryRun 與未觸發皆為 false） */
  triggered: boolean;
  dryRun: boolean;
  decision: RollbackDecision;
  health: RolloutHealthResult;
  /** 觸發時的回滾計畫；未觸發時亦回顯（供運維審視） */
  plan: AutoRollbackPlan;
  /** triggered 時才有：構建產物 / 新 app / 派發結果 */
  artifact?: RollforwardArtifact;
  rolloutAppId?: string;
  rollout?: RolloutResult;
}

/**
 * 自動回滾主流程。triggered=true 時已完成「構建 + 註冊 + 派發」。
 * 副作用全由 deps 提供，故此函數本身純串接、可單測。
 */
export async function autoRollback(
  input: AutoRollbackInput,
  deps: AutoRollbackDeps,
): Promise<AutoRollbackResult> {
  const health = await deps.getHealth({
    tenantId: input.tenantId,
    appId: input.appId,
    windowMinutes: input.windowMinutes,
  });

  const decision = decideRollback(health, input.policy);
  const plan: AutoRollbackPlan = {
    sourceRef: input.sourceRef,
    rollforwardVersion: input.rollforwardVersion,
    targetCount: decision.targetDeviceIds.length,
  };

  // 未觸發：健康 / 樣本不足 → 不構建不派發
  if (!decision.shouldRollback) {
    return { triggered: false, dryRun: false, decision, health, plan };
  }

  // dry-run：觸發了但只出計畫，由運維決定是否放行
  if (input.dryRun) {
    return { triggered: false, dryRun: true, decision, health, plan };
  }

  // 1. 構建 roll-forward 包（pwsh / CI）
  const artifact = await deps.build({
    sourceRef: input.sourceRef,
    version: input.rollforwardVersion,
  });
  // 版本號是 MajorUpgrade 能否換檔的命門，構建產物必須與計畫一致
  if (artifact.version !== input.rollforwardVersion) {
    throw new AppError(
      500,
      "rollforward_version_mismatch",
      `roll-forward 構建版本 ${artifact.version} != 計畫版本 ${input.rollforwardVersion}`,
    );
  }

  // 2. 註冊為新 app（目標版本 = roll-forward 版本）
  const rolloutAppId = await deps.registerApp({
    tenantId: input.tenantId,
    baseAppId: input.appId,
    artifact,
    sourceRef: input.sourceRef,
  });

  // 3. 灰度派發給壞 build 設備（silent ∪ upgraded）。silent 設備靠 OMA-DM 系統通道收命令。
  const rollout = await deps.dispatch({
    tenantId: input.tenantId,
    appId: rolloutAppId,
    apiEndpoint: input.apiEndpoint,
    deviceIds: decision.targetDeviceIds,
  });

  return {
    triggered: true,
    dryRun: false,
    decision,
    health,
    plan,
    artifact,
    rolloutAppId,
    rollout,
  };
}

// ============================================================
// 預設（生產）副作用實現
// ============================================================

/** 把 roll-forward 產物落 apps 表（拷貝 base app 的平台/kind/安裝參數），回傳新 appId。 */
export async function registerRollforwardApp(o: {
  tenantId: string;
  baseAppId: string;
  artifact: RollforwardArtifact;
  sourceRef: string;
}): Promise<string> {
  const base = await db.query.apps.findFirst({
    where: (t, { eq }) => eq(t.id, o.baseAppId),
  });
  if (!base) throw new AppError(404, "app_not_found", "Base agent app not found");
  if (base.tenantId !== null && base.tenantId !== o.tenantId) {
    throw new AppError(403, "forbidden", "App belongs to another tenant");
  }

  const [row] = await db
    .insert(apps)
    .values({
      tenantId: o.tenantId,
      platform: base.platform,
      kind: base.kind,
      displayName: `${base.displayName} (rollback ${o.artifact.version})`,
      bundleId: o.artifact.productCode,
      version: o.artifact.version,
      fileUrl: o.artifact.fileUrl,
      fileHash: o.artifact.sha256,
      fileSizeBytes: o.artifact.fileSizeBytes ?? null,
      signedBy: base.signedBy,
      installArgs: base.installArgs,
      // 審計：標記這是回滾包，記下源碼 ref 與它取代的（壞）版本
      metadata: {
        rollback: {
          sourceRef: o.sourceRef,
          replacesVersion: base.version,
          baseAppId: base.id,
        },
      },
    })
    .returning({ id: apps.id });
  return row.id;
}

/**
 * 預設 build：spawn `pwsh agent-app/build-rollforward.ps1`，讀其產出的 JSON manifest。
 * ⚠️ 僅在有 git + pwsh + WiX 的 Windows ops 機可用（設備無 git，見 handoff 待辦 #3）。
 * manifest 須含 fileUrl（MSI 上傳託管後填入；自建 MDM 可由後端直接服務 → 相對路徑）。
 */
export async function buildRollforwardViaPwsh(
  req: BuildRollforwardRequest,
  opts?: { scriptPath?: string; certThumbprint?: string },
): Promise<RollforwardArtifact> {
  const scriptPath = opts?.scriptPath ?? "agent-app/build-rollforward.ps1";
  const args = [
    "-File",
    scriptPath,
    "-SourceRef",
    req.sourceRef,
    "-Version",
    req.version,
    "-EmitManifest",
  ];
  if (opts?.certThumbprint) args.push("-CertThumbprint", opts.certThumbprint);

  const cmd = new Deno.Command("pwsh", { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new AppError(
      500,
      "rollforward_build_failed",
      `build-rollforward.ps1 退出碼 ${code}：${new TextDecoder().decode(stderr)}`,
    );
  }

  // 約定：build-rollforward.ps1 -EmitManifest 末行輸出 manifest 路徑（MANIFEST=<path>）
  const out = new TextDecoder().decode(stdout);
  const m = out.match(/^MANIFEST=(.+)$/m);
  if (!m) {
    throw new AppError(500, "rollforward_manifest_missing", "未從構建輸出解析到 MANIFEST 路徑");
  }
  const manifestPath = m[1].trim();
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as Partial<
    RollforwardArtifact
  >;

  if (!manifest.version || !manifest.sha256 || !manifest.productCode) {
    throw new AppError(
      500,
      "rollforward_manifest_invalid",
      "manifest 缺 version / sha256 / productCode",
    );
  }
  if (!manifest.fileUrl) {
    throw new AppError(
      500,
      "rollforward_fileurl_missing",
      "manifest 缺 fileUrl：請先上傳 MSI 到下載託管並在 manifest 寫入下載路徑",
    );
  }
  return {
    version: manifest.version,
    sha256: manifest.sha256,
    productCode: manifest.productCode,
    fileUrl: manifest.fileUrl,
    fileSizeBytes: manifest.fileSizeBytes,
  };
}

/**
 * 生產 deps：真實查健康 + pwsh 構建 + DB 註冊 + 灰度派發。
 * 本地/測試請自行拼裝（如真 dispatch + stub build）。
 */
export function makeDefaultDeps(opts?: {
  certThumbprint?: string;
  scriptPath?: string;
}): AutoRollbackDeps {
  return {
    getHealth: getRolloutHealth,
    build: (req) => buildRollforwardViaPwsh(req, opts),
    registerApp: registerRollforwardApp,
    dispatch: ({ tenantId, appId, apiEndpoint, deviceIds }) =>
      rolloutAgentVersion({
        tenantId,
        appId,
        apiEndpoint,
        selection: { mode: "deviceIds", deviceIds },
      }),
  };
}
