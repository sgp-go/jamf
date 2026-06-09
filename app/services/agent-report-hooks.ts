import type { CheckinAction } from "~/services/laps.ts";
import { handleLapsOnCheckin, handleLapsOnReport } from "~/services/laps.ts";
import { handleBitLockerOnReport } from "~/services/bitlocker.ts";

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
    const [laps, bitlocker] = await Promise.allSettled([
      handleLapsOnReport({ tenantId, deviceId, extraData }),
      handleBitLockerOnReport({ tenantId, deviceId, extraData }),
    ]);
    if (laps.status === "rejected") {
      console.error("[laps] handleLapsOnReport failed", laps.reason);
    }
    if (bitlocker.status === "rejected") {
      console.error("[bitlocker] handleBitLockerOnReport failed", bitlocker.reason);
    }
  },
  onCheckin(opts) {
    return handleLapsOnCheckin(opts);
  },
};
