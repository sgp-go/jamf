# Jamf Explore 專案

## 語言規範

- 專案中**禁止使用簡體中文**，所有中文內容（註釋、字串、文件）一律使用**繁體中文**

## 專案概述

Jamf Pro MDM 平台的 API 整合探索專案。實例地址：`cogrow.jamfcloud.com`（版本 11.25.2）。

## 認證資訊

- 憑據儲存在 `.env` 檔案中（不要提交到 git）
- 推薦使用 **Client Credentials** 認證（`JAMF_CLIENT_ID` / `JAMF_CLIENT_SECRET`）
- 備用方式：本地帳戶 `api_admin` 的 Bearer Token 認證
- 管理員帳戶 Jay Hao 是 Federated User（SSO），無法直接用於 API Basic Auth

## API 使用

- Jamf Pro API (新版): `https://cogrow.jamfcloud.com/api/`
- Classic API (舊版): `https://cogrow.jamfcloud.com/JSSResource/`
- Swagger 文件: `https://cogrow.jamfcloud.com/api/doc/`
- 詳細整合文件: `docs/jamf-api-integration.md`

## 檔案結構

- `.env` - API 憑據（Client ID/Secret、api_admin 帳戶密碼）
- `docs/jamf-api-integration.md` - Jamf API 整合詳細文件
- `docs/app-api-integration.md` - Agent App ↔ 後端 API 集成文件
- `docs/self-hosted-mdm-guide.md` - 自建 MDM 註冊、命令、遷移操作指南
- `src/` - Deno 後端服務（Hono + SQLite）
  - `src/mdm/` - 自建 MDM 模組（checkin、command、dep、apns、apns-client、crypto、enrollment、profiles）
  - `src/scripts/` - PoC 與驗證腳本（poc-http2-apns、verify-apns-client）

**啟動需 `--unstable-http` flag**（APNS 長連線依賴 `Deno.createHttpClient`），已寫入 `deno.json` 的 `dev` / `start` task，直接 `deno task dev` 即可。
- `AgentApp/` - iOS 客戶端應用（Tuist + SwiftUI）
  - `AgentApp/Sources/` - 主應用原始碼（Services、Models、Views）
  - `Frameworks/` - DeviceGuardKit XCFramework 二進位套件
  - `DeviceMonitor/` - DeviceActivityMonitor Extension
  - `Entitlements/` - App Group 等權限設定
  - `fastlane/` - 建置和簽名自動化

## DeviceGuardKit 整合

- SDK 來源：閉源 XCFramework 二進位發佈（原始碼倉庫：`https://github.com/x-innovative/DeviceGuardKit`，私有）
- 整合方式：本地 XCFramework（`AgentApp/Frameworks/DeviceGuardKit.xcframework` + `DeviceGuardKitExtension.xcframework`）
- 構建方式：Clone 原始碼到本地後執行 `Scripts/build-xcframework.sh`，產出包含真機（arm64）+ 模擬器（arm64_x86_64）架構
- App Group / Extension Bundle ID：透過 `AgentApp/Project.swift` 頂部常數配置（`appGroupId`、`extensionBundleId`）
- 不需要 FamilyControls 授權，DeviceActivityMonitor 直接可用
- 使用時長資料透過 `DGKUsageStatsManager.processPendingEvents()` 取得，上報到 `POST /api/agent/usage`

## 自建 API 端點

### Jamf 代理端點（`/api/devices`、`/api/agent`）

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/devices` | GET | 取得 Jamf 管理的裝置列表 |
| `/api/devices/:id` | GET | 取得裝置詳情（Jamf + Agent 資料，含 `lostMode` 狀態） |
| `/api/devices/:id/command` | POST | 傳送管理命令（含 Lost Mode） |
| `/api/devices/:id/app-lock` | POST | 啟用單 App 模式 |
| `/api/devices/:id/app-lock` | DELETE | 停用單 App 模式 |
| `/api/agent/report` | POST | Agent App 上報裝置狀態 |
| `/api/agent/reports/:deviceId` | GET | 查詢裝置上報歷史 |
| `/api/agent/latest/:deviceId` | GET | 取得裝置最新上報 |
| `/api/agent/usage` | POST | 上報裝置使用時長 |
| `/api/agent/usage/:deviceId` | GET | 查詢使用時長（支援 date/startDate/endDate/limit 篩選） |

### 自建 MDM 端點（`/api/mdm`）

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/mdm/checkin` | PUT | MDM 簽入協議（Authenticate/TokenUpdate/CheckOut，XML plist） |
| `/api/mdm/command` | PUT | MDM 命令通道（裝置拉取命令/回傳結果，XML plist） |
| `/api/mdm/enroll` | GET/POST | ADE 註冊端點，回傳 .mobileconfig 描述檔 |
| `/api/mdm/devices` | GET | 列出所有 MDM 註冊裝置（含 `lostMode` 狀態） |
| `/api/mdm/devices/:udid` | GET | 取得 MDM 裝置詳情（含 `lostMode` 狀態） |
| `/api/mdm/devices/:udid/command` | POST | 排入 MDM 命令（含 Lost Mode / App 派送） |
| `/api/mdm/devices/:udid/commands` | GET | 查詢裝置命令歷史 |
| `/api/mdm/devices/:udid/push` | POST | 發送 APNS 推播喚醒裝置 |
| `/api/mdm/devices/:udid/app-lock` | POST | 啟用單 App 模式（動態 profile + InstallProfile） |
| `/api/mdm/devices/:udid/app-lock` | DELETE | 停用單 App 模式（RemoveProfile） |
| `/api/mdm/commands/bulk` | POST | 批次下發同一命令到多台裝置（APNS 長連線 multiplexing） |
| `/api/mdm/dep/pubkey` | GET | 下載自建 MDM 公鑰（供 ABM 上傳） |
| `/api/mdm/dep/token` | POST | 上傳 .p7m DEP token（自動解密、驗證、同步） |
| `/api/mdm/dep/account` | GET | 查詢 DEP 帳戶資訊 |
| `/api/mdm/dep/devices` | GET | 列出 DEP 同步的裝置 |
| `/api/mdm/dep/sync` | POST | 手動觸發 DEP 裝置增量同步 |
| `/api/mdm/dep/profile` | POST | 建立/更新 ADE 描述檔 |
| `/api/mdm/dep/assign` | POST | 將 ADE 描述檔分配給裝置 |
| `/api/mdm/migration/start` | POST | 啟動 Jamf → 自建 MDM 遷移 |
| `/api/mdm/migration/status` | GET | 查詢遷移狀態 |
| `/api/mdm/certs/status` | GET | 查看憑證狀態（APNS/CA/DEP） |
| `/api/mdm/certs/vendor/csr` | GET | 生成 Vendor CSR（供 Apple Developer 後台） |
| `/api/mdm/certs/vendor` | POST | 上傳 Vendor Certificate（.cer） |
| `/api/mdm/certs/apns/csr` | GET | 生成 APNS CSR |
| `/api/mdm/certs/apns/sign` | POST | 用 Vendor Cert 簽署 APNS CSR |
| `/api/mdm/certs/apns` | POST | 上傳 APNS 推播憑證（自動提取 topic） |
| `/api/mdm/certs/ca/regenerate` | POST | 重新生成 CA 根憑證 |

## 注意事項

- `.env` 檔案不要提交到版本控制
- Client Credentials Token 有效期 30 分鐘，需要重新整理
- API Role `Full Access Admin` 包含全部 520 個權限，僅用於開發測試
