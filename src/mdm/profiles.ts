/**
 * 動態生成配置描述檔
 *
 * 與 enrollment.ts 不同，這裡產出的描述檔是透過 InstallProfile 命令下發，
 * 用於啟用 App Lock（Single App Mode）等功能。
 */

import { buildPlist } from "./plist.ts";
import { Buffer } from "node:buffer";

/** App Lock profile 的固定識別碼，RemoveProfile 時使用 */
export const APP_LOCK_PROFILE_IDENTIFIER = "com.aspira.mdm.applock";

/** App Lock 選項（對應 com.apple.app.lock payload 的 Options key） */
export interface AppLockOptions {
  /** 關閉觸控（預設 false） */
  disableTouch?: boolean;
  /** 關閉螢幕旋轉（預設 false） */
  disableDeviceRotation?: boolean;
  /** 關閉音量鍵（預設 false） */
  disableVolumeButtons?: boolean;
  /** 關閉響鈴開關（預設 false） */
  disableRingerSwitch?: boolean;
  /** 關閉睡眠喚醒鍵（預設 false） */
  disableSleepWakeButton?: boolean;
  /** 關閉自動鎖定（預設 false） */
  disableAutoLock?: boolean;
  /** 啟用語音控制（預設 false） */
  enableVoiceControl?: boolean;
  /** 啟用縮放（預設 false） */
  enableZoom?: boolean;
  /** 啟用 VoiceOver（預設 false） */
  enableVoiceOver?: boolean;
  /** 啟用反轉色彩（預設 false） */
  enableInvertColors?: boolean;
  /** 啟用輔助觸控（預設 false） */
  enableAssistiveTouch?: boolean;
}

function buildOptions(options?: AppLockOptions): Record<string, boolean> {
  if (!options) return {};
  const out: Record<string, boolean> = {};
  if (options.disableTouch !== undefined) out.DisableTouch = options.disableTouch;
  if (options.disableDeviceRotation !== undefined)
    out.DisableDeviceRotation = options.disableDeviceRotation;
  if (options.disableVolumeButtons !== undefined)
    out.DisableVolumeButtons = options.disableVolumeButtons;
  if (options.disableRingerSwitch !== undefined)
    out.DisableRingerSwitch = options.disableRingerSwitch;
  if (options.disableSleepWakeButton !== undefined)
    out.DisableSleepWakeButton = options.disableSleepWakeButton;
  if (options.disableAutoLock !== undefined)
    out.DisableAutoLock = options.disableAutoLock;
  if (options.enableVoiceControl !== undefined)
    out.EnableVoiceControl = options.enableVoiceControl;
  if (options.enableZoom !== undefined) out.EnableZoom = options.enableZoom;
  if (options.enableVoiceOver !== undefined)
    out.EnableVoiceOver = options.enableVoiceOver;
  if (options.enableInvertColors !== undefined)
    out.EnableInvertColors = options.enableInvertColors;
  if (options.enableAssistiveTouch !== undefined)
    out.EnableAssistiveTouch = options.enableAssistiveTouch;
  return out;
}

/**
 * 生成 App Lock（Single App Mode）配置描述檔
 *
 * 注意：僅 supervised 裝置可用。使用固定的 PayloadIdentifier 方便 RemoveProfile 對應移除。
 *
 * @param bundleId 要鎖定的 App Bundle Identifier（如 com.apple.mobilesafari）
 * @param options 可選的額外鎖定選項
 * @returns 描述檔 XML 的 Buffer（直接作為 InstallProfile 的 Payload 參數）
 */
export function generateAppLockProfile(
  bundleId: string,
  options?: AppLockOptions
): Buffer {
  const profileUuid = crypto.randomUUID().toUpperCase();
  const appLockPayloadUuid = crypto.randomUUID().toUpperCase();

  const appLockOptions = buildOptions(options);

  const profile: Record<string, unknown> = {
    PayloadContent: [
      {
        PayloadType: "com.apple.app.lock",
        PayloadVersion: 1,
        PayloadIdentifier: `${APP_LOCK_PROFILE_IDENTIFIER}.payload`,
        PayloadUUID: appLockPayloadUuid,
        PayloadDisplayName: "App Lock",
        PayloadDescription: `鎖定裝置於單一 App：${bundleId}`,
        App: {
          Identifier: bundleId,
          ...(Object.keys(appLockOptions).length > 0
            ? { Options: appLockOptions }
            : {}),
        },
      },
    ],
    PayloadType: "Configuration",
    PayloadVersion: 1,
    PayloadIdentifier: APP_LOCK_PROFILE_IDENTIFIER,
    PayloadUUID: profileUuid,
    PayloadDisplayName: "MDM App Lock",
    PayloadDescription: `將裝置鎖定於 ${bundleId}（單 App 模式）`,
    PayloadRemovalDisallowed: false,
  };

  return Buffer.from(buildPlist(profile), "utf-8");
}
