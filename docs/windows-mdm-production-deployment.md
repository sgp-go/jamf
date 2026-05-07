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
WNS_PACKAGE_SID=ms-app://S-1-15-2-...
WNS_CLIENT_SECRET=...
WNS_PFN=CoGrow.CogrowMDMPush_r2dv7jx02rjxr
WNS_STORE_PRODUCT_ID=9N9MPHFLQNXB

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
