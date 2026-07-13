# 業務流程文檔

> 供台灣團隊理解各功能的實現方式。每份文檔包含 Mermaid 序列圖，標示服務端、設備端、Agent App 之間的通訊流程與關鍵 API / CSP 路徑。

## 文檔清單

### A. 設備部署與納管

| 文件 | 說明 |
|------|------|
| [01-device-enrollment.md](01-device-enrollment.md) | 設備納管（MS-MDE2 三階段握手 → 防脫離 → Push 配置 → Agent 自動安裝） |
| [02-ppkg-zero-touch.md](02-ppkg-zero-touch.md) | PPKG 批次部署（API 生成 → USB 佈建 → OOBE 自動註冊 → 歸組） |
| [10-device-transfer.md](10-device-transfer.md) | 設備轉校（標記新群組 → 保留預配 Wipe → 自動重新 Enrollment → 權限即時切換） |
| [16-device-retire.md](16-device-retire.md) | 設備退役（全量 doWipe 連 PPKG 抹除 → 標記 unenrolled，設備不再自動回管） |

### B. 遠端裝置控制

| 文件 | 說明 |
|------|------|
| [05-remote-lock-wipe-reboot.md](05-remote-lock-wipe-reboot.md) | 遠端鎖定 / 清除 / 重啟（三條獨立流程，含 ADMX 信箱 + Agent 配合） |
| [20-lost-mode.md](20-lost-mode.md) | 遺失模式（push/remove-lost-mode admin 端點 + LegalNotice 登入屏顯示 + GpsCollector 切 30s + LetAppsAccessLocation 配套策略） |
| [08-laps-password.md](08-laps-password.md) | LAPS 密碼託管（自動改密 → 密碼查詢 → 手動輪換） |
| [09-bitlocker.md](09-bitlocker.md) | BitLocker 磁碟加密（靜默加密 → Recovery Key 捕獲 → 狀態查詢） |

### C. 策略與配置

| 文件 | 說明 |
|------|------|
| [06-configuration-profile.md](06-configuration-profile.md) | 配置描述檔（CRUD → assign → push → ack → 版本管理 → 變更自動重推） |
| [07-device-policies.md](07-device-policies.md) | 設備策略推送（WiFi / VPN / 桌布 / 密碼 / USB / Camera / 防火牆 / 自動命名 / Settings 限制 / AppLocker，直推模式） |
| [14-os-update.md](14-os-update.md) | OS 更新管理（排程 / 延後 / 暫停 / 強制更新策略） |
| [13-defender-enforce.md](13-defender-enforce.md) | Windows Defender 強制啟用（全開 / 自訂防護項） |
| [18-compliance-batch-history.md](18-compliance-batch-history.md) | 合規政策批量評估與歷史（CRUD → batch evaluate → 不合規清單 → 設備歷史趨勢） |

### D. App 管理

| 文件 | 說明 |
|------|------|
| [03-app-deployment.md](03-app-deployment.md) | App 派發與管理（上傳 → assign → MSI/MSIX 安裝 → 狀態追蹤 → 卸載） |
| [04-agent-install-and-reporting.md](04-agent-install-and-reporting.md) | Agent App 安裝與數據上報（自動安裝 → 錯峰上報 → 灰度升級） |
| [23-intune-coexistence-agent-enroll.md](23-intune-coexistence-agent-enroll.md) | **Intune 共存 — Agent 自助註冊（遙測 only）**（Intune 派發只帶共享密鑰的 MSI → Agent 首啟自助換 per-device token → 僅遙測，管理面仍歸 Intune） |
| [19-agent-gps-reporting.md](19-agent-gps-reporting.md) | Agent GPS 位置上報（每日 Inventory + Lost Mode 高頻；最新一筆無歷史） |
| [21-installed-apps-inventory.md](21-installed-apps-inventory.md) | App 安裝清單 Inventory（Agent 掃 registry 全量上報 → 後台按設備查已裝 MSI/Win32 軟體） |
| [12-app-blocklist.md](12-app-blocklist.md) | App 黑名單（AppLocker Deny 規則，路徑 / 簽名者兩種封鎖） |

### E. 安全性

| 文件 | 說明 |
|------|------|
| [11-website-blocklist.md](11-website-blocklist.md) | 網站黑名單（IE Security Zone → 萬用字元封鎖 → 受限頁面） |
| [22-geofence.md](22-geofence.md) | Geofence 地理圍欄（polygon CRUD → 關聯設備 → GPS point-in-polygon → enter/exit webhook → 可聯動 Lost Mode） |

### F. 平台營運

| 文件 | 說明 |
|------|------|
| [15-webhook-events.md](15-webhook-events.md) | Webhook 事件通知（端點註冊 → HMAC 簽名 → 推送 → 重試 → 死信） |
| [17-inventory-and-app-metadata.md](17-inventory-and-app-metadata.md) | 設備購買 Inventory + App 分類 + App 授權數量管理（PRD §5.3 / §5.7） |

## 閱讀建議

1. **首次對接**：先讀 [01-device-enrollment](01-device-enrollment.md) 理解設備如何進入管理，再讀 [15-webhook-events](15-webhook-events.md) 理解事件如何推送到台灣後端
2. **App 派發**：依序讀 [04-agent-install](04-agent-install-and-reporting.md) → [03-app-deployment](03-app-deployment.md) → [12-app-blocklist](12-app-blocklist.md)
3. **策略推送**：先讀 [06-configuration-profile](06-configuration-profile.md) 理解 Profile 模式，再讀 [07-device-policies](07-device-policies.md) 理解直推模式的差異

## 序列圖渲染

文檔中的 Mermaid 序列圖可透過以下方式查看：
- **VS Code**：`Cmd+Shift+V` 開啟 Markdown 預覽（需安裝 [Markdown Preview Mermaid Support](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid)）
- **GitHub**：直接支援 `.md` 中的 Mermaid 語法
- **線上**：貼入 [mermaid.live](https://mermaid.live)
