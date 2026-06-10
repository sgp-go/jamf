# iOS Agent App 對接與部署文檔

> 給台灣後端團隊 / IT 管理員。對齊 `ios-agent-app/`（Tuist + SwiftUI）實作與後端
> `/api/v1` 多租戶 API。Windows 對應文檔在 [`../windows-deployment/`](../windows-deployment/)。

iOS Agent App 定位：**背景數據收集器**（使用時長、設備狀態），透過 Jamf MDM 分發、
Managed App Configuration 注入配置、帶 token 上報。不參與 MDM 命令通道（鎖定 / 抹除 /
重啟走 Jamf MDM 命令，由後端 `POST .../devices/{did}/commands` 路由）。

## 文檔導航

| 文檔 | 主題 | 對象 |
|---|---|---|
| [managed-app-config.md](./managed-app-config.md) | **Managed App Configuration 完整鍵契約** + token 簽發流程 + SSID/entitlement | 後端 + IT（必讀）|
| [abm-distribution.md](./abm-distribution.md) | ABM Custom App 上傳、Jamf 關聯、版本管理 | 我方 ops + 後端 |
| [apns-certificate.md](./apns-certificate.md) | Apple Push 憑證申請、續期、多租戶隔離 | 後端 ops |
| [app-rollout.md](./app-rollout.md) | iOS App 更新與灰度策略（對比 Windows agent-rollout）| 後端 + ops |
| [../apple-developer-setup.md](../apple-developer-setup.md) | **換 Apple 開發者賬號 / 簽名憑據交接 Checklist**（Bundle ID、Team ID、Fastlane `.env`、Match 憑證倉庫替換）| 自行構建簽名方（必讀）|

> **構建簽名歸屬**：若由台灣團隊自行構建並用自家 Apple 賬號分發 Agent App，必須先按 [apple-developer-setup.md §8](../apple-developer-setup.md) 把 `Project.swift` 標識符、`fastlane/.env`（複製自 `.env.example`）、Match 憑證倉庫全部替換為台灣團隊自己的值——勿沿用我方倉庫中的開發憑據。若由我方統一以 ABM Custom App 分發（見 [abm-distribution.md](./abm-distribution.md)），則台灣團隊不碰簽名，此步跳過。

## 與 Windows 的能力差異（重要）

| 能力 | iOS | Windows | 說明 |
|---|---|---|---|
| 使用時長 / 設備狀態上報 | ✅ | ✅ | schema 共用 |
| token 鑑權 | ✅（agent-token 端點簽發 + managed config 注入）| ✅（install-agent MSI 注入）| 鑑權機制一致 |
| 啟動 checkin | ❌ 不需要 | ✅ | checkin 用途（LAPS/BitLocker 待辦）是 Windows 專屬 |
| LAPS / BitLocker / 螢幕鎖定 | ❌ | ✅ | iOS 對應能力走 Jamf MDM 命令（Lost Mode / 單 App 模式）|
| App 自動更新 | ABM Custom App 重新分發 | EDA-CSP 灰度推 MSI | 見 [app-rollout.md](./app-rollout.md) |

## 快速上手（單台設備端到端）

```
1. POST /admin/tenants                                    建 tenant（一次性）
2. POST /admin/tenants/{tid}/device-groups                建分組（學校）
3. POST /admin/tenants/{tid}/jamf-instances + /verify     綁 Jamf 實例
4. POST /admin/tenants/{tid}/jamf-instances/{iid}/sync-devices   同步設備
5. POST /admin/tenants/{tid}/devices/{deviceId}/agent-token      簽發 token（記下 agentToken）
6. Jamf 派 Custom App + App Configuration（注入 5 個鍵，見 managed-app-config.md）
7. App 啟動讀 config → 帶 Bearer token 每日上報 → 你方收 webhook agent.reported
```
