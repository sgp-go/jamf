# 後端服務生產部署指南

> **適用對象**：台灣團隊後端 / 運維工程師。
> **目的**：把 MDM 後端從零部署到生產環境（裸機 / VM / 容器皆可），取代開發期的 ngrok + 本機 Postgres。
> **前提知識**：本後端是 **Deno** 服務（非 Node；歷史上切過 Node 又回切 Deno），單一 Postgres 為唯一資料來源，多租戶。

---

## 0. 部署全景（先讀）

```
                    公網 HTTPS（有效 CA 憑證）
                            │
                  ┌─────────▼──────────┐
                  │  反向代理            │  ← TLS 終結（Caddy / Nginx / 雲 LB）
                  │  (Caddy/Nginx)      │     Windows 拒絕自簽 / 無效 TLS
                  └─────────┬──────────┘
                            │ HTTP 反代到 localhost
                  ┌─────────▼──────────┐
                  │  Deno 服務           │  ← deno task start，常駐（systemd / docker）
                  │  app/server.ts :3000│
                  └─────────┬──────────┘
                            │
                  ┌─────────▼──────────┐
                  │  PostgreSQL          │  ← 唯一資料來源；機密以 AES-256-GCM 加密落 DB
                  └─────────────────────┘
```

**三件套缺一不可**：① 公網 HTTPS（反代）② 常駐 Deno 服務 ③ Postgres。ngrok 在開發期同時扮演「公網入口 + TLS 終結」，生產用反向代理取代。

---

## 1. 系統依賴

| 依賴 | 版本 | 安裝 |
|------|------|------|
| Deno | 2.x | `curl -fsSL https://deno.land/install.sh \| sh`（或包管理器） |
| PostgreSQL | 14+ | 系統包 / Docker / 雲託管（RDS、Cloud SQL 等） |
| 反向代理 | Caddy 2 或 Nginx | Caddy 自動申請 Let's Encrypt，最省事 |

> 不需要 Node / pnpm。`deno task` 直接拉 npm 依賴（`npm:drizzle-kit` 等），Deno 2.x 原生支援。

---

## 2. 環境變數完整清單

服務從 `--env-file=.env` 讀取。以下是**代碼實證**的全部變數（grep `Deno.env.get` / `process.env`）：

### 2.1 必填

| 變數 | 說明 | 範例 / 生成 |
|------|------|------|
| `DATABASE_URL` | Postgres 連線字串。**這是區分環境的主軸**——換 DB 即換整套環境。 | `postgres://user:pass@db-host:5432/jamf_prod` |
| `ADMIN_API_TOKEN` | Admin API（`/api/v1/admin/*`）的 Bearer token。**未設則 admin 端點全部回 503**（安全預設，不裸奔）。 | `openssl rand -hex 32` |
| `DATA_ENCRYPTION_KEY` | 機密欄位加密金鑰（base64 的 32 bytes）。**生產必填**——未設則機密明文落 DB（啟動 warn）。涵蓋 Jamf secret / DEP token / APNS·CA·Vendor 私鑰 / **LAPS 密碼**。 | `openssl rand -base64 32` |

### 2.2 Push 推送（Windows WNS，配齊才有秒級推送）

| 變數 | 說明 |
|------|------|
| `WNS_PACKAGE_SID` | push MSIX 的 Package SID（`ms-app://S-1-15-2-...`） |
| `WNS_CLIENT_SECRET` | WNS OAuth client secret |
| `WNS_PFN` | push MSIX 的 Package Family Name |
| `WNS_STORE_PRODUCT_ID` | Store 商品 ID（選填） |

> 這 4 個的取得流程見 [push-infrastructure-setup.md](push-infrastructure-setup.md)。**全域一套、所有租戶共用**，非每租戶一套。未配齊時命令仍可透過 polling 下發（分鐘級），不影響基本納管。

