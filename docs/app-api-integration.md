# Agent App ↔ 後端 API 集成文件

本文件描述 iOS Agent App 與自建後端（Deno + Hono）之間的 API 對接規格，包含資料流、端點定義、資料模型對照及已知限制。

## 架構概覽

```
┌─────────────────┐         ┌──────────────────────┐         ┌──────────────┐
│  iOS Agent App  │──HTTP──▶│  Deno 後端（Hono）    │──SQL──▶│   SQLite DB   │
│  (SwiftUI)      │         │  localhost:3000       │         │  data/*.db    │
└─────────────────┘         └──────────────────────┘         └──────────────┘
        │                            │
        │                            │── Jamf Pro API ──▶ cogrow.jamfcloud.com
        │                            │
        ▼                            ▼
  StatusCollector              /api/agent/*  （App 專用端點）
  DeviceGuardKit               /api/devices/* （Jamf 代理端點）
```

- **App → 後端**：App 定時採集裝置狀態與使用時長，透過 HTTP POST 上報
- **後端 → SQLite**：後端接收資料後寫入本地 SQLite 資料庫
- **後端 → Jamf**：後端代理 Jamf Pro API，提供裝置列表和命令下發

## 資料流

### 裝置狀態回報

```
StatusCollector.collect()
    → DeviceStatus
    → ReportService.sendReport()
        → AgentReportPayload (JSON)
        → POST /api/agent/report
            → saveReport() → agent_reports 表
```

### 使用時長上報

```
DGKUsageStatsManager.processPendingEvents()
    → DGKStatsRequest
    → UsageService.uploadUsageStats()
        → UsageUploadPayload (JSON)
        → POST /api/agent/usage
            → saveUsageStats() → device_usage_stats 表（UPSERT）
```

---

## API 端點規格

### 1. 上報裝置狀態

**`POST /api/agent/report`**

App 端程式碼：`AgentApp/Sources/Services/ReportService.swift`
後端處理：`src/routes/agent.ts`

#### 請求

```http
POST /api/agent/report
Content-Type: application/json
```

```json
{
  "deviceId": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  "serialNumber": "DMXXX12345",
  "batteryLevel": 85,
  "storageAvailableMb": 52480,
  "storageTotalMb": 131072,
  "networkType": "WiFi",
  "networkSsid": null,
  "screenBrightness": 0.75,
  "osVersion": "18.3.2",
  "appVersion": "1.0.0",
  "reportedAt": "2025-01-15T08:30:00Z"
}
```

