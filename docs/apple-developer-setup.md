# Apple Developer Portal 配置指南

## 概述

本文件記錄 Aspira Agent App 在 Apple Developer Portal 上所需的全部配置。當使用新的 Apple Developer 賬號時，按照本文件從頭配置即可。

**賬號資訊儲存在 `AgentApp/fastlane/.env` 中**，包括 Apple ID、Team ID、ITC Team ID 等。請參考 `AgentApp/fastlane/.env.example` 了解所需變數。

---

## 一、前置條件

- 已加入 Apple Developer Program（$99/年）
- 擁有 Admin 或 Account Holder 許可權
- 登入 [developer.apple.com/account](https://developer.apple.com/account)

---

## 二、建立 App ID

**路徑**：Certificates, Identifiers & Profiles → Identifiers → 右上角 "+" → App IDs → App

| 欄位 | 值 |
|------|------|
| Description | 你的應用名稱 |
| Bundle ID | `<your-bundle-id>`（選擇 Explicit） |
| Platform | iOS |

**啟用以下 Capabilities（勾選）**：

| Capability | 說明 |
|------------|------|
| ✅ Push Notifications | 用於後續推送通知（可選） |

點選 **Continue** → **Register**。

> 如果 App ID 已存在，進入編輯頁面確認 Capabilities。

---

## 三、建立簽名證書

專案使用 Fastlane Match 管理證書，證書加密儲存在 Git 倉庫中。

### 3.1 證書倉庫

| 專案 | 值 |
|------|------|
| Git 倉庫 | 儲存在 `AgentApp/fastlane/.env` 的 `MATCH_GIT_URL` 中 |
| 分支 | `aspira` |
| 加密密碼 | 儲存在 `AgentApp/fastlane/.env` 的 `MATCH_PASSWORD` 中 |

### 3.2 需要的證書型別

| 型別 | 用途 | 數量限制 |
|------|------|----------|
| Apple Development | 開發除錯 | 每個賬號最多 2 個 |
| Apple Distribution | Ad Hoc / App Store 分發 | 每個賬號最多 3 個 |

### 3.3 使用 Match 自動建立

配置好 App ID 後，在專案目錄執行：

```bash
cd AgentApp

# 配置環境變數
source fastlane/.env
export MATCH_PASSWORD FASTLANE_USER FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD

# 首次初始化（建立證書 + Provisioning Profiles）
bundle exec fastlane match_init
```

Match 會自動：
1. 建立 Development 和 Distribution 證書（如果不存在）
2. 為你的 Bundle ID 建立 Provisioning Profiles
3. 加密後推送到 Git 倉庫的 aspira 分支

### 3.4 手動建立證書（備選方案）

如果 Match 自動建立失敗（如證書數量達上限），需要手動操作：

1. **撤銷不需要的證書**：Certificates → 找到舊證書 → Revoke
2. **或匯入已有證書**：
   ```bash
   bundle exec fastlane match import --type adhoc
   # 按提示輸入 .cer 和 .p12 檔案路徑
   ```

---

## 四、Provisioning Profiles

Match 會自動建立以下 Profiles：

| Profile 名稱 | 型別 | Bundle ID |
|-------------|------|-----------|
| match Development `<your-bundle-id>` | Development | `<your-bundle-id>` |
| match AdHoc `<your-bundle-id>` | Ad Hoc | `<your-bundle-id>` |

### 手動檢查 Profiles

**路徑**：Profiles → 搜尋你的應用名稱

每個 Profile 需要確認：
- 關聯的 Certificate 未過期
- 包含了目標測試裝置的 UDID（Ad Hoc 型別）
- Capabilities 與 App ID 一致

---

## 五、測試設備註冊

Ad Hoc 分發需要註冊目標裝置的 UDID。

**路徑**：Devices → 右上角 "+"

| 欄位 | 值 |
|------|------|
| Platform | iOS |
| Device Name | 例如 "Test iPad 9th Gen" |
| Device ID (UDID) | 透過 Finder/Apple Configurator 獲取 |

### 獲取 iPad UDID

1. 將 iPad 連線到 Mac
2. 開啟 **Finder** → 左側欄點選 iPad
3. 點選 iPad 名稱下方的資訊文字（序列號 → UDID），直到顯示 UDID
4. 右鍵複製 UDID

### 新增裝置後更新 Profiles

新增新裝置後需要重新生成 Ad Hoc Profiles：

```bash
bundle exec fastlane match adhoc --force_for_new_devices
```

---

## 六、App Store Connect 配置（可選）

如果需要透過 TestFlight 或 App Store 分發，還需要在 App Store Connect 中建立 App 記錄。

**路徑**：[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → My Apps → "+"

| 欄位 | 值 |
|------|------|
| Platform | iOS |
| Name | 你的應用名稱 |
| Primary Language | English (U.S.) 或 Chinese (Traditional) |
| Bundle ID | `<your-bundle-id>` |
| SKU | `<your-bundle-id>` |

---

## 七、App-Specific Password

Fastlane 自動上傳（TestFlight 等）需要 App-Specific Password。

1. 訪問 [appleid.apple.com](https://appleid.apple.com)
2. 登入 → Sign-In and Security → App-Specific Passwords
3. 點選 "+" 生成新密碼，標籤填 "Fastlane"
4. 將密碼儲存到 `AgentApp/fastlane/.env`：
   ```
   FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

---

## 八、專案集成與換新賬號 Checklist

當使用新的 Apple Developer 賬號或將專案部署到新環境時，按以下順序操作。

### 8.1 應用標識符替換

專案已將所有可配置標識符集中定義，替換時只需修改以下 3 個位置：

**位置一：Tuist 構建配置** — `AgentApp/Project.swift`（第 3-10 行）

```swift
// ── 專案標識符（甲方請修改此處） ──
let organizationName = "YourOrg"
let mainBundleId = "com.yourorg.your.app"       // 主應用 Bundle ID
let extensionBundleId = "\(mainBundleId).devicemonitor"  // 自動衍生
let appGroupId = "group.\(mainBundleId)"                 // 自動衍生
let bgTaskId = "\(mainBundleId).statusReport"            // 自動衍生
let developmentTeam = "YOUR_TEAM_ID"
let displayName = "Your App Name"
```

只需修改 `mainBundleId`、`developmentTeam`、`displayName`、`organizationName`，其餘衍生值自動計算。Entitlements 也由 Tuist inline 生成，無需手動維護 `.entitlements` 檔案。

**位置二：Swift 執行時常數** — `AgentApp/AgentApp/Sources/AppConstants.swift`

```swift
enum AppConstants {
    static let appGroupIdentifier = "group.com.yourorg.your.app"   // 須與 Project.swift 的 appGroupId 一致
    static let bgTaskIdentifier = "com.yourorg.your.app.statusReport"  // 須與 Project.swift 的 bgTaskId 一致
}
```

**位置三：Extension** — `AgentApp/DeviceMonitor/DeviceActivityMonitorExtension.swift`（第 6 行）

```swift
private let appGroupIdentifier = "group.com.yourorg.your.app"  // 須與 AppConstants.appGroupIdentifier 一致
```

> **注意**：三處的 App Group ID 必須完全一致，否則主應用與 Extension 之間的資料共享會失敗。

### 8.2 Fastlane 環境配置

複製 `AgentApp/fastlane/.env.example` → `.env`，填入你的值：

```bash
cp AgentApp/fastlane/.env.example AgentApp/fastlane/.env
```

| 變數 | 說明 | 取得方式 |
|------|------|----------|
| `FASTLANE_USER` | Apple ID | Apple Developer 帳號信箱 |
| `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` | App 專用密碼 | 參考第七節 |
| `MATCH_PASSWORD` | 證書倉庫加密密碼 | 自定義 |
| `MATCH_GIT_URL` | 證書儲存的 Git 倉庫 | 建立一個私有倉庫 |
| `TEAM_ID` | Apple Developer Team ID | developer.apple.com → 帳號 → 成員資格 |
| `ITC_TEAM_ID` | App Store Connect Team ID | App Store Connect → 使用者與存取權限 |
| `APP_IDENTIFIER` | 主應用 Bundle ID | 與 `Project.swift` 中 `mainBundleId` 一致 |
| `EXTENSION_IDENTIFIER` | Extension Bundle ID | 與 `Project.swift` 中 `extensionBundleId` 一致 |

### 8.3 後端服務配置

複製根目錄 `.env.example` → `.env`，填入 Jamf Pro API 憑據：

```bash
cp .env.example .env
```

詳見 `.env.example` 中的變數說明。

### 8.4 Apple Developer Portal 配置

```text
□ 1. 建立主應用 App ID（使用你的 Bundle ID）
     → 啟用 Capabilities：App Groups、Family Controls、Push Notifications（可選）
□ 2. 建立 Extension App ID（Bundle ID + .devicemonitor）
     → 啟用 Capabilities：App Groups、Family Controls
□ 3. 建立 App Group（group. + 你的 Bundle ID）
□ 4. 註冊測試裝置 UDID（參考第五節）
□ 5. 生成 App-Specific Password（參考第七節）
```

### 8.5 構建與驗證

```bash
# 初始化證書
cd AgentApp
bundle exec fastlane match_init

# 生成 Xcode 專案
tuist generate

# 驗證構建
bundle exec fastlane build_dev

# 確認 Bundle ID 只出現在集中定義的位置
grep -rn "<your-bundle-id>" AgentApp/ --include="*.swift"
# 預期結果：只出現在 Project.swift、AppConstants.swift、DeviceActivityMonitorExtension.swift
```

---

## 九、常見問題

### Q: 證書數量達到上限？

- Apple 限制每個賬號 Development 證書 2 個、Distribution 證書 3 個
- 在 Certificates 頁面撤銷不需要的證書
- 或使用 `fastlane match import` 匯入已有證書

### Q: Match 報錯 "Invalid username and password"？

- Apple 的 session 過期了，需要重新登入
- 在終端互動式執行 match 命令，完成 2FA 驗證
- 考慮使用 App Store Connect API Key 替代使用者名稱密碼認證

### Q: Provisioning Profile 中缺少裝置？

```bash
# 新增裝置後強制重新生成 Profiles
bundle exec fastlane match adhoc --force_for_new_devices
bundle exec fastlane match development --force_for_new_devices
```
