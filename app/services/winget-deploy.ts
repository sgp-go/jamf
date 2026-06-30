import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { appAssignments, apps } from "~/db/schema/apps.ts";
import { mdmCommands, mdmDevices } from "~/db/schema/devices.ts";
import { AppError } from "~/lib/errors.ts";
import { publishCommandEvent } from "~/services/mdm/command-events.ts";
import { triggerWnsPush } from "~/services/mdm/windows/command.ts";

/**
 * winget App 派發 / 卸載 service（區別於 app-deploy.ts 走 EDA-CSP 的 MSI 派發）。
 *
 * **通道**：不走 OMA-DM SyncML（winget 沒對應 MDM CSP）。命令存進 mdm_commands 但
 * `syncmlVerb/cspPath/syncmlData/syncmlFormat` 全 null，由 Agent 端透過 `/agent/checkin`
 * pull 拉取執行（Agent EventLogWatcher 監聽 OMA-DM session 啟動 Event 265 觸發 checkin）。
 *
 * **秒級觸發**：寫完 mdm_commands 後 `triggerWnsPush` 喚醒 Windows OMA-DM client；
 * WNS push 本身就會引發 OMA-DM session 啟動（即使我們沒給 SyncML 命令給它拉），
 * Event 265 fire → Agent 拉 checkin → 拿到 winget commands。**不需要寫 dummy SyncML 命令**
 * （真機驗證 2026-06-29 PF5XSMN1 確認）。
 *
 * **資料寫入**：
 *   - `mdm_commands(commandType="winget_install"|"winget_uninstall", syncmlVerb=null)`
 *   - `app_assignments(scope=device, status=pending)` — 提供 PRD §5.3 授權統計依據
 *     （與 EDA-CSP MSI 派發不同，MSI 那條目前未寫 app_assignments，留為已知 gap）
 */

interface WingetCommandPayload {
  type: "winget_install" | "winget_uninstall";
  wingetId: string;
  source: string;
  scope: "machine" | "user";
  acceptAgreements: boolean;
  version?: string;
  appId: string;
}

async function resolveDeviceAndWingetApp(opts: {
  tenantId: string;
  deviceId: string;
  appId: string;
}) {
  const device = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.id, opts.deviceId),
    columns: { id: true, tenantId: true, platform: true, udid: true },
  });
  if (!device) throw new AppError(404, "device_not_found", "Device not found");
  if (device.tenantId !== opts.tenantId) {
    throw new AppError(403, "forbidden", "Device belongs to another tenant");
  }
  if (device.platform !== "windows") {
    throw new AppError(400, "unsupported_platform", "winget deploy supports Windows only");
  }

  const app = await db.query.apps.findFirst({
    where: eq(apps.id, opts.appId),
  });
  if (!app) throw new AppError(404, "app_not_found", "App not found");
  if (app.tenantId !== null && app.tenantId !== opts.tenantId) {
    throw new AppError(403, "forbidden", "App belongs to another tenant");
  }
  if (app.kind !== "winget") {
    throw new AppError(
      400,
      "not_a_winget_app",
      `App kind is ${app.kind}, expected winget. Use /apps/{id}/install (EDA-CSP MSI) instead.`,
    );
  }
  if (!app.wingetId) {
    throw new AppError(400, "missing_winget_id", "App row 缺 wingetId（schema invariant 違反）");
  }
  return { device, app };
}

async function enqueueWingetCommand(opts: {
  tenantId: string;
  deviceId: string;
  appId: string;
  appVersion: string;
  payload: WingetCommandPayload;
}): Promise<string> {
  const commandUuid = crypto.randomUUID();
  const [row] = await db
    .insert(mdmCommands)
    .values({
      tenantId: opts.tenantId,
      deviceId: opts.deviceId,
      commandUuid,
      platform: "windows" as const,
      commandType: opts.payload.type,
      status: "queued" as const,
      requestPayload: opts.payload as unknown as Record<string, unknown>,
      // winget 不走 OMA-DM 通道，SyncML 欄位刻意全 null
      cspPath: null,
      syncmlVerb: null,
      syncmlData: null,
    })
    .returning({ id: mdmCommands.id });
  if (!row) throw new Error("Insert mdm_commands returned no row");

  publishCommandEvent({
    tenantId: opts.tenantId,
    deviceId: opts.deviceId,
    commandUuid,
    commandType: opts.payload.type,
    status: "queued",
    platform: "windows",
    cspPath: null,
  });

  return row.id;
}

