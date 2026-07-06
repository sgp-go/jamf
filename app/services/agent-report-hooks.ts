import type { CheckinAction } from "~/services/laps.ts";
import { handleLapsOnCheckin, handleLapsOnReport } from "~/services/laps.ts";
import { handleBitLockerOnReport } from "~/services/bitlocker.ts";
import { buildWingetCheckinActions } from "~/services/winget-deploy.ts";
import { reconcileDeviceName } from "~/services/device-policies.ts";

export type { CheckinAction };

/**
 * Agent 上報副作用的「接縫」接口 —— Agent telemetry 路由與 Control 側
 * （LAPS / BitLocker）之間唯一的領域跨邊點。
 *
 * Agent 路由只依賴本接口，不直接 import laps/bitlocker，跨邊調用收斂到此。
 * - **單部署 / 共用 DB 的雙進程**：注入 {@link directAgentReportHooks}（直連）。
 * - **物理隔離（無共用 DB）**：改注入「發內部事件」實現，由 Control 服務消費，
 *   route 層零改動。
 */
export interface AgentReportHooks {
  /** 設備上報後的副作用（目前僅 Windows：LAPS 輪換確認 + BitLocker recovery key 捕獲）。 */
  onReport(opts: {
    tenantId: string;
    deviceId: string;
    extraData: Record<string, unknown>;
  }): Promise<void>;
  /** 設備 checkin 的 LAPS 處理，回傳待辦動作（密碼走 CSP，動作僅告知）。 */
  onCheckin(opts: {
    tenantId: string;
    deviceId: string;
    lapsRotationId?: string;
  }): Promise<CheckinAction[]>;
}

/**
 * 直連實現：Agent 上報直接觸發 Control 側 LAPS / BitLocker 處理
 * （寫 mdm_commands 隊列，由 OMA-DM 協議層拉走）。共用 DB 的拓撲下皆適用。
 */
export const directAgentReportHooks: AgentReportHooks = {
  async onReport({ tenantId, deviceId, extraData }) {
    if (extraData?.platform !== "windows") return;
    // 自動命名 reconcile：enroll 當下序號未到只能 skip，agent 首次上報 backfill 序號後，
    // 這裡才算得出含 {serial*} 的最終名並派一次 rename（assignedName 去重，後續上報自動 skip）。
    const [laps, bitlocker, naming] = await Promise.allSettled([
      handleLapsOnReport({ tenantId, deviceId, extraData }),
      handleBitLockerOnReport({ tenantId, deviceId, extraData }),
      reconcileDeviceName({ tenantId, deviceId }),
    ]);
    if (laps.status === "rejected") {
      console.error("[laps] handleLapsOnReport failed", laps.reason);
    }
    if (bitlocker.status === "rejected") {
      console.error("[bitlocker] handleBitLockerOnReport failed", bitlocker.reason);
    }
    if (naming.status === "rejected") {
      console.error("[naming] reconcileDeviceName failed", naming.reason);
    } else if (naming.value.action === "dispatch") {
      console.log(
        `[naming] 自動重命名已排入 deviceId=${deviceId} name="${naming.value.desiredName}"`,
      );
    }
  },
  async onCheckin(opts) {
    const [lapsActions, wingetActions] = await Promise.all([
      handleLapsOnCheckin(opts),
      buildWingetCheckinActions(opts.deviceId),
    ]);
    // CheckinAction 介面與 WingetCheckinAction 同形（type/priority/data），
    // 直接 concat；Agent 按 type 分發處理
    return [...lapsActions, ...wingetActions];
  },
};
