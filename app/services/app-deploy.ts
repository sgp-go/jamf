import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmCommands, mdmDevices } from "~/db/schema/devices.ts";
import { apps } from "~/db/schema/apps.ts";
import { AppError } from "~/lib/errors.ts";
import { getActiveSelfMdmConfig } from "~/services/mdm/self-mdm-config.ts";
import {
  buildMsiInstall,
  buildMsiStatusQuery,
  buildMsiUninstall,
} from "~/services/mdm/windows/csp.ts";
import type { SyncMLCommand } from "~/services/mdm/windows/syncml.ts";
import { publishCommandEvent } from "~/services/mdm/command-events.ts";
import { triggerWnsPush } from "~/services/mdm/windows/command.ts";

/**
 * 通用 App 派發 / 卸載 service（區別於 install-agent.ts）。
 *
 * 跟 install-agent 的差異：
 *   - 不簽 `agent_token`、不寫 `mdm_devices.agent_app_id`（這兩條只給 Agent App）
 *   - 不排 ADMX install / LAPS / BitLocker（只給 enrollment + agent 一次性流程）
 *   - 不注入 DEVICE_ID/TENANT_ID/AGENT_TOKEN MSI properties（普通 app 不需要）
 *
 * 只排 EDA-CSP 三條：MSI install Add + Exec + msi_status_query。
 * Uninstall 排一條：buildMsiUninstall Exec。
 */

async function resolveDeviceAndApp(opts: {
  tenantId: string;
  deviceId: string;
  appId: string;
}): Promise<{
  device: { id: string; tenantId: string; platform: string; udid: string | null };
  app: {
    id: string;
    tenantId: string | null;
    platform: string;
    kind: string;
    fileUrl: string | null;
    fileHash: string | null;
    bundleId: string | null;
    version: string;
    installArgs: string | null;
  };
}> {
  const device = await db.query.mdmDevices.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, opts.deviceId),
    columns: { id: true, tenantId: true, platform: true, udid: true },
  });
  if (!device) throw new AppError(404, "device_not_found", "Device not found");
  if (device.tenantId !== opts.tenantId) {
    throw new AppError(403, "forbidden", "Device belongs to another tenant");
  }
  if (device.platform !== "windows") {
    throw new AppError(400, "unsupported_platform", "App deploy currently supports Windows only");
  }

  const app = await db.query.apps.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, opts.appId),
  });
  if (!app) throw new AppError(404, "app_not_found", "App not found");
  if (app.tenantId !== null && app.tenantId !== opts.tenantId) {
    throw new AppError(403, "forbidden", "App belongs to another tenant");
  }
  if (app.platform !== "windows" || (app.kind !== "msi" && app.kind !== "exe")) {
    throw new AppError(
      400,
      "unsupported_app_kind",
      "App must be Windows .msi or .exe",
    );
  }
  return { device, app };
}

export interface InstallAppInput {
  tenantId: string;
  deviceId: string;
  appId: string;
  installArgsOverride?: string;
}

export interface InstallAppResult {
  commandIds: string[];
}

export async function installAppOnDevice(input: InstallAppInput): Promise<InstallAppResult> {
  const { device, app } = await resolveDeviceAndApp(input);

  if (!app.fileUrl || !app.fileHash || !app.bundleId) {
    throw new AppError(
      400,
      "app_not_ready",
      "App missing fileUrl / fileHash / bundleId (MSI ProductCode)",
    );
  }

  const config = await getActiveSelfMdmConfig();
  const downloadBase = (config.appDownloadBaseUrl ?? config.publicBaseUrl).replace(/\/+$/, "");
  const contentUri = `${downloadBase}${app.fileUrl}`;
  const installCommandLine = input.installArgsOverride ?? app.installArgs ?? "/quiet /norestart";

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
    msiInstallExec = { ...msiInstall, cmdId: "0", verb: "Exec" as const };
    msiStatus = buildMsiStatusQuery(app.bundleId);
  } catch (err) {
    throw new AppError(
      400,
      "invalid_product_code",
      `app.bundleId 必須是合法 MSI ProductCode GUID：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const commandRows = [
    { commandType: "msi_install", cmd: msiInstall, commandUuid: crypto.randomUUID() },
    { commandType: "msi_install", cmd: msiInstallExec, commandUuid: crypto.randomUUID() },
    { commandType: "msi_status_query", cmd: msiStatus, commandUuid: crypto.randomUUID() },
  ];

  const inserted = await db.insert(mdmCommands).values(
    commandRows.map(({ commandType, cmd, commandUuid }) => ({
      tenantId: input.tenantId,
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
        appDeploy: { appId: app.id, appVersion: app.version, appBundleId: app.bundleId },
      },
      cspPath: cmd.target,
      syncmlVerb: cmd.verb,
      syncmlData: cmd.data ?? null,
      syncmlFormat: cmd.format ?? undefined,
    })),
  ).returning({ id: mdmCommands.id });

  // fire-and-forget command.queued webhook events（跟 install-agent 一致 pattern）
  for (const { commandType, cmd, commandUuid } of commandRows) {
    publishCommandEvent({
      tenantId: input.tenantId,
      deviceId: device.id,
      commandUuid,
      commandType,
      status: "queued",
      platform: "windows",
      cspPath: cmd.target,
    });
  }

  // fire-and-forget WNS push 喚醒設備秒級拉命令（device 有 channel 才會發；不阻塞 enqueue）
  if (device.udid) {
    triggerWnsPush(device.udid).catch((e) => {
      console.warn(
        `[App Deploy] WNS push 觸發失敗（不影響 enqueue）: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  return { commandIds: inserted.map((r) => r.id) };
}

export interface UninstallAppInput {
  tenantId: string;
  deviceId: string;
  appId: string;
}

export interface UninstallAppResult {
  commandIds: string[];
}

export async function uninstallAppOnDevice(input: UninstallAppInput): Promise<UninstallAppResult> {
  const { device, app } = await resolveDeviceAndApp(input);
  if (!app.bundleId) {
    throw new AppError(400, "app_missing_product_code", "App row 缺 bundleId（MSI ProductCode）");
  }

  let msiUninstall: SyncMLCommand;
  let msiStatus: SyncMLCommand;
  try {
    msiUninstall = buildMsiUninstall(app.bundleId, "Device");
    msiStatus = buildMsiStatusQuery(app.bundleId);
  } catch (err) {
    throw new AppError(
      400,
      "invalid_product_code",
      `app.bundleId 必須是合法 MSI ProductCode GUID：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const commandRows = [
    { commandType: "msi_uninstall", cmd: msiUninstall, commandUuid: crypto.randomUUID() },
    { commandType: "msi_status_query", cmd: msiStatus, commandUuid: crypto.randomUUID() },
  ];

  const inserted = await db.insert(mdmCommands).values(
    commandRows.map(({ commandType, cmd, commandUuid }) => ({
      tenantId: input.tenantId,
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
        appDeploy: { appId: app.id, appVersion: app.version, appBundleId: app.bundleId, action: "uninstall" },
      },
      cspPath: cmd.target,
      syncmlVerb: cmd.verb,
      syncmlData: cmd.data ?? null,
      syncmlFormat: cmd.format ?? undefined,
    })),
  ).returning({ id: mdmCommands.id });

  for (const { commandType, cmd, commandUuid } of commandRows) {
    publishCommandEvent({
      tenantId: input.tenantId,
      deviceId: device.id,
      commandUuid,
      commandType,
      status: "queued",
      platform: "windows",
      cspPath: cmd.target,
    });
  }

  return { commandIds: inserted.map((r) => r.id) };
}