### 2.3 選填（有預設值）

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `3000` | 服務監聽埠 |
| `DATABASE_POOL_MAX` | `10` | Postgres 連線池上限。1000+ 台壓測時調高（見壓測方案）。 |
| `APPS_STORAGE_DIR` | `data/apps` | 上傳的 Agent MSI 落地目錄。**生產建議用持久卷絕對路徑**。 |
| `APPS_MAX_FILE_BYTES` | `524288000`（500MB） | MSI 上傳大小上限 |
| `WNS_PUSH_RATE_PER_SEC` | 不限流 | 出站 push 限流。1000 台批量喚醒場景建議設（如 `50`），從源頭避開 WNS per-app 配額。 |
| `WNS_PUSH_BURST` | 不限流 | 限流突發桶大小，搭配上者 |

> `SEED_*`（`SEED_PUBLIC_BASE_URL` / `SEED_JAMF_*`）僅 `deno task db:seed` 建 demo 資料時用，生產不需要。
>
> ⚠️ **`publicBaseUrl` / `appDownloadBaseUrl` 不是環境變數**——它們是 **per-tenant** 存在 `self_mdm_configs` 表，透過 Admin API 配置（見 §6）。env 裡找不到它們是正常的。

### 2.4 生產 .env 範本

```bash
# ---- 必填 ----
DATABASE_URL=postgres://jamf:STRONG_PASS@db-host:5432/jamf_prod
ADMIN_API_TOKEN=<openssl rand -hex 32 的輸出>
DATA_ENCRYPTION_KEY=<openssl rand -base64 32 的輸出>

# ---- Push（配齊 push 基礎設施後填，見 push-infrastructure-setup.md）----
WNS_PACKAGE_SID=ms-app://S-1-15-2-...
WNS_CLIENT_SECRET=...
WNS_PFN=YourPublisher.YourApp_xxxxxxxxxxxxx
WNS_STORE_PRODUCT_ID=

# ---- 選填調優 ----
PORT=3000
DATABASE_POOL_MAX=20
APPS_STORAGE_DIR=/var/lib/cogrow-mdm/apps
# WNS_PUSH_RATE_PER_SEC=50
# WNS_PUSH_BURST=50
```

> `.env` 含機密，權限設 `chmod 600`，**絕不入 git**。

---

## 3. 資料庫初始化

```bash
# 1. 建庫 + 使用者（Postgres 端，一次性）
createdb jamf_prod
# 或在 psql: CREATE DATABASE jamf_prod; CREATE USER jamf WITH PASSWORD '...'; GRANT ALL ...

# 2. 套用 migration（建全部表 + enum）
deno task db:migrate
# migrate.ts 會跑 app/db/migrations/ 下全部 SQL（含 LAPS 表 0005、appDownloadBaseUrl 0006）

# 3.（可選）改了 schema 後重新產生 SQL
deno task db:generate
```

> **不要在生產跑 `db:seed`**——它建的是 demo 租戶。生產租戶用 Admin API 建（見 §6）。
>
> ⚠️ migration 是前滾式：升級後端版本時，先 `git pull` 再 `deno task db:migrate`，再重啟服務。

---

## 4. 服務常駐

### 方案 A：systemd（裸機 / VM 推薦）

`/etc/systemd/system/cogrow-mdm.service`：

```ini
[Unit]
Description=CoGrow MDM Backend (Deno)
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/cogrow-mdm
ExecStart=/usr/local/bin/deno task start
Restart=always
RestartSec=3
User=cogrow
# .env 由 deno task start 的 --env-file 讀取；WorkingDirectory 下要有 .env
# 持久資料目錄（APPS_STORAGE_DIR、data/push-cert.cer）需可寫
ReadWritePaths=/opt/cogrow-mdm/data /var/lib/cogrow-mdm

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cogrow-mdm
sudo journalctl -u cogrow-mdm -f   # 看日誌
```

### 方案 B：Docker

```dockerfile
FROM denoland/deno:2.1.4
WORKDIR /app
COPY . .
RUN deno cache app/server.ts
EXPOSE 3000
CMD ["deno", "task", "start"]
```

```bash
docker build -t cogrow-mdm .
docker run -d --name cogrow-mdm \
  --env-file .env \
  -p 127.0.0.1:3000:3000 \
  -v /var/lib/cogrow-mdm:/app/data \
  --restart unless-stopped \
  cogrow-mdm
```

