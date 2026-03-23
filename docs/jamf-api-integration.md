# Jamf Pro API 整合文件

## 概述

本文件記錄了 Jamf Pro 例項 `cogrow.jamfcloud.com` 的 API 整合配置過程，包括認證方式、憑據建立步驟和 API 使用方法。

- **例項地址**: https://cogrow.jamfcloud.com
- **版本**: 11.25.2
- **管理員賬戶**: Jay Hao (dabuddha@126.com, Federated User)

## API 架構

Jamf Pro 提供兩套 API：

| API | 基礎路徑 | 說明 |
|-----|---------|------|
| **Jamf Pro API** (新版) | `/api/` | RESTful API，推薦使用，支援 Bearer Token 和 Client Credentials |
| **Classic API** (舊版) | `/JSSResource/` | 傳統 API，支援 Basic Auth 和 Bearer Token |

### 內建文件

- Swagger UI: https://cogrow.jamfcloud.com/api/doc/
- OpenAPI Schema: https://cogrow.jamfcloud.com/api/schema/
- API 入口頁面: https://cogrow.jamfcloud.com/api

## 認證方式

### 方式一：Client Credentials（推薦，適用於服務端整合）

這是最安全的長期方案，不依賴使用者密碼。

**憑據資訊（儲存在 `.env` 檔案中）：**

- Client ID: 見 `.env` 檔案的 `JAMF_CLIENT_ID`
- Client Secret: 見 `.env` 檔案的 `JAMF_CLIENT_SECRET`
- Token 有效期: 1800 秒（30 分鐘）
- 關聯 API Role: `Full Access Admin`（520 個許可權，全部許可權）

**獲取 Access Token：**

```bash
curl -X POST "https://cogrow.jamfcloud.com/api/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${JAMF_CLIENT_ID}&client_secret=${JAMF_CLIENT_SECRET}"
```

**響應示例：**

```json
{
  "access_token": "eyJhbGciOiJ...",
  "scope": "Full Access Admin",
  "token_type": "bearer",
  "expires_in": 1799
}
```

### 方式二：Bearer Token（使用者名稱/密碼）

適用於臨時除錯，需要本地標準賬戶（非 SSO/Federated 使用者）。

**獲取 Token：**

```bash
curl -X POST "https://cogrow.jamfcloud.com/api/v1/auth/token" \
  -u "api_admin:${JAMF_API_PASSWORD}"
```

**響應示例：**

```json
{
  "token": "eyJhbGciOiJ...",
  "expires": "2026-03-17T07:12:28.003Z"
}
```

> 注意：Token 預設有效期 20 分鐘，可透過 `/api/v1/auth/keep-alive` 續期。

### 使用 Token 呼叫 API

```bash
curl -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Accept: application/json" \
  https://cogrow.jamfcloud.com/api/v1/jamf-pro-version
```

## 配置建立步驟記錄

### 步驟 1：建立本地標準賬戶

由於管理員賬戶 Jay Hao 是 Federated User（SSO 聯合身份），無法透過使用者名稱/密碼獲取 API Token。因此需要建立一個本地標準賬戶。

1. 進入 **Settings > System > User accounts and groups**
2. 點選 **+ New** 建立新賬戶
3. 填寫資訊：
   - Username: `api_admin`
   - Privilege Set: `Administrator`
   - Access Status: `Enabled`
   - Password: 見 `.env` 檔案
4. 點選 **Save**

> 關鍵點：SSO 對 Federated User 強制生效，所以必須建立本地標準賬戶才能使用 API 的 Basic Auth。

### 步驟 2：透過 API 建立 API Role

使用 api_admin 獲取 Token 後，呼叫 API 建立包含全部許可權的 Role：

```bash
# 獲取所有可用許可權
GET /api/v1/api-role-privileges
# 返回 520 個許可權

# 建立 Role
POST /api/v1/api-roles
{
  "displayName": "Full Access Admin",
  "privileges": ["Access Management Setting Read", "Access Management Setting Update", ...]
}
# 返回 id: 1
```

### 步驟 3：建立 API Client（Integration）

```bash
# 建立 API Integration
POST /api/v1/api-integrations
{
  "authorizationScopes": ["Full Access Admin"],
  "displayName": "Cogrow API Client",
  "enabled": true,
  "accessTokenLifetimeSeconds": 1800
}

# 生成 Client Credentials
POST /api/v1/api-integrations/{id}/client-credentials
# 返回 clientId 和 clientSecret
```

### 步驟 4：驗證

```bash
# 用 Client Credentials 獲取 Token
POST /api/oauth/token
grant_type=client_credentials&client_id=...&client_secret=...

# 測試 API 呼叫
GET /api/v1/jamf-pro-version
# 返回: {"version": "11.25.2-t1772925731845"}
```

