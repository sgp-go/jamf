import { AppError } from "~/lib/errors.ts";
import type { Profile } from "~/db/schema/profiles.ts";
import type { MdmDevice } from "~/db/schema/devices.ts";
import { enqueueWindowsCommand } from "~/services/mdm/windows/command.ts";
import type { SyncMLCommand } from "~/services/mdm/windows/syncml.ts";

/**
 * Profile Push 引擎 MVP（W3 主軸 1）。
 *
 * 把 profile.payload.csps 拆成 SyncMLCommand 一條一條 enqueueWindowsCommand。
 * 每條命令 commandType = `profile_apply:<profileId>`，便於 task 19 ack 反查到
 * 對應的 profile_assignment 更新狀態。
 *
 * 限制（W3 後段擴展）：
 * - 只支援 Windows 平台（Apple plist push 走 Apple MDM 另一通道）
 * - scope=device_group 的 fan-out 不在此 helper 內（caller 自己解析 group → devices）
 * - 不做差異化（每次重推全量 payload；W3 後段比對 appliedVersion 決定增量）
 * - 失敗重試交 caller（目前 push 失敗只記錄不阻塞 assign 主流程）
 *
 * Payload Schema（已在 createProfile body example / OpenAPI 文檔）：
 * ```
 * {
 *   csps: [
 *     { path: "./Device/Vendor/MSFT/Policy/Config/...", verb: "Replace",
 *       format: "int", data: "8" },
 *     { path: "./Vendor/MSFT/WiFi/Profile/SchoolWiFi/WlanXml", verb: "Add",
 *       format: "chr", data: "<?xml version=...>" },
 *     ...
 *   ]
 * }
 * ```
 */

type CspVerb = "Add" | "Replace" | "Exec" | "Get" | "Delete";
type CspFormat = "int" | "chr" | "xml" | "b64" | "node";

interface CspCommand {
  path: string;
  verb: CspVerb;
  format?: CspFormat;
  data?: string;
}

const VALID_VERBS: readonly string[] = ["Add", "Replace", "Exec", "Get", "Delete"];
const VALID_FORMATS: readonly string[] = ["int", "chr", "xml", "b64", "node"];

/**
 * 解析 profile.payload 取出 csps，校驗格式。
 * 失敗時拋 400 invalid_profile_payload（caller 通常會吃掉錯誤只 log，避免阻塞
 * assign 主流程；但暴露明確錯碼讓上層判斷該不該重試）。
 */
export function parseWindowsProfilePayload(payload: unknown): CspCommand[] {
  if (!payload || typeof payload !== "object") {
    throw new AppError(
      400,
      "invalid_profile_payload",
      "Profile payload must be object",
    );
  }
  const csps = (payload as { csps?: unknown }).csps;
  if (!Array.isArray(csps) || csps.length === 0) {
    throw new AppError(
      400,
      "invalid_profile_payload",
      "Profile payload.csps must be non-empty array",
    );
  }
  return csps.map((raw, i) => validateCsp(raw, i));
}

function validateCsp(raw: unknown, index: number): CspCommand {
  if (!raw || typeof raw !== "object") {
    throw new AppError(
      400,
      "invalid_profile_payload",
      `csps[${index}] must be object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    throw new AppError(
      400,
      "invalid_profile_payload",
      `csps[${index}].path required (LocURI string)`,
    );
  }
  if (typeof obj.verb !== "string" || !VALID_VERBS.includes(obj.verb)) {
    throw new AppError(
      400,
      "invalid_profile_payload",
      `csps[${index}].verb required one of ${VALID_VERBS.join("/")}`,
    );
  }
  if (
    obj.format !== undefined &&
    (typeof obj.format !== "string" || !VALID_FORMATS.includes(obj.format))
  ) {
    throw new AppError(
      400,
      "invalid_profile_payload",
      `csps[${index}].format must be one of ${VALID_FORMATS.join("/")}`,
    );
  }
  if (obj.data !== undefined && typeof obj.data !== "string") {
    throw new AppError(
      400,
      "invalid_profile_payload",
      `csps[${index}].data must be string`,
    );
  }
  return {
    path: obj.path,
    verb: obj.verb as CspVerb,
    format: obj.format as CspFormat | undefined,
    data: obj.data as string | undefined,
  };
}

/**
 * 把 profile 套用到單一 device：拆 payload.csps → 逐條 enqueueWindowsCommand。
 *
 * 返回所有 commandUuids（順序與 csps 對齊）。caller 通常把 commandIds[0] 存到
 * profile_assignment.lastCommandId 作為「代表性命令」供 ack 鏈反查。
 *
 * @throws 400 platform_not_supported / device_platform_mismatch / invalid_profile_payload
 * @throws 409 device_missing_udid
 */
export async function pushProfileToDevice(opts: {
  profile: Profile;
  device: MdmDevice;
}): Promise<{ commandIds: string[] }> {
  if (opts.profile.platform !== "windows") {
    throw new AppError(
      400,
      "platform_not_supported",
      `Profile push 目前僅支援 windows；profile.platform=${opts.profile.platform}`,
    );
  }
  if (opts.device.platform !== "windows") {
    throw new AppError(
      400,
      "device_platform_mismatch",
      `Cannot push windows profile to ${opts.device.platform} device`,
    );
  }
  if (!opts.device.udid) {
    throw new AppError(
      409,
      "device_missing_udid",
      "Device missing udid; enrollment may be incomplete",
    );
  }

  const csps = parseWindowsProfilePayload(opts.profile.payload);
  const commandIds: string[] = [];

  for (const csp of csps) {
    const cmd: SyncMLCommand = {
      cmdId: "0", // buildSyncML 會分配真實值
      verb: csp.verb,
      target: csp.path,
    };
    if (csp.format !== undefined) cmd.format = csp.format;
    if (csp.data !== undefined) cmd.data = csp.data;

    const commandUuid = await enqueueWindowsCommand({
      deviceUdid: opts.device.udid,
      commandType: `profile_apply:${opts.profile.id}`,
      command: cmd,
    });
    commandIds.push(commandUuid);
  }
  return { commandIds };
}
