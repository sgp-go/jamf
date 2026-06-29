/**
 * 隱私設置 Policy CSP — 強制位置存取
 *
 * `LetAppsAccessLocation` Policy CSP 控制設備上的位置存取設定（Settings > Privacy > Location）。
 * Agent GpsCollector 用 `Windows.Devices.Geolocation.Geolocator.RequestAccessAsync()`，
 * 若使用者把位置存取關閉（或設備出廠預設關閉）會回 `Denied` → GPS 採集跳過。
 *
 * 學校統一管控場景下強制 ForceAllow=1，讓 enrollment 後設備立即可用 Geolocator，
 * 無須使用者手動開啟（且使用者也無法關掉，灰色禁用）。
 *
 * 此 CSP 是 OS 原生 Policy 節點，**不需要 ADMX install**，直接 Replace value 即可。
 *
 * 值定義（Win10+ Policy CSP）：
 *   0 = User in control（OS 預設，使用者可自由切換）
 *   1 = Force Allow（強制啟用，使用者無法關閉）
 *   2 = Force Deny（強制禁用，使用者無法啟用）
 */
import type { SyncMLCommand } from "./syncml.ts";

const LET_APPS_LOCATION_TARGET =
  "./Device/Vendor/MSFT/Policy/Config/Privacy/LetAppsAccessLocation";

export type LocationAccessMode = "user_control" | "force_allow" | "force_deny";

function modeToValue(mode: LocationAccessMode): string {
  switch (mode) {
    case "user_control":
      return "0";
    case "force_allow":
      return "1";
    case "force_deny":
      return "2";
  }
}

/**
 * 推送位置存取策略。
 *
 * 預設 force_allow — enrollment hook 一次性下發後設備永久允許 Geolocator 採集。
 * 切回 user_control / force_deny 是進階場景（例如某 tenant 禁用 GPS 採集）。
 */
export function buildLetAppsAccessLocation(
  mode: LocationAccessMode = "force_allow",
): SyncMLCommand {
  return {
    cmdId: "0",
    verb: "Replace",
    target: LET_APPS_LOCATION_TARGET,
    format: "int",
    data: modeToValue(mode),
  };
}