#### 欄位說明

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `deviceId` | `string` | ✅ | 裝置識別碼（Jamf managementId 或 vendorId） |
| `serialNumber` | `string` | ✅ | 裝置序列號 |
| `batteryLevel` | `int` | 否 | 電量百分比，0–100 |
| `storageAvailableMb` | `int` | 否 | 可用儲存空間（MB） |
| `storageTotalMb` | `int` | 否 | 總儲存空間（MB） |
| `networkType` | `string` | 否 | 網路類型（見[已知限制](#已知限制)） |
| `networkSsid` | `string?` | 否 | Wi-Fi SSID（見[已知限制](#已知限制)） |
| `screenBrightness` | `double` | 否 | 螢幕亮度，0.0–1.0 |
| `osVersion` | `string` | 否 | 系統版本，如 `"18.3.2"` |
| `appVersion` | `string` | 否 | App 版本號 |
| `reportedAt` | `string` | 否 | ISO 8601 時間戳。省略時後端使用 `datetime('now')` |

#### 成功回應 `200`

```json
{ "ok": true, "reportId": 42 }
```

#### 錯誤回應 `400`

```json
{ "error": "deviceId and serialNumber are required" }
```

---

### 2. 查詢裝置回報歷史

**`GET /api/agent/reports/:deviceId`**

後端處理：`src/routes/agent.ts`

#### 查詢參數

| 參數 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `limit` | `int` | `50` | 每頁筆數 |
| `offset` | `int` | `0` | 跳過筆數 |

#### 回應 `200`

```json
{
  "deviceId": "A1B2C3D4-...",
  "count": 2,
  "reports": [
    {
      "id": 42,
      "batteryLevel": 85,
      "storageAvailableMb": 52480,
      "storageTotalMb": 131072,
      "networkType": "WiFi",
      "networkSsid": null,
      "screenBrightness": 0.75,
      "osVersion": "18.3.2",
      "appVersion": "1.0.0",
      "extraData": null,
      "reportedAt": "2025-01-15T08:30:00Z"
    }
  ]
}
```

---

### 3. 取得裝置最新回報

**`GET /api/agent/latest/:deviceId`**

後端處理：`src/routes/agent.ts`

#### 回應 `200`

```json
{
  "id": 42,
  "deviceId": "A1B2C3D4-...",
  "serialNumber": "DMXXX12345",
  "batteryLevel": 85,
  "storageAvailableMb": 52480,
  "storageTotalMb": 131072,
  "networkType": "WiFi",
  "networkSsid": null,
  "screenBrightness": 0.75,
  "osVersion": "18.3.2",
  "appVersion": "1.0.0",
  "reportedAt": "2025-01-15T08:30:00Z"
}
```

#### 錯誤回應 `404`

```json
{ "error": "No reports found" }
```

---

### 4. 上報使用時長

**`POST /api/agent/usage`**

App 端程式碼：`AgentApp/Sources/Services/UsageService.swift`
後端處理：`src/routes/agent.ts`
資料來源：`DeviceGuardKit` 的 `DGKUsageStatsManager`

#### 請求

```http
POST /api/agent/usage
Content-Type: application/json
```

```json
{
  "deviceId": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  "sessionId": "session-uuid-optional",
  "stats": [
    {
      "date": "2025-01-15",
      "totalMinutes": 180,
      "pickup": 25,
      "maxContinuous": 45,
      "timeStats": [
        { "hour": 8, "minutes": 30 },
        { "hour": 9, "minutes": 55 },
        { "hour": 10, "minutes": 42 }
      ]
    }
  ]
}
```

#### 欄位說明

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `deviceId` | `string` | ✅ | 裝置識別碼 |
| `sessionId` | `string?` | 否 | DeviceGuardKit 會話 ID |
| `stats` | `array` | ✅ | 每日統計陣列（不可為空） |
| `stats[].date` | `string` | ✅ | 日期，格式 `YYYY-MM-DD` |
| `stats[].totalMinutes` | `int` | ✅ | 當日總使用分鐘數 |
| `stats[].pickup` | `int` | ✅ | 當日解鎖次數 |
| `stats[].maxContinuous` | `int` | ✅ | 最長連續使用分鐘數 |
| `stats[].timeStats` | `array?` | 否 | 每小時使用分鐘數明細 |
| `stats[].timeStats[].hour` | `int` | ✅ | 小時（0–23） |
| `stats[].timeStats[].minutes` | `int` | ✅ | 該小時使用分鐘數 |

> **UPSERT 行為**：同一 `deviceId` + `date` 的記錄會被覆蓋更新。

#### 成功回應 `200`

```json
{ "ok": true, "savedCount": 1 }
```

#### 錯誤回應 `400`

```json
{ "error": "deviceId and stats are required" }
```

---

### 5. 查詢使用時長

**`GET /api/agent/usage/:deviceId`**

後端處理：`src/routes/agent.ts`

#### 查詢參數

| 參數 | 型別 | 說明 |
|------|------|------|
| `date` | `string` | 精確日期篩選（`YYYY-MM-DD`），與 `startDate`/`endDate` 互斥 |
| `startDate` | `string` | 起始日期（含） |
| `endDate` | `string` | 結束日期（含） |
| `limit` | `int` | 回傳筆數上限 |

> 若同時提供 `date` 和 `startDate`/`endDate`，優先使用 `date`。

#### 回應 `200`

```json
{
  "deviceId": "A1B2C3D4-...",
  "count": 1,
  "stats": [
    {
      "id": 7,
      "date": "2025-01-15",
      "totalMinutes": 180,
      "pickup": 25,
      "maxContinuous": 45,
      "timeStats": [
        { "hour": 8, "minutes": 30 }
      ],
      "reportedAt": "2025-01-15T23:00:00.000Z"
    }
  ]
}
```

---

## 資料模型對照表

### 裝置狀態回報

| iOS (Swift) | API JSON | 資料庫欄位 | 型別 |
|-------------|----------|-----------|------|
| `AgentReportPayload.deviceId` | `deviceId` | `device_id` | TEXT |
| `AgentReportPayload.serialNumber` | `serialNumber` | `serial_number` | TEXT |
| `AgentReportPayload.batteryLevel` | `batteryLevel` | `battery_level` | INTEGER |
| `AgentReportPayload.storageAvailableMb` | `storageAvailableMb` | `storage_available_mb` | INTEGER |
| `AgentReportPayload.storageTotalMb` | `storageTotalMb` | `storage_total_mb` | INTEGER |
| `AgentReportPayload.networkType` | `networkType` | `network_type` | TEXT |
| `AgentReportPayload.networkSsid` | `networkSsid` | `network_ssid` | TEXT |
| `AgentReportPayload.screenBrightness` | `screenBrightness` | `screen_brightness` | REAL |
| `AgentReportPayload.osVersion` | `osVersion` | `os_version` | TEXT |
| `AgentReportPayload.appVersion` | `appVersion` | `app_version` | TEXT |
| （未使用） | `extraData` | `extra_data` | TEXT (JSON) |
| `AgentReportPayload.reportedAt` | `reportedAt` | `reported_at` | TEXT |

### 使用時長

| iOS (Swift) | API JSON | 資料庫欄位 | 型別 |
|-------------|----------|-----------|------|
| `UsageUploadPayload.deviceId` | `deviceId` | `device_id` | TEXT |
| `UsageUploadPayload.sessionId` | `sessionId` | `session_id` | TEXT |
| `UsageStatItem.date` | `stats[].date` | `date` | TEXT |
| `UsageStatItem.totalMinutes` | `stats[].totalMinutes` | `total_minutes` | INTEGER |
| `UsageStatItem.pickup` | `stats[].pickup` | `pickup` | INTEGER |
| `UsageStatItem.maxContinuous` | `stats[].maxContinuous` | `max_continuous` | INTEGER |
| `UsageStatItem.timeStats` | `stats[].timeStats` | `time_stats` | TEXT (JSON) |

---

## 日期格式約定

| 場景 | 格式 | 範例 | 使用位置 |
|------|------|------|---------|
| 裝置狀態回報的 `reportedAt` | ISO 8601 | `2025-01-15T08:30:00Z` | `ReportService.swift` 使用 `ISO8601DateFormatter` |
| 使用時長的 `date` | `YYYY-MM-DD` | `2025-01-15` | `UsageService.swift` 從 DGK 取得 |
| 使用時長查詢參數 | `YYYY-MM-DD` | `2025-01-15` | `GET /api/agent/usage/:deviceId?date=` |
| 資料庫 `created_at` | SQLite datetime | `2025-01-15 08:30:00` | 後端自動填入 `datetime('now')` |

---

## App 端配置

App 透過 `UserDefaults` 儲存以下配置項（可由 MDM Configuration Profile 注入）：

| Key | 預設值 | 說明 |
|-----|--------|------|
| `serverURL` | `http://localhost:3000` | 後端 API 基礎 URL |
| `deviceId` | `UIDevice.identifierForVendor` | 裝置識別碼 |
| `serialNumber` | `"unknown"` | 裝置序列號（需手動設定或 MDM 注入） |

配置程式碼位於 `AgentApp/Sources/Services/ReportService.swift`。

---

## 已知限制

### `networkSsid` 始終為 `null`

**原因**：取得 Wi-Fi SSID 需要 `com.apple.developer.networking.HotspotConfiguration` entitlement 和 `NEHotspotNetwork` API。目前 App 未啟用此權限。

**程式碼**：`StatusCollector.swift:24`
```swift
networkSsid: nil, // 需要 NEHotspotNetwork entitlement（許可權）
```

### `networkType` 固定為 `"WiFi"`

**原因**：目前為硬編碼值，未使用 `NWPathMonitor` 做實際網路類型偵測。

**程式碼**：`StatusCollector.swift:56-60`
```swift
private func networkType() -> String {
    return "WiFi"
}
```

### `extraData` 欄位未被 App 使用

後端 `AgentReport` 介面定義了 `extraData?: Record<string, unknown>`，資料庫也有 `extra_data TEXT` 欄位，但 iOS 端的 `AgentReportPayload` 沒有此欄位。此欄位保留供未來擴充使用。

### 無認證機制

目前所有 `/api/agent/*` 端點**無需認證**即可存取。在正式環境中需加入認證中介軟體（如 API Key 或 JWT）。

---

## 相關原始碼索引

| 模組 | 檔案 | 說明 |
|------|------|------|
| 後端路由 | `src/routes/agent.ts` | Agent API 端點定義 |
| 後端儲存 | `src/db/sqlite.ts` | 資料庫 schema 與 CRUD |
| 後端型別 | `src/jamf/types.ts` | Jamf API 型別定義 |
| App 上報 | `AgentApp/Sources/Services/ReportService.swift` | 裝置狀態上報 |
| App 使用時長 | `AgentApp/Sources/Services/UsageService.swift` | 使用時長上報 |
| App 狀態採集 | `AgentApp/Sources/Services/StatusCollector.swift` | 裝置資訊採集 |
| App 模型 | `AgentApp/Sources/Models/DeviceStatus.swift` | 狀態與 Payload 模型 |
| App 模型 | `AgentApp/Sources/Models/UsageStats.swift` | 使用時長模型 |
| App ViewModel | `AgentApp/Sources/Services/StatusManager.swift` | 定時回報與 UI 狀態管理 |
