# Jamf Explore

Jamf Pro MDM 平台的 API 整合專案，包含後端服務與 iOS Agent App，實現裝置管理、狀態上報與使用時長監控。

## 技術棧

| 層級 | 技術 |
|------|------|
| 後端 | Deno + Hono + SQLite |
| iOS 應用 | SwiftUI + Tuist |
| iOS 簽名 | Fastlane Match |
| 裝置監控 | DeviceGuardKit（XCFramework） |
| MDM 平台 | Jamf Pro |

## 快速開始

### 後端服務

```bash
# 1. 配置環境變數
cp .env.example .env
# 編輯 .env 填入 Jamf Pro API 憑據

# 2. 啟動服務
deno task dev
```

### iOS 應用

```bash
# 1. 配置 fastlane 環境變數
cp AgentApp/fastlane/.env.example AgentApp/fastlane/.env
# 編輯 .env 填入 Apple Developer 帳號資訊

# 2. 修改應用標識符（參考文件：集成指南）
#    - AgentApp/Project.swift 頂部常數
#    - AgentApp/AgentApp/Sources/AppConstants.swift
#    - AgentApp/DeviceMonitor/DeviceActivityMonitorExtension.swift

# 3. 初始化證書並構建
cd AgentApp
bundle exec fastlane match_init
tuist generate
bundle exec fastlane build_dev
```

## 專案結構

```text
.
├── .env.example              # 後端環境變數範本
├── src/                      # Deno 後端服務
├── AgentApp/
│   ├── Project.swift         # Tuist 專案配置（標識符集中定義處）
│   ├── AgentApp/Sources/     # 主應用原始碼
│   ├── DeviceMonitor/        # DeviceActivityMonitor Extension
│   ├── Frameworks/           # DeviceGuardKit XCFramework
│   └── fastlane/             # 簽名與分發自動化
│       └── .env.example      # Fastlane 環境變數範本
└── docs/                     # 專案文件
```

## 文件目錄

| 文件 | 說明 |
|------|------|
| [Apple Developer 配置指南](docs/apple-developer-setup.md) | Apple Developer Portal 設定、證書管理、**專案集成 Checklist** |
| [Jamf API 整合](docs/jamf-api-integration.md) | Jamf Pro API 認證方式、端點分類、自建管理 API |
| [App API 集成](docs/app-api-integration.md) | iOS Agent App 與後端的 API 對接規格、資料模型 |
| [裝置註冊指南](docs/device-enrollment-guide.md) | ABM + Jamf Pro 裝置註冊完整流程 |
| [裝置繫結步驟](docs/device-binding-steps.md) | iPad 實際繫結操作記錄與故障排除 |