> Postgres 可用獨立容器或雲託管；`DATABASE_URL` 指過去即可。`-p 127.0.0.1:3000` 只綁本機，由反代對外。

---

## 5. 反向代理 + 公網 HTTPS

Windows 設備在 enrollment 和 SyncML 管理通道上**拒絕自簽 / 無效 TLS**，必須是公網 CA（Let's Encrypt 即可）簽發的有效憑證。

### Caddy（最省事，自動申請 + 續期 Let's Encrypt）

`/etc/caddy/Caddyfile`：

```
mdm.your-domain.edu {
    reverse_proxy 127.0.0.1:3000
}
```

`sudo systemctl reload caddy` 即生效，憑證自動處理。

### Nginx（已有 Nginx 體系時）

```nginx
server {
    listen 443 ssl;
    server_name mdm.your-domain.edu;

    ssl_certificate     /etc/letsencrypt/live/mdm.your-domain.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mdm.your-domain.edu/privkey.pem;

    client_max_body_size 600m;   # Agent MSI 上傳 / 下載走此域名時放寬

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

> ⚠️ **BITS Range 請求**：Agent MSI 透過設備 BITS 以 HEAD + Range GET 下載。若 MSI 走此域名（而非 `appDownloadBaseUrl` 局域網），反代必須透傳 Range（Caddy 預設透傳；Nginx 預設亦支援，勿關 `proxy_buffering` 以外的怪設定）。大規模建議走 `appDownloadBaseUrl` 局域網分流，見 [agent-app-build-and-deploy.md](agent-app-build-and-deploy.md) §5。

---

## 6. 區分「本地測試」與「生產」（核心觀念）

區分環境**不靠改代碼**，靠兩條獨立的軸：

### 軸 1 — `DATABASE_URL`（env 層，決定整套環境）

唯一要切的 env。本地 `.env` 指 docker postgres；生產 `.env` 指生產 PG。DB 一換，下面所有租戶配置隨之而來——這是最乾淨的隔離邊界。

> 強烈建議**生產用獨立 DB**，而非靠租戶軟隔離與測試同庫。

### 軸 2 — 每租戶的 `publicBaseUrl`（DB 層，決定流量去向）

每個租戶在 `self_mdm_configs` 表配自己的 URL，透過 Admin API 寫：

```bash
# 建生產租戶
curl -X POST https://mdm.your-domain.edu/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -d '{"slug":"school-a","displayName":"A 學校"}'

# 配 MDM（publicBaseUrl 必須是公網 CA 簽發的 HTTPS）
curl -X POST https://mdm.your-domain.edu/api/v1/admin/tenants/{tid}/mdm-config \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -d '{"publicBaseUrl":"https://mdm.your-domain.edu"}'
```

| 租戶類型 | publicBaseUrl |
|---|---|
| 本地測試 | `https://xxx.ngrok-free.dev` |
| 生產 | `https://mdm.your-domain.edu`（公網 CA HTTPS） |

完整租戶初始化流程見 [device-provisioning-guide.md](device-provisioning-guide.md) §1.5。

### ⚠️ 最大陷阱：URL 在設備註冊時就燒進設備

`publicBaseUrl` 在 enrollment 當下就燒進了設備的 **OMA-DM management URL 和 PPKG**。已用 ngrok 註冊的測試機，事後 PATCH 配置**不會自動遷移**——它仍 poll 舊 URL，管理通道失聯。

**從 ngrok 切生產的正確動作**：
1. 部署生產後端 + 反代 HTTPS（本文 §1–5）
2. 建生產租戶、配生產 `publicBaseUrl`（§6）
3. 用**生產 PPKG**（生產域名 + 正式 slug）重新註冊設備
4. 開發期的 `demo-v3.ppkg` 是 ngrok 測試包，**不可用於生產**

---

## 7. 部署後驗證

