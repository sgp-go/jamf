# Windows 部署交付文件（正式生產）

> ⚠️ 本目錄為**正式生產交付**文件，區別於 `docs/` 下的 demo / 探索 / 調試文件。
> 規則由我方制定，供台灣團隊轉交學校 IT 執行。

## 文件清單

| 文件 | 說明 |
|---|---|
| [device-provisioning-guide.md](device-provisioning-guide.md) | 設備初始化配置指南：PPKG 生成 → OOBE 套用 → 驗證納管 → 帳戶與密碼策略 → 故障排除 |
| [agent-app-build-and-deploy.md](agent-app-build-and-deploy.md) | Agent App 構建與部署：MSI 構建 → 上傳 → EDA-CSP 自動下發 → 文件下載 URL 配置（publicBaseUrl / appDownloadBaseUrl） |
| [laps-password-management.md](laps-password-management.md) | LAPS 密碼託管：自動改密流程 → IT 查詢密碼 → 手動輪換 → 安全須知 |
| [device-lifecycle.md](device-lifecycle.md) | 設備生命週期：納管自動鏈路（全 10+ 步） → 移除納管（10 步清理） → 遠端鎖屏 / 抹機 / 重啟 |

## 適用對象

台灣團隊（規劃 / 對接）→ 學校 IT 團隊（執行）。

## 環境前提（一次性）

- MDM 後端部署完成 + 公網 HTTPS（有效 CA，Windows 拒絕自簽 TLS）
- 一台 Windows 工具機（構建 Agent MSI + 用 ICD 編譯 `.ppkg`）
- Push 推送整套自建（Microsoft Store 註冊 → WNS 憑據 → push MSIX → cert）
- PostgreSQL 資料庫
- `.env` 環境配置（含 `DATA_ENCRYPTION_KEY`、WNS 憑據等）

## 核心原則速記

1. **學生用標準帳號** — 防脫離的根；管理員權限可繞過一切 MDM 策略
2. **PPKG 永遠統一**（一個檔刷所有機器）；密碼差異化交給 LAPS 自動處理
3. **Agent MSI 全租戶通用** — 設備配置（token / endpoint）在安裝時動態注入，不需每租戶單獨構建
4. **文件下載可走局域網** — 設定 `appDownloadBaseUrl` 讓 76MB MSI 走校內 LAN，不壓公網
5. 無 Autopilot，批量配置須人工插 USB 套 PPKG（非零接觸）

## 閱讀順序

首次部署：① provisioning-guide → ② agent-app-build → ③ laps-password → ④ device-lifecycle

日常運維：直接查 ④ device-lifecycle + ③ laps-password
