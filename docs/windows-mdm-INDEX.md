# Windows MDM 文件總目錄

> 自建 Windows MDM 完整文檔索引。建議按角色閱讀順序。

## ⚠️ 已驗證 vs 未驗證範圍

| 項目 | 真機驗證狀態 |
|---|---|
| Win10 22H2 Pro/Enterprise/Education | ✅ 真機（Surface Go 3）端到端驗證 |
| 4 大功能：部署 / 派送（批量）/ 更新 | ✅ 真機驗證（含 inventory 反查） |
| 4 大功能：清除個資（RemoteWipe） | ⏳ 協議層 OK，**未真機驗證**（需要可被 wipe 的虛擬機） |
| polling 自動觸發（5/15 min 雙段）| ✅ 真機驗證 |
| WNS push 秒級觸發 | ✅ 真機驗證（6-9s 延遲） |
| Win11 Pro/Enterprise/Education | ⏳ 協議層完全同源預期可用，**建議首批接入時單獨跑一台 Win11 真機/VM 確認** |
| Win10/11 Home | ❌ 不支援（MDM client 限制） |

> RemoteWipe 與 Win11 的協議邏輯與已驗證部分同源，預期可用。建議台灣團隊首批接入時跑一台 VM 各驗證一次。

## 角色 A：剛接手的工程師

按順序讀：

1. **[windows-mdm-quick-start.md](./windows-mdm-quick-start.md)** — 30 分鐘從 0 跑通 enrollment + install demo MSIX
2. **[windows-mdm-trigger-mechanism.md](./windows-mdm-trigger-mechanism.md)** — 為何排了命令 device 不立刻執行（A push + B polling 雙層機制）
3. **[windows-mdm-api-reference.md](./windows-mdm-api-reference.md)** — 14 個管理 API 完整參考
4. 遇問題 → **[windows-mdm-troubleshooting.md](./windows-mdm-troubleshooting.md)**

## 角色 B：負責部署上線

1. [windows-mdm-quick-start.md](./windows-mdm-quick-start.md) — 開發環境跑通先
2. **[windows-mdm-account-setup.md](./windows-mdm-account-setup.md)** — Microsoft Store + Azure 帳戶 + WNS 凭据配置
3. **[windows-mdm-msix-signing.md](./windows-mdm-msix-signing.md)** — LOB MSIX 簽名 / 客戶 device 信任配置
4. **[windows-mdm-production-deployment.md](./windows-mdm-production-deployment.md)** — HTTPS 反代 + systemd + secret 輪替 + 監控
5. **[windows-mdm-data-model.md](./windows-mdm-data-model.md)** — DB 備份 / 容量規劃

## 角色 C：負責維運（值班排查）

1. **[windows-mdm-troubleshooting.md](./windows-mdm-troubleshooting.md)** — 12 個 bug 案例庫 + 排查神器
2. [windows-mdm-data-model.md](./windows-mdm-data-model.md) — 命令狀態機 / 高頻 SQL
3. [windows-mdm-trigger-mechanism.md](./windows-mdm-trigger-mechanism.md) — 「device 不響應」的雙層機制定位
4. [windows-mdm-account-setup.md](./windows-mdm-account-setup.md) — WNS Secret 輪替

## 角色 D：跟著 Win10 真機實際操作

1. **[windows-mdm-enrollment-guide.md](./windows-mdm-enrollment-guide.md)** — Win10 GUI 操作 + 後端協議要點 10 條
2. **[scripts/README.md](./scripts/README.md)** — Win10 PowerShell 腳本（生成簽名 MSIX、計算 PFN）

## 文件矩陣

| 文件 | 1 句話定位 | 字數 |
|---|---|---|
| [windows-mdm-INDEX.md](./windows-mdm-INDEX.md) | **本目錄** | — |
| [windows-mdm-quick-start.md](./windows-mdm-quick-start.md) | 30 分鐘從 0 到 demo MSIX 裝上 | 短 |
| [windows-mdm-api-reference.md](./windows-mdm-api-reference.md) | 14 個 API 入參/返回/示例 | 中 |
| [windows-mdm-trigger-mechanism.md](./windows-mdm-trigger-mechanism.md) | A WNS push + B polling 雙層觸發 | 中 |
| [windows-mdm-account-setup.md](./windows-mdm-account-setup.md) | Microsoft Partner Center + Azure WNS 凭据 | 中 |
| [windows-mdm-enrollment-guide.md](./windows-mdm-enrollment-guide.md) | Win10 真機 GUI 加入 MDM + MS-MDE2 協議避坑 10 條 | 中 |
| [windows-mdm-msix-signing.md](./windows-mdm-msix-signing.md) | dev 自簽 vs 生產 Trusted Publisher cert | 中 |
| [windows-mdm-production-deployment.md](./windows-mdm-production-deployment.md) | HTTPS 反代 + systemd + secret 輪替 + 監控 | 中 |
| [windows-mdm-troubleshooting.md](./windows-mdm-troubleshooting.md) | 12 個 bug 案例 + 排查神器 | 長 |
| [windows-mdm-data-model.md](./windows-mdm-data-model.md) | DB schema + 命令狀態機 | 中 |
| [scripts/README.md](./scripts/README.md) | PowerShell 腳本說明 | 短 |
| [scripts/*.ps1](./scripts/) | 5 個 Win10 真機腳本（MSIX/cert 生成） | — |

## 關鍵能力速查

| 業務需求 | 對應 API | 文檔章節 |
|---|---|---|
| 部署軟體（首次安裝） | `POST /apps/install` | [api-reference#部署](./windows-mdm-api-reference.md#post-appsinstall--部署派送-msix) |
| 派送軟體（批量到多台） | `POST /devices/install/bulk` | [api-reference#批量派送](./windows-mdm-api-reference.md#post-devicesinstallbulk--批量派送4-大功能-2) |
| 更新軟體（覆蓋升級） | `POST /apps/update` | [api-reference#升級](./windows-mdm-api-reference.md#post-appsupdate--升級-msix) |
| 清除個資（遠程清除） | `POST /wipe` | [api-reference#wipe](./windows-mdm-api-reference.md#post-wipe--remotewipe) |
| 設備自動 5 分鐘 poll | `POST /poll-config` | [trigger-mechanism#B](./windows-mdm-trigger-mechanism.md#b-路徑polling-詳解) |
| 命令秒級觸發 | `POST /push-config` 配 + 自動 push | [trigger-mechanism#A](./windows-mdm-trigger-mechanism.md#a-路徑wns-push-詳解) |
| 查設備裝了哪些應用 | `POST /apps/refresh` + `GET /apps` | [api-reference#refresh](./windows-mdm-api-reference.md#post-appsrefresh--重新拉應用清單) |

## 跨 Apple / Windows 共通

本案 server 同時支援 Apple MDM 與 Windows MDM，部分組件共用：

| 表 | 用途 | 區分 |
|---|---|---|
| `mdm_devices` | 設備註冊狀態 | `platform` 欄位（apple/windows） |
| `mdm_commands` | 命令隊列 | `platform` 欄位 |
| `mdm_certificates` | 簽發證書 | 共用 |

Apple 部分文檔見 `self-hosted-mdm-guide.md`、`jamf-api-integration.md`。

## 維護者

接手時請：
1. 讀完本目錄所有文檔（按角色順序）
2. 跑通 `windows-mdm-quick-start.md` 的 30 分鐘流程
3. 跑全測試 `deno test src/`（72 個應全過）
4. 看 `git log --oneline | head -30` 了解最近修改
