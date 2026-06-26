# Windows 部署交付文件（正式生產）

> ⚠️ 本目錄為**正式生產交付**文件，區別於 `docs/archived/` 下的 demo / 探索 / 調試文件。
> 規則由我方制定，供台灣團隊轉交學校 IT 執行。

## 文件清單

### A. 基礎設施部署（台灣團隊，一次性）

| 文件 | 說明 |
|---|---|
| [../backend-deployment.md](../backend-deployment.md) | 後端服務生產部署（**跨平台，已移至 `docs/` 頂層**）：Deno 服務常駐（systemd/docker）→ PostgreSQL + migration → 反向代理公網 HTTPS → 完整 env 清單 → 本地/生產區分 → 可選雙服務部署 |
| [build-machine-setup.md](build-machine-setup.md) | 構建機環境：一台 Windows 機承擔三類構建（Agent MSI / push MSIX / `.ppkg`）的工具鏈準備 + 規避大檔下載策略 |
| [push-infrastructure-setup.md](push-infrastructure-setup.md) | Push 推送自建 playbook：Microsoft Store 註冊 → WNS 憑據 → build push MSIX → cert 生成 → 寫 env 驗證（全域一套，秒級推送的硬前提） |

### B. 設備配置與運維（台灣團隊 + 學校 IT）

| 文件 | 說明 |
|---|---|
| [device-provisioning-guide.md](device-provisioning-guide.md) | 設備初始化配置指南：新租戶初始化 → PPKG 生成 → OOBE 套用 → 驗證納管 → 帳戶與密碼策略 → 故障排除 |
| [agent-app-build-and-deploy.md](agent-app-build-and-deploy.md) | Agent App 構建與部署：MSI 構建 → 上傳 → EDA-CSP 自動下發 → 文件下載 URL 配置（publicBaseUrl / appDownloadBaseUrl） |
| [laps-password-management.md](laps-password-management.md) | LAPS 密碼託管：自動改密流程 → IT 查詢密碼 → 手動輪換 → 安全須知 |
| [bitlocker-management.md](bitlocker-management.md) | BitLocker 磁碟加密：ADMX 信箱靜默加密 → Recovery Key 捕獲 → 加密狀態查詢 → 故障排除 |
| [agent-upgrade-rollback-strategy.md](agent-upgrade-rollback-strategy.md) | Agent 升級與回滾：灰度分階段推送 → 健康驗證指標 → 回滾操作 → 自我保護注意事項 |
| [device-lifecycle.md](device-lifecycle.md) | 設備生命週期：納管自動鏈路（全 10+ 步） → 移除納管（10 步清理） → 遠端鎖屏 / 抹機 / 重啟 |
| [demo-walkthrough.md](demo-walkthrough.md) | **端到端 demo 演示腳本**（10-15 分鐘走完）：enroll → agent 自動裝 → LOCK/UNLOCK → 任意 MSI install/uninstall → REBOOT；含演示前 checklist + 常見問題排查 |

### C. 技術參考（排錯 / 原理，自探索期遷入）

| 文件 | 說明 |
|---|---|
| [wns-account-setup.md](wns-account-setup.md) | WNS 帳戶註冊與憑據取得完整步驟（push 自建 Step 1 細節展開，含踩坑） |
| [msix-signing.md](msix-signing.md) | MSIX 簽名與證書信任：dev 自簽 / push MSIX Identity 約束 / 生產 Trusted Publisher cert / cert 到期管理 |
| [trigger-mechanism.md](trigger-mechanism.md) | A+B 雙層觸發機制：WNS push + polling 協作原理（理解命令何時秒級 / 何時分鐘級） |
| [troubleshooting.md](troubleshooting.md) | 故障排除手冊：錯誤碼 / OMA-DM / MSIX / WNS / enrollment 各類症狀排查 + 排查工具 |

> C 組為多租戶重構前撰寫、核心機制仍適用的參考文件；各文頂部已標註與生產文檔的時效差異。

## 適用對象

台灣團隊（規劃 / 對接 / 後端運維）→ 學校 IT 團隊（設備執行）。

## 環境前提（一次性）

| 前提 | 對應文檔 |
|------|---------|
| MDM 後端部署 + 公網 HTTPS（有效 CA，Windows 拒絕自簽 TLS）+ PostgreSQL + `.env` | [../backend-deployment.md](../backend-deployment.md) |
| 一台 Windows 構建機（Agent MSI + push MSIX + ICD 編譯 `.ppkg`） | [build-machine-setup.md](build-machine-setup.md) |
| Push 推送整套自建（Store 註冊 → WNS 憑據 → push MSIX → cert） | [push-infrastructure-setup.md](push-infrastructure-setup.md) |

## 核心原則速記

1. **學生用標準帳號** — 防脫離的根；管理員權限可繞過一切 MDM 策略
2. **PPKG 永遠統一**（一個檔刷所有機器）；密碼差異化交給 LAPS 自動處理
3. **Agent MSI 全租戶通用** — 設備配置（token / endpoint）在安裝時動態注入，不需每租戶單獨構建
4. **Push 基礎設施全域一套** — push MSIX / WNS 憑據 / cert 帳號級共用，所有租戶共享，非每校一套
5. **文件下載可走局域網** — 設定 `appDownloadBaseUrl` 讓 76MB MSI 走校內 LAN，不壓公網
6. **環境靠 `DATABASE_URL` + 每租戶 `publicBaseUrl` 區分** — 非改代碼；ngrok→生產換反代 HTTPS，設備須用生產 PPKG 重新註冊
7. 無 Autopilot，批量配置須人工插 USB 套 PPKG（非零接觸）

## 閱讀順序

**首次部署（基礎設施，台灣團隊）**：
① backend-deployment → ② build-machine-setup → ③ push-infrastructure-setup

**接著設備配置**：
④ device-provisioning-guide → ⑤ agent-app-build-and-deploy → ⑥ laps-password-management → ⑦ bitlocker-management → ⑧ device-lifecycle

**日常運維**：直接查 ⑧ device-lifecycle + ⑥ laps-password-management + ⑦ bitlocker-management

**升級維護**：⑨ agent-upgrade-rollback-strategy