async function upsertAppAssignment(opts: {
  tenantId: string;
  appId: string;
  deviceId: string;
  commandId: string;
}): Promise<void> {
  // ON CONFLICT 更新狀態回 pending（重派場景）。
  // app_assignments_app_device_uq 是 partial unique (scope='device' AND deviceId IS NOT NULL)，
  // drizzle onConflictDoUpdate 需明確 target 欄位。
  await db
    .insert(appAssignments)
    .values({
      tenantId: opts.tenantId,
      appId: opts.appId,
      scope: "device" as const,
      deviceId: opts.deviceId,
      status: "pending" as const,
      lastCommandId: opts.commandId,
    })
    .onConflictDoUpdate({
      target: [appAssignments.appId, appAssignments.deviceId],
      targetWhere: sql`scope = 'device' AND device_id IS NOT NULL`,
      set: {
        status: "pending" as const,
        lastCommandId: opts.commandId,
        errorMessage: null,
        removedAt: null,
        updatedAt: new Date(),
      },
    });
}

async function pushWnsBestEffort(udid: string | null, context: string): Promise<void> {
  if (!udid) return;
  try {
    await triggerWnsPush(udid);
  } catch (e) {
    console.warn(
      `[winget-deploy] WNS push 觸發失敗（不影響 enqueue, ${context}）: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export interface InstallWingetAppInput {
  tenantId: string;
  deviceId: string;
  appId: string;
  /** 覆寫 scope（預設 machine） */
  scopeOverride?: "machine" | "user";
}

export interface WingetDeployResult {
  commandIds: string[];
}

export async function installWingetAppOnDevice(
  input: InstallWingetAppInput,
): Promise<WingetDeployResult> {
  const { device, app } = await resolveDeviceAndWingetApp(input);

  const payload: WingetCommandPayload = {
    type: "winget_install",
    wingetId: app.wingetId!,
    source: app.wingetSource ?? "winget",
    scope: input.scopeOverride ?? "machine",
    acceptAgreements: true,
    version: app.version === "latest" ? undefined : app.version,
    appId: app.id,
  };

  const commandId = await enqueueWingetCommand({
    tenantId: input.tenantId,
    deviceId: device.id,
    appId: app.id,
    appVersion: app.version,
    payload,
  });

  await upsertAppAssignment({
    tenantId: input.tenantId,
    appId: app.id,
    deviceId: device.id,
    commandId,
  });

  // WNS push 喚醒 → OMA-DM session → EventLog 265 → Agent 拉 checkin
  pushWnsBestEffort(device.udid, `install ${app.wingetId}`).catch(() => {});

  return { commandIds: [commandId] };
}

export interface UninstallWingetAppInput {
  tenantId: string;
  deviceId: string;
  appId: string;
}

export async function uninstallWingetAppOnDevice(
  input: UninstallWingetAppInput,
): Promise<WingetDeployResult> {
  const { device, app } = await resolveDeviceAndWingetApp(input);

  const payload: WingetCommandPayload = {
    type: "winget_uninstall",
    wingetId: app.wingetId!,
    source: app.wingetSource ?? "winget",
    scope: "machine",
    acceptAgreements: true,
    appId: app.id,
  };

  const commandId = await enqueueWingetCommand({
    tenantId: input.tenantId,
    deviceId: device.id,
    appId: app.id,
    appVersion: app.version,
    payload,
  });

  // uninstall 不寫新 app_assignment row；更新既有 row 狀態（若有）
  await db
    .update(appAssignments)
    .set({
      status: "pending" as const,
      lastCommandId: commandId,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appAssignments.appId, app.id),
        eq(appAssignments.deviceId, device.id),
        eq(appAssignments.scope, "device"),
      ),
    );

  pushWnsBestEffort(device.udid, `uninstall ${app.wingetId}`).catch(() => {});

  return { commandIds: [commandId] };
}

/**
 * /agent/checkin 時拿出所有 queued winget 命令，映射成 CheckinAction[]。
 *
 * 拉完不在這裡 mark sent —— sent 由 Agent 真正取走後決定（pull 模式特性）。
 * Agent 端拿到 commandId 後執行 winget.exe，跑完 POST /agent/winget-result，
 * 才將 status 翻成 acknowledged。中途 Agent 重啟、checkin 重來不會丟命令。
 *
 * priority=80：低於 LAPS (100)，因 LAPS 是安全性敏感即時動作；
 * winget 是用戶可感知的應用派發，但可容忍輕微延遲。
 */
export interface WingetCheckinAction {
  type: "winget_install" | "winget_uninstall";
  priority: number;
  data: {
    commandId: string;
    wingetId: string;
    source: string;
    scope: "machine" | "user";
    acceptAgreements: boolean;
    version?: string;
  };
}

/**
 * Agent 上報 winget 執行結果。
 *
 * 副作用：
 *   - 更新 `mdm_commands.status` + `respondedAt` + `responsePayload`
 *   - 更新對應 `app_assignments.status`：install→installed/failed；uninstall→removed/failed
 *   - 發 `command.completed` webhook
 *
 * 越權保護：commandId 屬於 deviceId 才可寫入；否則 404（不洩漏「該 command 存在於其他設備」）。
 */
export interface RecordWingetResultInput {
  tenantId: string;
  deviceId: string;
  commandId: string;
  exitCode: number;
  status: "success" | "failed" | "already-installed" | "not-found";
  installedVersion?: string;
  stdoutTail?: string;
  stderrTail?: string;
  durationMs: number;
}

export interface RecordWingetResultOutput {
  commandId: string;
  commandStatus: "acknowledged" | "error";
  assignmentStatus: "installed" | "failed" | "removed" | null;
}

export async function recordWingetResult(
  input: RecordWingetResultInput,
): Promise<RecordWingetResultOutput> {
  const cmd = await db.query.mdmCommands.findFirst({
    where: and(
      eq(mdmCommands.id, input.commandId),
      eq(mdmCommands.deviceId, input.deviceId),
    ),
    columns: {
      id: true,
      commandUuid: true,
      tenantId: true,
      commandType: true,
      requestPayload: true,
      status: true,
    },
  });
  if (!cmd) {
    throw new AppError(404, "winget_command_not_found", "winget command not found for this device");
  }
  if (cmd.commandType !== "winget_install" && cmd.commandType !== "winget_uninstall") {
    throw new AppError(
      400,
      "not_a_winget_command",
      `Command type "${cmd.commandType}" is not a winget command`,
    );
  }
  if (cmd.tenantId !== input.tenantId) {
    throw new AppError(403, "forbidden", "Command belongs to another tenant");
  }

  // success / already-installed 視為 acknowledged；其他都 error
  const commandStatus: "acknowledged" | "error" =
    input.status === "success" || input.status === "already-installed"
      ? "acknowledged"
      : "error";

  await db
    .update(mdmCommands)
    .set({
      status: commandStatus,
      respondedAt: new Date(),
      responsePayload: {
        exitCode: input.exitCode,
        status: input.status,
        installedVersion: input.installedVersion ?? null,
        stdoutTail: input.stdoutTail ?? null,
        stderrTail: input.stderrTail ?? null,
        durationMs: input.durationMs,
      },
      errorChain: commandStatus === "error"
        ? [
            {
              type: "winget_exec_failed",
              exitCode: input.exitCode,
              status: input.status,
            },
          ]
        : null,
    })
    .where(eq(mdmCommands.id, cmd.id));

  // 更新對應 app_assignments
  const payload = (cmd.requestPayload ?? {}) as Partial<WingetCommandPayload>;
  let assignmentStatus: "installed" | "failed" | "removed" | null = null;

  if (payload.appId) {
    if (cmd.commandType === "winget_install") {
      assignmentStatus = commandStatus === "acknowledged" ? "installed" : "failed";
    } else {
      // uninstall：成功 → removed；失敗 → failed
      assignmentStatus = commandStatus === "acknowledged" ? "removed" : "failed";
    }

    await db
      .update(appAssignments)
      .set({
        status: assignmentStatus,
        errorMessage:
          assignmentStatus === "failed"
            ? `winget ${cmd.commandType}: exit=${input.exitCode} status=${input.status}`
            : null,
        installedAt:
          assignmentStatus === "installed" ? new Date() : undefined,
        removedAt:
          assignmentStatus === "removed" ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appAssignments.appId, payload.appId),
          eq(appAssignments.deviceId, input.deviceId),
          eq(appAssignments.scope, "device"),
        ),
      );
  }

  publishCommandEvent({
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    commandUuid: cmd.commandUuid,
    commandType: cmd.commandType,
    status: commandStatus, // acknowledged → command.completed；error → command.failed
    platform: "windows",
    cspPath: null,
  });

  return {
    commandId: cmd.id,
    commandStatus,
    assignmentStatus,
  };
}

export async function buildWingetCheckinActions(
  deviceId: string,
): Promise<WingetCheckinAction[]> {
  const rows = await db
    .select({
      id: mdmCommands.id,
      commandType: mdmCommands.commandType,
      requestPayload: mdmCommands.requestPayload,
    })
    .from(mdmCommands)
    .where(
      and(
        eq(mdmCommands.deviceId, deviceId),
        eq(mdmCommands.status, "queued"),
        inArray(mdmCommands.commandType, ["winget_install", "winget_uninstall"]),
      ),
    )
    .orderBy(mdmCommands.queuedAt);

  return rows.map((row) => {
    const payload = (row.requestPayload ?? {}) as Partial<WingetCommandPayload>;
    return {
      type: row.commandType as "winget_install" | "winget_uninstall",
      priority: 80,
      data: {
        commandId: row.id,
        wingetId: payload.wingetId ?? "",
        source: payload.source ?? "winget",
        scope: payload.scope ?? "machine",
        acceptAgreements: payload.acceptAgreements ?? true,
        version: payload.version,
      },
    };
  });
}