```bash
# 1. 服務活著
curl -s https://mdm.your-domain.edu/openapi.json | head -c 100
# 應回 OpenAPI JSON

# 2. 互動式文件（瀏覽器）
#    https://mdm.your-domain.edu/docs   ← Scalar UI

# 3. Admin 鑑權生效（無 token 應 503/401）
curl -s -o /dev/null -w "%{http_code}" https://mdm.your-domain.edu/api/v1/admin/tenants
# 未帶 token → 503（admin_token_not_configured 表示 env 沒設）或 401

# 4. 帶 token 列租戶
curl -s https://mdm.your-domain.edu/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN_API_TOKEN"

# 5. TLS 有效性（Windows enrollment 的硬前提）
curl -sI https://mdm.your-domain.edu/ | head -1   # 不報憑證錯誤即可
```

---

## 8. 上線檢查清單

- [ ] Postgres 生產實例就緒，`DATABASE_URL` 指向它（與測試庫隔離）
- [ ] `ADMIN_API_TOKEN`、`DATA_ENCRYPTION_KEY` 用 `openssl` 生成的強隨機值
- [ ] `.env` 權限 600、不入 git
- [ ] `deno task db:migrate` 跑過，全部表就緒
- [ ] systemd / docker 設 `Restart=always` / `restart unless-stopped`
- [ ] 反代拿到有效 CA 憑證，`curl -sI` 不報 TLS 錯
- [ ] Push 基礎設施已自建（見 push-infrastructure-setup.md），`data/push-cert.cer` 已放入，WNS env 已填
- [ ] 生產租戶建好、`publicBaseUrl` 指生產域名
- [ ] 設備用生產 PPKG 註冊（非 demo 包）

---

## 9. Admin API HMAC 簽名（防 replay）

後端支援在 Bearer token 基礎上疊加 **HMAC-SHA256 簽名**，防止 token 被截獲後 replay / 篡改 body。

**漸進上線**：不帶簽名 header 時行為不變（僅驗 token），帶了才校驗。台灣團隊可在確認 curl 腳本 / 自動化穩定後再啟用。

### 請求 Header

```
Authorization: Bearer <ADMIN_API_TOKEN>
X-CoGrow-Timestamp: <Unix 秒>
X-CoGrow-Signature: sha256=<hex>
```

### 簽名算法

```
body_hash = SHA-256(request_body)       # GET 無 body 時用空字串
message   = "{timestamp}.{METHOD}.{path}.{body_hash}"
signature = "sha256=" + HMAC-SHA256(ADMIN_API_TOKEN, message)
```

### Bash 範例

```bash
TOKEN="$ADMIN_API_TOKEN"
TS=$(date +%s)
BODY='{"slug":"school-a","displayName":"A 學校"}'
METHOD="POST"
PATH_URL="/api/v1/admin/tenants"

BODY_HASH=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)
MESSAGE="${TS}.${METHOD}.${PATH_URL}.${BODY_HASH}"
SIG="sha256=$(printf '%s' "$MESSAGE" | openssl dgst -sha256 -hmac "$TOKEN" | sed 's/.* //')"

curl -X "$METHOD" "https://mdm.your-domain.edu${PATH_URL}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-CoGrow-Timestamp: $TS" \
  -H "X-CoGrow-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

### 校驗規則

- Timestamp 與 server 時間差 > ±5 分鐘 → `401 hmac_timestamp_expired`
- 簽名不匹配（body / method / path 任一被改）→ `401 hmac_signature_mismatch`

---

## 10. 已知風險

| 風險 | 說明 | 緩解 |
|------|------|------|
| `ADMIN_API_TOKEN` 為共享單 token | 目前所有 admin 操作共用一個 token，無 per-tenant 權限隔離 | 生產多客戶前應上 per-tenant RBAC（規劃中） |
| 機密金鑰遺失 | `DATA_ENCRYPTION_KEY` 遺失則加密的 LAPS 密碼 / Jamf secret 無法解密 | 金鑰納入密鑰管理 / 備份，與 DB 備份分離保管 |
| 大檔下載壓公網 | 76MB Agent MSI × 大量設備走公網 | 配 `appDownloadBaseUrl` 走校內 LAN（見 agent-app-build §5） |
