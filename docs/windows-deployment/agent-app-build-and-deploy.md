# Agent App 構建與部署指南

> **適用對象**：台灣團隊後端工程師。
> **前提**：MDM 後端已部署、tenant 已建立、push MSIX 已上傳。

---

## 1. Agent App 概述

Agent App 是安裝在每台 Windows 設備上的後台服務（Windows Service），負責：

- 定期上報設備狀態（電池、存儲、網路、OS 版本）
- 監聽 MDM 下發的策略信箱（LAPS 密碼輪換、遠端鎖屏、預配套件移除、自卸載）
- 執行使用時長採集

安裝方式：MDM 透過 EDA-CSP（EnterpriseDesktopAppManagement）自動下發 `.msi`，設備 BITS 下載 → msiexec 安裝 → 服務自動啟動。**不需要人工到設備上操作**。

---

## 2. 構建 MSI

### 環境需求

| 工具 | 版本 | 說明 |
|------|------|------|
| .NET SDK | 8.0+ | `dotnet --version` 確認 |
| WiX Toolset | 5.0+ | MSI 打包（NuGet 自動還原） |
| Windows | 10/11 x64 | 必須在 Windows 上構建（self-contained publish 為 win-x64） |

### 構建步驟

```powershell
cd win-agent-app
powershell -ExecutionPolicy Bypass -File build.ps1 -Version 1.0.0.0
```

**參數**：

| 參數 | 說明 | 預設 |
|------|------|------|
| `-Version` | 產品版本號（如 `1.3.12.0`） | `1.0.0.0` |
| `-Configuration` | `Release` 或 `Debug` | `Release` |
| `-SelfContained` | 是否包含 .NET Runtime | `$true`（推薦，設備不需裝 .NET） |
| `-CertThumbprint` | 簽名憑證指紋（選填） | 不簽名 |

**產出**：

```
win-agent-app/build/msi/CoGrowMDMAgent.msi    (~76 MB, self-contained)
```

### MSI 全租戶通用

**不需要每個租戶單獨構建 MSI**。設備專屬配置（device_id / agent_token / api_endpoint / tenant_id）在安裝時透過 msiexec 命令行注入，由 MDM 的 EDA-CSP CommandLine 動態傳入：

```
msiexec /i agent.msi /quiet DEVICE_ID=xxx AGENT_TOKEN=xxx API_ENDPOINT=https://xxx TENANT_ID=xxx
```

一個 MSI 二進制檔適用所有租戶、所有設備。

---

## 3. 上傳 MSI 到後端

透過 Admin API 上傳（multipart/form-data）：

```bash
curl -X POST /api/v1/admin/tenants/{tenantId}/apps \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@CoGrowMDMAgent.msi" \
  -F "displayName=CoGrow MDM Agent" \
  -F "version=1.3.12.0" \
  -F "bundleId={176848CB-7917-4829-B158-F18F7585B7DA}"
```

上傳後後端會：
1. 計算 SHA-256 hash（設備下載後驗證完整性）
2. 存到本地 `data/apps/{appId}.msi`
3. 返回 `appId`（後續 install-agent 用）

> ⚠️ `bundleId` 填 MSI 的 ProductCode GUID（定義在 WiX `Product.wxs`）。用於 EDA-CSP 識別已安裝應用。

---

## 4. 自動下發流程

設備透過 PPKG 納管後，enrollment hook 自動觸發 `install-agent`，流程全自動：

```
PPKG 納管成功
  → enrollment hook 自動排入命令：
    1. 禁手動註銷（AllowManualMDMUnenrollment=0）
    2. 隱藏復原頁面（PageVisibilityList=hide:recovery）
    3. push 配置（cert 信任 + MSIX 安裝 + WNS channel）
    4. install-agent：
       a. Lock ADMX ingest（遠端鎖屏策略框架）
       b. LAPS ADMX ingest（密碼託管策略框架）
       c. PPKG Removal ADMX ingest（預配套件移除策略框架）
       d. SelfUninstall ADMX ingest（自卸載策略框架）
       e. Agent MSI 派發（EDA-CSP BITS 下載 + msiexec 安裝）
       f. LAPS 首次密碼輪換（自動生成隨機密碼）
  → 設備按序消化命令
  → Agent 啟動 → LapsWatcher 讀 registry → 改密完成
```

