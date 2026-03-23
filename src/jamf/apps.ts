/** App 管理 API */

import { JamfClient } from "./client.ts";

export interface MobileDeviceApp {
  id: string;
  name: string;
  version: string;
  bundleId: string;
}

export interface AppListResponse {
  totalCount: number;
  results: MobileDeviceApp[];
}

export class AppService {
  constructor(private client: JamfClient) {}

  /** 獲取 Mobile Device Apps 列表 (Classic API) */
  async listApps(): Promise<unknown> {
    return this.client.get("/api/v2/mobile-device-apps");
  }

  /** 獲取裝置上已安裝的 App 列表 */
  async getInstalledApps(deviceId: string): Promise<unknown> {
    // 裝置詳情中包含 applications 欄位
    const detail = await this.client.get<{ applications?: unknown[] }>(
      `/api/v2/mobile-devices/${deviceId}/detail`
    );
    return detail.applications ?? [];
  }
}
