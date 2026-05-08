# Windows MDM 生產部署指南

> 從 ngrok dev 環境遷移到生產環境的完整步驟。

## 架構

```
[Win10 設備]                                  [生產環境]
   ↓ HTTPS                                       │
   └──────────► [Caddy / Nginx 反代] ────────► [Deno 服務 :3000]
                  ↓ TLS 終結                       │
              Let's Encrypt cert              ┌────┴────┐
                                              ↓         ↓
                                         [SQLite]  [.env secrets]
                                          (WAL)     (filesystem perm 600)
```

## 1. 域名與 TLS

### 必需

- **公網固定域名**（如 `mdm.your-domain.com`）
- **公開 CA 簽名 TLS 證書**（Let's Encrypt 即可；自簽不行，Win10 MDM client 拒絕）
- **TCP 443 端口可達**（Win10 device 走 HTTPS）

### 開發 → 生產差異

| 場景 | 開發 | 生產 |
|---|---|---|
| 域名 | ngrok 隨機 URL | 固定域名 |
| TLS | ngrok 自帶 | Caddy/Nginx + Let's Encrypt |
| ngrok URL 變化 | 舊 enrollment 失效 | 域名穩定，enrollment 永久有效 |
| 反代端口 | 3000 直連 | 80→443→3000，反代透明 |

### Caddy 配置範例

```caddyfile
mdm.your-domain.com {
    reverse_proxy localhost:3000 {
        # 重要：保留原始 Host 與協議供後端解析 device URL
        header_up Host {host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}

        # 不要對 SyncML / SOAP body 做任何變換
        # Caddy 默認不壓縮 POST body，安全
    }
}
```

啟動：`caddy run --config /etc/caddy/Caddyfile`，自動申請 + 續期 Let's Encrypt cert。

### Nginx 配置範例

```nginx
server {
    listen 443 ssl http2;
    server_name mdm.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/mdm.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mdm.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        # 阻止反代壓縮/變換 SyncML/SOAP body
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_set_header Accept-Encoding "";
    }
}
```

## 2. Deno 服務部署

### systemd unit

`/etc/systemd/system/jamf-mdm.service`：
```ini
[Unit]
Description=Jamf MDM Backend
After=network.target

[Service]
Type=simple
User=mdm
Group=mdm
WorkingDirectory=/opt/jamf_explore
Environment=DENO_DIR=/opt/jamf_explore/.deno_cache
EnvironmentFile=/opt/jamf_explore/.env
ExecStart=/usr/local/bin/deno run \
    --unstable-http \
    --allow-env --allow-read --allow-write --allow-net --allow-ffi \
    src/server.ts
Restart=on-failure
RestartSec=5s
StandardOutput=append:/var/log/jamf-mdm/server.log
StandardError=append:/var/log/jamf-mdm/server.log

[Install]
WantedBy=multi-user.target
```

啟用：
```bash
sudo systemctl daemon-reload
sudo systemctl enable jamf-mdm
sudo systemctl start jamf-mdm
sudo systemctl status jamf-mdm
```

### 文件權限

```bash
sudo useradd -r -s /bin/false mdm
sudo chown -R mdm:mdm /opt/jamf_explore
sudo chmod 600 /opt/jamf_explore/.env       # secrets 只 owner 可讀
sudo chmod 700 /opt/jamf_explore/data       # SQLite DB 只 owner 可讀寫
sudo chmod 755 /opt/jamf_explore/data/test  # 對外 host 的 .msix 目錄
sudo mkdir -p /var/log/jamf-mdm && sudo chown mdm:mdm /var/log/jamf-mdm
```

## 3. 靜態 MSIX host

當前實作：`GET /test/:filename` 服務 `data/test/` 下的 `.msix` / `.msixbundle` 等。

### 生產替代方案（推薦）

**單獨 CDN / 對象存儲** 比 Deno 服務內 host 更穩：
- AWS S3 + CloudFront / Cloudflare R2 / Bunny CDN
- 上傳 `.msix` → 拿到 HTTPS URL → 作為 `contentUri` 傳給 `/apps/install`
- device 從 CDN 拉，server 不承擔流量

**本機 host 方案**：保留現有 `/test/` 路由，但加 IP allowlist 或 token 驗證避免任意人下載 MSIX。

### MSIX 簽名

詳見 [windows-mdm-msix-signing.md](./windows-mdm-msix-signing.md)。生產建議：
- LOB MSIX 用 Microsoft Store Partner Center 提供的 Trusted Publisher cert 簽名（合法 sideload）
- 客戶 Win10 預先導入根證書到 LocalMachine\TrustedRoot