## 主要 API 端點分類

### 裝置管理
| 端點 | 說明 |
|------|------|
| `GET /api/v1/computer-inventory` | 獲取電腦庫存列表 |
| `GET /api/v2/mobile-devices` | 獲取移動裝置列表 |
| `GET /api/v1/computer-groups` | 獲取電腦分組 |
| `GET /api/v1/mobile-device-groups` | 獲取裝置分組 |

### 策略與配置
| 端點 | 說明 |
|------|------|
| `GET /api/preview/policies` | 獲取策略列表 |
| `GET /api/v1/scripts` | 獲取指令碼列表 |
| `GET /api/v1/packages` | 獲取軟體包列表 |
| `GET /api/v1/categories` | 獲取分類列表 |

### 使用者管理
| 端點 | 說明 |
|------|------|
| `GET /api/v1/accounts` | 獲取使用者賬戶列表 |
| `GET /api/v1/api-roles` | 獲取 API 角色列表 |
| `GET /api/v1/api-integrations` | 獲取 API 整合列表 |

### 註冊管理
| 端點 | 說明 |
|------|------|
| `GET /api/v1/device-enrollments` | 獲取設備註冊配置 |
| `GET /api/v1/computer-prestages` | 獲取電腦預配置 |
| `GET /api/v1/mobile-device-prestages` | 獲取裝置預配置 |

### 系統資訊
| 端點 | 說明 |
|------|------|
| `GET /api/v1/jamf-pro-version` | 獲取版本資訊 |
| `GET /api/v1/jamf-pro-information` | 獲取例項資訊 |
| `GET /api/startup-status` | 獲取啟動狀態（無需認證）|

## 自建管理平臺 API

後端服務執行在 `http://localhost:3000`，基於 Deno + Hono + SQLite。

### Agent 裝置狀態上報

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/agent/report` | POST | Agent App 上報裝置狀態（電池、儲存、網路等） |
| `/api/agent/reports/:deviceId` | GET | 查詢裝置上報歷史（支援 `limit`/`offset` 分頁） |
| `/api/agent/latest/:deviceId` | GET | 獲取裝置最新一條上報 |

### Agent 使用時長統計

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/agent/usage` | POST | 上報裝置使用時長 |
| `/api/agent/usage/:deviceId` | GET | 查詢裝置使用時長 |

**POST /api/agent/usage 請求體：**

```json
{
  "deviceId": "裝置ID",
  "sessionId": "可選的會話ID",
  "stats": [
    {
      "date": "2026-03-18",
      "totalMinutes": 120,
      "pickup": 15,
      "maxContinuous": 45,
      "timeStats": [{"hour": 9, "minutes": 30}, {"hour": 10, "minutes": 45}]
    }
  ]
}
```

**GET /api/agent/usage/:deviceId 查詢引數：**

| 引數 | 說明 |
|------|------|
| `date` | 查詢指定日期，如 `2026-03-18` |
| `startDate` | 日期範圍起始，如 `2026-03-01` |
| `endDate` | 日期範圍結束，如 `2026-03-31` |
| `limit` | 限制返回條數 |

**資料庫表 `device_usage_stats`：**

```sql
CREATE TABLE device_usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  session_id TEXT,
  date TEXT NOT NULL,              -- "YYYY-MM-DD"
  total_minutes INTEGER NOT NULL,  -- 使用分鐘數
  pickup INTEGER NOT NULL,         -- 解鎖次數
  max_continuous INTEGER NOT NULL,  -- 最長連續使用分鐘數
  time_stats TEXT,                 -- JSON: 每小時統計
  reported_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(device_id, date)          -- 同裝置同日覆蓋更新
);
```

### 裝置管理（代理 Jamf API）

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/devices` | GET | 獲取 Jamf 管理的裝置列表 |
| `/api/devices/:id` | GET | 獲取裝置詳情（合併 Jamf + Agent 資料） |
| `/api/devices/:id/command` | POST | 傳送管理命令（DeviceLock、EraseDevice 等） |

## 注意事項

1. **SSO 限制**: Federated User 無法透過使用者名稱/密碼獲取 API Token，必須使用 Client Credentials 或本地標準賬戶
2. **Token 過期**: Client Credentials Token 有效期 30 分鐘，Bearer Token 有效期 20 分鐘，需要在過期前重新整理
3. **許可權管理**: 當前 `Full Access Admin` Role 包含全部 520 個許可權，生產環境建議按最小許可權原則建立專用 Role
4. **Classic API**: 舊版 API 的 Basic Auth 認證方式將來可能被廢棄，建議優先使用 Jamf Pro API + Client Credentials
5. **速率限制**: Jamf Cloud 例項有 API 速率限制，大量請求時需注意控制頻率