**觸發條件**：後端自動選取 tenant 下最新的 Windows MSI app 記錄。確保上傳了 MSI 後再 enroll 設備。

---

## 5. 文件下載 URL 配置

### 問題

Agent MSI 約 76MB。8000 台設備批量部署時若全走公網，帶寬壓力巨大（~608GB）。

### 解決方案

後端支援分離 **MDM 管理通道** 和 **文件下載** 的 URL：

| 參數 | 用途 | 必填 |
|------|------|------|
| `publicBaseUrl` | MDM SyncML 管理通道。用於 enrollment / discovery / management / Agent 上報。**必須公網 HTTPS。** | 是 |
| `appDownloadBaseUrl` | MSI / MSIX 文件下載基底 URL。可指向校內 LAN 或 CDN。**為 `null` 時回退到 `publicBaseUrl`。** | 否 |

設備下載 MSI 時的完整 URL：

```
contentUri = (appDownloadBaseUrl ?? publicBaseUrl) + app.fileUrl
```

### 配置 API

```bash
# 查詢
curl GET /api/v1/admin/tenants/{tid}/mdm-config \
  -H "Authorization: Bearer $TOKEN"

# 設定文件下載走校內 LAN（推薦教育場景）
curl -X PATCH /api/v1/admin/tenants/{tid}/mdm-config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"appDownloadBaseUrl": "http://192.168.1.100:3000"}'

# 清除（回退到 publicBaseUrl）
curl -X PATCH /api/v1/admin/tenants/{tid}/mdm-config \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"appDownloadBaseUrl": null}'
```

### 部署模型選擇

| 模型 | publicBaseUrl | appDownloadBaseUrl | 適用 |
|------|------|------|------|
| A. 同服務器 | `https://mdm.school.edu` | `null` | < 500 台，帶寬充足 |
| B. 校內 LAN（推薦） | `https://mdm.school.edu` | `http://192.168.1.100:3000` | 教育場景，局域網秒級下載 |
| C. CDN | `https://mdm.school.edu` | `https://cdn.school.edu` | 大規模，跨地域 |

> ⚠️ `appDownloadBaseUrl` 指向的服務必須能響應 `/api/v1/apps/{id}/download/...` 路徑（部署同一份後端，或用反代映射）。設備 BITS 會發 HEAD + Range GET 請求。

> 🚨 **強烈建議教育場景走 LAN（模型 B）**：BITS 下載 80MB agent MSI 若走慢速公網需 10+ 分鐘，期間 Windows `dmwappushservice`（EDA-CSP callback dispatcher）會被 SCM idle-stop（實測 3-6 min 停一次），BITS 完成通知丟失 → EDA-CSP job 卡在 `Status=20` 派發廢。LAN 下同樣 80MB 通常秒級，撞不上 SCM 停 dmwapp 的窗口。詳見 [troubleshooting.md § EDA-CSP MSI 派發類](troubleshooting.md#eda-csp-msi-派發類agent-升級--首次-enroll-install-agent)。Agent 側 keepalive（v1.4.0.20+）+ PPKG scheduled task 是防禦性兜底，不是可靠的一線方案。

---

## 6. 版本升級

Agent 升級透過 MDM 重新觸發 `install-agent`（上傳新版 MSI → 對設備下發）。MSI 的 WiX MajorUpgrade 配置會自動卸舊裝新，服務自動重啟。

升級建議走灰度，詳見 [agent-upgrade-rollback-strategy.md](agent-upgrade-rollback-strategy.md)，避免壞 build 推到全量設備。