## 4. .env 與 secret 管理

### `.env` 必填欄位

```bash
# WNS（A 路徑必需；B 路徑不需）
# 接手團隊請依 [account-setup.md](./windows-mdm-account-setup.md) 註冊自家應用後填入
WNS_PACKAGE_SID=ms-app://<your-package-sid>
WNS_CLIENT_SECRET=<your-client-secret>
WNS_PFN=<your-pfn>
WNS_STORE_PRODUCT_ID=<your-store-product-id>

# 其他（保留欄位，當前 stub）
JAMF_CLIENT_ID=...
JAMF_CLIENT_SECRET=...
```

### 輪替 SOP

**WNS_CLIENT_SECRET 一年到期**（Microsoft Azure 默認），到期前必須輪替：

1. 登入 [Azure Portal](https://portal.azure.com) → App registrations → 找到 MDM 應用
2. Certificates & secrets → New client secret → 描述 + 過期時間（24 個月最大）
3. **新 secret 只看一次**，立即複製
4. 更新生產 `.env`：`WNS_CLIENT_SECRET=<new>`
5. `sudo systemctl restart jamf-mdm`
6. 觀察 log：第一次 enqueue 命令時應看到 `WNS push 已發 (received)`，無 `WnsAuthError`

新舊 secret 並存期：Azure 允許多個 active secret，舊的可在驗證新的 work 後再刪。

### 變更前驗證

```bash
# 改 .env 前先測新 secret 能否拿 token
curl -X POST https://login.live.com/accesstoken.srf \
  -d "grant_type=client_credentials" \
  -d "client_id=$WNS_PACKAGE_SID" \
  -d "client_secret=$NEW_SECRET" \
  -d "scope=notify.windows.com"
# 預期回 {"access_token":"...","token_type":"bearer"}
```

詳見 [windows-mdm-account-setup.md](./windows-mdm-account-setup.md) 第 4 步。

## 5. 數據庫備份

當前用 SQLite WAL（`data/agent_reports.db`）。

### 備份策略

```bash
# crontab 每日 02:00 備份
0 2 * * * sqlite3 /opt/jamf_explore/data/agent_reports.db ".backup /var/backups/jamf-mdm/$(date +\%Y\%m\%d).db"

# 保留 30 天
0 3 * * * find /var/backups/jamf-mdm -name "*.db" -mtime +30 -delete
```

### 生產規模考量

SQLite 在單機 1000 台設備內毫無壓力。超過萬台需考慮：
- 切到 PostgreSQL（schema 簡單，遷移成本低）
- 多實例水平擴展（前置 LB + 共享 DB + Redis lock for `mdm_devices.management_session_state`）

## 6. 監控

### 關鍵指標

| 指標 | 工具 | 異常含義 |
|---|---|---|
| Discovery / Policy / Enrollment 失敗率 | log grep + Prometheus | enrollment 鏈路出問題 |
| `/api/mdm/win/manage/*` QPS | nginx access log | device 異常 polling 頻率（過高=配錯了） |
| `mdm_commands.status='sent'` 持續超 30 min 無 ACK | DB 定時 query | device 大量離線或 push 鏈路斷 |
| WNS push 失敗率 | server log grep `WNS push 觸發失敗` | WNS 凭据問題或 channel expired |
| SQLite DB 大小增長 | du 監控 | inventory / 命令歷史膨脹 |

### Log 範例 grep 模式

```bash
# enrollment 失敗
grep -E "Enrollment.*[45]\d\d|enrollment failed" /var/log/jamf-mdm/server.log

# 命令長時間未 ACK（5 分鐘以上 status=sent 仍無 responded_at）
sqlite3 data/agent_reports.db "
  SELECT command_uuid, command_type, datetime(sent_at)
  FROM mdm_commands
  WHERE status='sent'
    AND responded_at IS NULL
    AND sent_at < datetime('now', '-5 minutes')
"

# WNS push 失敗
grep -E "WNS push 觸發失敗|channel expired|WnsAuthError" /var/log/jamf-mdm/server.log
```

### 告警建議

接入 Prometheus / Datadog / 自建告警：
- `mdm_commands` 中 status=sent 超 30 min 數量 > 10 → device 集體離線或 polling 配錯
- WNS push 連續 5 分鐘 401 → 凭据過期需輪替
- enrollment 連續 10 次失敗 → 反代 / TLS / Discovery 鏈路出問題

## 7. 客戶端證書信任預配

### 場景

LOB MSIX 用自簽 cert 簽名時，客戶 Win10 必須預先信任該 cert 鏈才能 sideload。

### 方法 A：Provisioning Package (.ppkg) 帶根證書

`src/mdm/windows/provisioning.ts` 生成的 `.ppkg` 已嵌入 server CA 根證書。enrollment 時 device 會自動裝到 LocalMachine\TrustedRoot。**MSIX 簽名 cert 同根的話**自然信任。

### 方法 B：手動分發根證書 + GPO

對非 enrolled 設備（首次 enrollment 前）：
- 將根證書 `.cer` 通過 GPO / SCCM / 手動 → LocalMachine\TrustedRoot + LocalMachine\TrustedPeople
- 之後該根簽的 MSIX 可正常 sideload

### 方法 C：Microsoft Store Partner Trusted Publisher Cert

正式產品建議：透過 Partner Center 申請 **Trusted Publisher** cert（Microsoft 簽發），客戶 Win10 已預信任。詳見 [windows-mdm-msix-signing.md](./windows-mdm-msix-signing.md)。

## 8. 容量與性能

### 單機可承載

- **enrolled devices**：1 萬台內無壓力（SQLite WAL + Deno 單核）
- **QPS**：polling 5 min 間隔下，1 萬台分散後 ~33 QPS，輕鬆
- **同時命令派送**：bulk API 無限制，但 SyncML response 含 ≤5 條命令，多餘命令需多輪 poll 拉走

### 擴展點

當設備規模 > 萬台或業務需 < 1 秒響應：
- DB 切 PostgreSQL（多寫競爭時 SQLite WAL 會成為瓶頸）
- WNS push 並發發送（當前實現 fire-and-forget 已是並發）
- 多 server 實例 + LB（注意 SQLite 不支持多進程寫，必須切 PG）

## 9. 升級流程

```bash
# 1. 備份
sudo systemctl stop jamf-mdm
sudo cp -a /opt/jamf_explore/data /var/backups/jamf-mdm/data-$(date +%Y%m%d-%H%M%S)

# 2. 拉新版
cd /opt/jamf_explore
sudo -u mdm git pull
sudo -u mdm deno cache src/server.ts

# 3. 跑測試確認新版本不破壞
sudo -u mdm deno test --allow-read --allow-write --allow-env --allow-ffi src/

# 4. DB schema migration 自動跑（idempotent ALTER TABLE）
# 不需手動 migrate

# 5. 起服
sudo systemctl start jamf-mdm
sudo systemctl status jamf-mdm

# 6. 觀察 5 分鐘 log
sudo journalctl -u jamf-mdm -f
```

## 10. 回滾

```bash
sudo systemctl stop jamf-mdm
cd /opt/jamf_explore && sudo -u mdm git checkout <previous-commit>
sudo cp -a /var/backups/jamf-mdm/data-<latest>/ data/  # 如果新版做了破壞性 schema 變更
sudo systemctl start jamf-mdm
```

> 本實作所有 ALTER TABLE 都是 ADD COLUMN（idempotent + 向後兼容），回滾不需要 schema 反向 migration。但業務上 `mdm_commands` 表新行（如新 commandType）在舊版可能無法處理，注意觀察錯誤。

## 11. 常見部署陷阱

| 陷阱 | 表現 | 對策 |
|---|---|---|
| 反代壓縮了 SyncML body | device 拒絕響應，回 `Cmd=SyncHdr Data=500` | nginx `proxy_set_header Accept-Encoding ""` 或 ngrok `--request-header-remove="Accept-Encoding"` |
| 反代沒傳 X-Forwarded-Proto | server 生成的 manage URL 是 http://（device 期 https） | 反代必須傳 X-Forwarded-Proto + X-Forwarded-Host |
| `.env` 沒對 systemd 生效 | 服務啟動但 WnsAuthError | `EnvironmentFile=` 必須指對；確認 systemctl show jamf-mdm \| grep Env |
| 跑了 `--no-check` 跳過 type check | 部分代碼 bug 直到 runtime 才發現 | 不要跳。`deno test` 會自動 type check |
| Deno 版本太舊 | `--unstable-http` 無效 | 升級 Deno ≥ 1.40 |

---

## 12. 設備端生產化（demo 簡化路徑 → 生產嚴格路徑）

> 1-11 節是**服務端**生產 SOP，已對齊現有實作。本節列**設備端**從 demo → 生產要做的改造。多數需要新增代碼或補腳本（見 [§13 待實現項](#13-待實現項清單)）。

### 12.1 自動納管（取代 demo 的 GUI 手動 enrollment）

**Demo 路徑**：操作員打開「設定 → 帳戶 → 存取公司或學校資源」手動填 enrollment URL。

**生產路徑**：使用 **Provisioning Package (.ppkg)** 在 OOBE 階段自動 enroll。三種部署方式：

| 方式 | 自動化程度 | 適用場景 |
|---|---|---|
| **A. USB 自動檢測** | 90%（OOBE 期插 USB 後彈窗確認） | 中小批量交付、教室機房 |
| **B. 嵌入 OS 鏡像** | **100%**（DISM 把 .ppkg 注入 install.wim） | 大批量 OEM 交付，等同 iPad ADE |
| **C. OOBE 期 Shift+F10 + Install-ProvisioningPackage** | 50%（需現場操作） | 單台維修 / 補裝 |

> 不同於 Apple ADE 的「Apple 雲端 + 硬件序號白名單」雙重鎖，Win 沒有真正等價的「重置也保留管控」機制。**Microsoft Autopilot** 是最接近的方案，但強制依賴 Azure AD（Entra ID）+ Microsoft 雲，自建 MDM 走不通這條。
>
> 自建 MDM 想接近 ADE 的「不可逃」效果，必須組合：.ppkg 自動 enroll **+** 12.2 防 unenroll **+** 12.3 BitLocker/Secure Boot 等。

詳細 .ppkg 內容結構與生產製作流程：[windows-mdm-bulk-enrollment.md](./windows-mdm-bulk-enrollment.md)（待補，見 §13）。

### 12.2 防止用戶主動解除管控

**Demo 路徑**：用戶可從「設定 → 存取公司或學校資源 → MDM 條目 → 中斷連線」自行 unenroll，**不受任何限制**。

**生產路徑**：套用 CSP `AllowManualMDMUnenrollment = 0` 後該按鈕被禁用：

```
路徑：./Device/Vendor/MSFT/Policy/Config/Experience/AllowManualMDMUnenrollment
值：  0 = 禁止用戶手動 unenroll（生產推薦）
      1 = 允許（默認，demo 環境）
```

注入時機（兩個都要做）：

1. **enrollment ppkg 內預配**（一上線立即生效）：改 `src/mdm/windows/provisioning.ts`，wap-provisioningdoc 加 `Policy/Experience/AllowManualMDMUnenrollment=0`
2. **存量設備運行時補打**：新增 API `POST /api/mdm/win/devices/:udid/lock-mdm`，enqueue OMA-DM Replace 命令到 device queue

防 unenroll 套件**不只**這一條 policy，建議組合：

| Policy CSP 路徑 | 推薦值 | 效果 |
|---|---|---|
| `Experience/AllowManualMDMUnenrollment` | `0` | 禁 GUI 移除 MDM |
| `Settings/PageVisibilityList` | `hide:workplace;...` | 直接隱藏「存取公司或學校資源」頁 |
| `Update/SetEDURestart` | （restart 策略） | 強制更新後重啟（防用戶拒絕重啟逃避命令） |
| `ApplicationManagement/AllowAllTrustedApps` | `1` | 允許 sideload（配合自簽 MSIX） |
| `LocalUsersAndGroups/Configure` | `removeAdmins` XML | 禁普通用戶獲得 admin（防注冊表強移） |

完整 Policy CSP 列表參考 [MS 官方文檔](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csps)。

### 12.3 安全配套（IT 部署層，非 MDM 服務端範圍）

| 措施 | 防什麼 | 由誰落實 |
|---|---|---|
| **BitLocker + TPM 強制加密** | 防外接 USB 啟動 / 拆硬碟讀數據 | IT 通過 GPO 或 Intune（或我們這邊用 BitLocker CSP） |
| **Secure Boot + 禁用 USB Boot** | 防換 OS 鏡像繞過 MDM | BIOS 設定，IT 部署時鎖 |
| **強密碼 + 移除本地 Admin** | 防 admin 強刪 enrollment 注冊表 | 通過 LocalUsersAndGroups CSP |
| **企業郵箱 + Conditional Access** | 重置 OS 後仍無法登入企業資源 | Azure AD / 企業 IdP 設定 |
| **裝置序號白名單** | 重新 enroll 時校驗合法序號 | 服務端額外實現（自家做） |

### 12.4 證書信任路徑升級（dev → 生產）

見 [§7 客戶端證書信任預配](#7-客戶端證書信任預配) 三條路徑（內部 CA / EV Code Signing / Microsoft Trusted Publisher）+ [windows-mdm-msix-signing.md](./windows-mdm-msix-signing.md)。

關鍵升級動作：
- **MSIX 改用 server CA 子簽**（不再用 Aspira-MDM-Test 自簽 publisher）→ enrollment ppkg 推 server CA root 後 device **自動信任**，不需要手動 `Import-Certificate`
- 對應改動：`docs/scripts/build-msix.ps1` 第 30-58 行的 cert 邏輯重寫，引入 server CA 私鑰簽 child cert

---

## 13. 待實現項清單

> 從 demo 走向生產還缺的具體工作項。按優先級排序。

### P0 — 演示後立刻做（本月）

| # | 項目 | 工作量 | 影響 |
|---|---|---|---|
| 1 | **`AllowManualMDMUnenrollment=0` 寫進 ppkg** | 0.5 天 | 改 `provisioning.ts` ~10 行，新 enroll device 自動防解除 |
| 2 | **新增 `POST /lock-mdm` API**（給存量 device 補打 policy） | 1 天 | 新 route + csp builder + 測試 |
| 3 | **`AllowAllTrustedApps + AllowDeveloperUnlock` 寫進 ppkg** | 0.5 天 | 取消 quick-start 3.1 的 `AppModelUnlock` reg key 手工步驟 |

### P1 — 接入第一批客戶前（1-2 月）

| # | 項目 | 工作量 | 影響 |
|---|---|---|---|
| 4 | **新增 OOBE 用 `.ppkg` 生成 API**（`GET /api/mdm/win/bulk-enroll-ppkg`） | 3-5 天 | 含 .ppkg ZIP 容器構造 + signtool 簽名 + WiFi 配置 |
| 5 | **MSIX 改用 server CA 子簽** | 2-3 天 | 改 `build-msix.ps1` + 重 build 4 個 demo MSIX 覆蓋 git；接手者裝 cert 步驟消失 |
| 6 | **客戶 cert 信任預配文檔**：`windows-mdm-bulk-enrollment.md` | 1-2 天 | 教 IT 怎麼 DISM 注入 ppkg 到 install.wim |
| 7 | **ARM64 demo MSIX**（給 Win11 ARM 客戶） | 1 天 | 在 Win11 ARM VM 上跑 build-msix-arm64.ps1（待寫） |

### P2 — 規模化前（3-6 月）

| # | 項目 | 工作量 | 影響 |
|---|---|---|---|
| 8 | **裝置序號白名單機制** | 5-7 天 | enrollment 時校驗 hwId 在白名單；類似 Apple ADE 的雲端鎖 |
| 9 | **BitLocker CSP 整合**（自動加密硬碟） | 3-5 天 | 通過 OMA-DM 推 BitLocker 配置，不依賴 IT GPO |
| 10 | **DB 切 PostgreSQL**（萬台規模） | 7-10 天 | SQLite WAL 在多寫場景成為瓶頸 |
| 11 | **多 server 實例 + LB** | 5-7 天 | 配合 #10，去掉 SQLite 單進程寫限制 |
| 12 | **Web 管理 UI**（取代 curl） | 10-15 天 | 給客戶 IT 用，不用記 API |

### P3 — 對標商業 MDM（長期）

| # | 項目 | 工作量 |
|---|---|---|
| 13 | EV Code Signing cert 接入（YubiKey / Cloud HSM） | 3-5 天 |
| 14 | Microsoft Partner Center Trusted Publisher 申請流程文檔 | 1-2 天 |
| 15 | 跨平台統一 dashboard（Windows + Apple + 未來 Android） | 30+ 天 |
| 16 | 設備地理位置 / 詳細 inventory（CPU/RAM/SN/MAC） | 5-10 天 |
| 17 | 應用商店式自助安裝介面（Company Portal 對標） | 15-20 天 |

### 演示後與接手團隊對齊的優先級

**Demo 階段（現在）**：什麼都不必補，演示能跑。
**接手第 1 週**：做 P0 三項（共 2 天工作量，立刻顯著改善「demo → 可給客戶看」體驗）。
**接手第 1 月**：做 P1 四項（共 7-11 天工作量，達到「真客戶第一批裝置可上線」）。
**接手第 2-6 月**：根據客戶數量與規模選做 P2、P3。
