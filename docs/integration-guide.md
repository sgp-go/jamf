# CoGrow MDM 對接指南（給台灣後端團隊）

> **版本**：v0.5（2026-06-10）
> **受眾**：台灣後端對接 CoGrow MDM Service API 的開發人員
> **Source of Truth**：OpenAPI 互動式文件 `https://<host>/docs`（Scalar UI），本文補充設計慣例與整合流程

---

## 0. 快速入口

| 資源 | 位置 |
|---|---|
| OpenAPI 3.1 規格 | `https://<host>/openapi.json` |
| 互動式 API 文件 | `https://<host>/docs`（Scalar UI，即時反映最新端點） |
| 服務根 | `https://<host>/` |

開發環境：
```bash
cd jamf-explore && deno task dev
open http://localhost:3000/docs
```

---

## 1. 架構總覽

### 三個 API Surface

| Surface | Base Path | 調用方 | 鑑權 | 目的 |
|---|---|---|---|---|
| **Admin API** | `/api/v1/admin/tenants/{tid}/*` | 台灣後端 | Bearer + HMAC | 租戶管理、設備操作、策略配置、密碼託管 |
| **Tenant API** | `/api/v1/tenants/{tid}/*` | 台灣後端 / Agent | Bearer（可選） | 設備查詢、命令派送、Agent 上報 |
| **Public Download** | `/api/v1/apps/{appId}/download/*` | 設備 | 無 | .msi 安裝包下載（HTTPS + UUID + SHA-256 校驗） |

### 設備管理協議層（不直接對接）

以下路徑由設備 OS 自動呼叫（OMA-DM / SyncML），台灣後端**不會用到**：
```
/t/{tenantSlug}/EnrollmentServer/*               ← 教育局通用 enrollment（直屬 tenant）
/t/{tenantSlug}/g/{groupCode}/EnrollmentServer/* ← 學校專用 enrollment（自動歸 device_group）
/api/mdm/win/manage/{deviceId}                   ← OMA-DM SyncML 管理通道
```

---

## 2. 概念對齊

### 領域模型

```
tenant (買單方／教育局／合約主體)
  ├─ device_group (學校／部門／批次，code 由你方決定語義)
  │   └─ device (apple / windows，跨平台共用一張表)
  │
  ├─ jamf_instance (Jamf Pro 實例，可選；iOS 設備管理用)
  │
  ├─ apps           (上傳的 .msi/.exe/.msix 或 iOS Custom App 引用)
  ├─ profiles       (配置描述檔——WiFi、密碼政策、USB 禁用等)
  ├─ webhook_endpoints (你方註冊的事件接收 URL)
  └─ audit_logs     (1 年保留期的操作審計)
```

### 名詞對照

| 我方術語 | 你方／業界對照 |
|---|---|
| **tenant** | 教育局 / 合約主體 / 計費單位 |
| **device_group** | 學校 / 部門 / 採購批次 |
| **device** | 端點設備（iPad / Windows 學生機），platform=`apple` 或 `windows` |
| **command** | MDM 命令（LOCK / WIPE / REBOOT / ENABLE_LOST_MODE 等） |
| **profile** | 配置描述檔（CSP payload 的集合） |
| **agent token** | 為單一 device 簽發的 Bearer token（Windows 經 install-agent；iOS 經 agent-token 端點） |

### device_group 不存學校資料

**重要**：我方只存「分組識別碼」（code + displayName），**不存學校／學生資料**。
- 學校代碼字典：你方維護
- 學生帳號、教師關係：你方系統
- 我方只認 `device_group.code` 這個字串（如 `"taipei-guangfu-es"`）

---

## 3. 設計慣例

### 3.1 路徑

所有業務 endpoint 都帶 `tenantId`，跨 tenant 嚴格隔離：
```
/api/v1/tenants/{tenantId}/...
/api/v1/admin/tenants/{tenantId}/...
```

### 3.2 ID 規格

| ID 類型 | 格式 | 持久化？ |
|---|---|---|
| `tenant_id` / `device_id` / `command_uuid` | UUID v4 | 永久 |
| `serial_number` | string | 取自設備硬體 |
| `external_id` | string ≤ 64 | 你方定義，我方僅儲存不解析 |

### 3.3 統一回應格式

```json
// 成功
{ "ok": true, "data": { ... } }

// 失敗
{ "ok": false, "error": { "code": "validation_failed", "message": "...", "details": {} } }

// 分頁
{ "ok": true, "data": [...], "meta": { "total": 1234, "page": 1, "limit": 50 } }
```

### 3.4 錯誤碼字典

| HTTP | code | 語義 |
|---|---|---|
| 400 | `validation_failed` | Zod 驗證失敗，details 含具體欄位 |
| 401 | `unauthorized` | 缺 Bearer token 或 token 無效 |
| 401 | `agent_token_invalid` | Agent token 不匹配 |
| 403 | `forbidden` | 跨 tenant 訪問 |
| 404 | `not_found` / `device_not_found` / `app_not_found` | 資源不存在 |
| 409 | `device_group_code_taken` | 同 tenant 下 code 衝突 |
| 413 | `file_too_large` | 上傳檔案超過 500MB |
| 502 | `jamf_upstream_error` | Jamf 上游 API 失敗 |

### 3.5 分頁

預設 `page=1, limit=50`，`limit` 上限 200。用 `?page=2&limit=100` 控制。

### 3.6 時間戳

所有 timestamp 以 **ISO 8601 + UTC**：`"2026-05-26T14:30:00.123Z"`

---

## 4. 鑑權

### 4.1 Admin API（你方 → 我方）

**Bearer Token + HMAC 簽名**（已上線，HMAC 可選——不帶簽名仍兼容，建議盡早啟用）：

```
Authorization: Bearer <ADMIN_API_TOKEN>
X-CoGrow-Timestamp: 1748171234
X-CoGrow-Signature: sha256=<hmac>
```

HMAC 計算（注意：`method` 與 `path` 用你方實際送出的字串，不做大小寫轉換；HTTP method 慣例為大寫）：
```typescript
// signingString = timestamp . method . path . sha256hex(body)
const bodyHash = sha256_hex(rawBody);   // 空 body 也要算（sha256 of "")
const signingString = `${timestamp}.${method}.${path}.${bodyHash}`;
const signature = "sha256=" + hmac_sha256_hex(ADMIN_TOKEN, signingString);
// 送出：
//   Authorization: Bearer <ADMIN_API_TOKEN>
//   X-CoGrow-Timestamp: <unix 秒>
//   X-CoGrow-Signature: sha256=<hex>
```
timestamp 為 Unix 秒，伺服器容忍 ±5 分鐘（NTP 同步即可）。

### 4.2 Agent API（設備 → 我方）

設備上報帶 Bearer token：
```
Authorization: Bearer <agent_token>
```

token 簽發來源依平台不同，但**鑑權機制一致**：一旦某設備被簽發過 token（`agent_token_hash` 非 null），其後所有上報強制帶匹配 token，否則 401（`agent_token_required` / `agent_token_invalid`）。

| 平台 | token 來源 | 注入方式 |
|---|---|---|
| **Windows** | `install-agent` API 簽發 | MSI public property 自動寫入 HKLM，Agent 啟動讀取 |
| **iOS** | `POST .../devices/{deviceId}/agent-token` 簽發 | 你方取得 raw token 後，作為 `agentToken` 鍵注入該設備的 Jamf Managed App Configuration |

> **iOS 已不再走匿名上報**。部署 iOS Agent 時須先為設備簽發 token 並注入 managed config，
> 詳見 [`ios-deployment/managed-app-config.md`](./ios-deployment/managed-app-config.md)。
> 尚未簽發 token 的設備（過渡期）仍相容不帶 token 上報，但生產環境應一律簽發。

### 4.3 Webhook 接收（我方 → 你方）

你方提供接收端點，我方推送時帶 HMAC 簽名（詳見第 8 節）。

---

## 5. 端點清單

> **完整參數與範例**請查閱互動式 API 文件 `https://<host>/docs`。以下為分類速查。

### 5.1 租戶初始化（Admin）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants` | 建 tenant |
| `GET` | `/admin/tenants` | 列 tenants |
| `GET` | `/admin/tenants/{tid}` | tenant 詳情 |
| `PATCH` | `/admin/tenants/{tid}` | 更新 tenant |
| `DELETE` | `/admin/tenants/{tid}` | 刪除 tenant（cascade，不可逆） |
| `POST` | `/admin/tenants/{tid}/mdm-config` | 初始化 MDM 配置（自動生成 CA 憑證） |
| `GET` | `/admin/tenants/{tid}/mdm-config` | 查詢 MDM 配置 |
| `PATCH` | `/admin/tenants/{tid}/mdm-config` | 更新 MDM 配置（publicBaseUrl 等） |

### 5.2 設備分組（Admin）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/device-groups` | 建分組 |
| `GET` | `/admin/tenants/{tid}/device-groups` | 列分組 |
| `GET` | `/admin/tenants/{tid}/device-groups/{gid}` | 分組詳情 |
| `PATCH` | `/admin/tenants/{tid}/device-groups/{gid}` | 更新分組 |
| `DELETE` | `/admin/tenants/{tid}/device-groups/{gid}` | 刪除分組 |

### 5.3 Jamf 整合——iOS 設備管理（Admin）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/jamf-instances` | 新增 Jamf Pro 實例（寫入 clientId/clientSecret） |
| `GET` | `/admin/tenants/{tid}/jamf-instances` | 列 Jamf 實例 |
| `GET` | `/admin/tenants/{tid}/jamf-instances/{iid}` | 實例詳情 |
| `PATCH` | `/admin/tenants/{tid}/jamf-instances/{iid}` | 更新實例（更新 secret 自動清 token cache） |
| `DELETE` | `/admin/tenants/{tid}/jamf-instances/{iid}` | 刪除實例（保留設備記錄） |
| `POST` | `/admin/tenants/{tid}/jamf-instances/{iid}/verify` | 驗證憑據（OAuth 連線測試） |
| `POST` | `/admin/tenants/{tid}/jamf-instances/{iid}/sync-devices` | 從 Jamf 同步設備清單到本地 DB |

### 5.4 設備查詢與操作（Tenant，跨平台統一視角）

> 設備查詢與操作**一律走以下統一端點**（iOS + Windows 同一視角，靠 `platform` 欄位區分）。
> `sync-devices`（§5.3）後設備即進入此視角；**無需也不應使用 Jamf 實例專屬的設備路徑**
> （`/tenants/{tid}/jamf-instances/{iid}/devices` 已棄用，僅保留供內部除錯）。

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/tenants/{tid}/devices` | 列 tenant 所有設備（iOS + Windows 統一視角，每筆帶 `platform` 欄位，支援分組過濾） |
| `GET` | `/tenants/{tid}/device-groups/{gid}/devices` | 列某分組設備 |
| `GET` | `/tenants/{tid}/devices/{did}` | 設備詳情（iOS 自動補 Jamf 即時資料） |
| `PATCH` | `/tenants/{tid}/devices/{did}` | 更新設備（改名 / 移到分組） |
| `DELETE` | `/tenants/{tid}/devices/{did}` | 移除納管（soft delete，保留歷史） |
| `POST` | `/tenants/{tid}/devices/{did}/commands` | 派送命令（LOCK / WIPE / REBOOT / ENABLE_LOST_MODE，自動路由到 Jamf 或自建 MDM） |
| `GET` | `/tenants/{tid}/devices/{did}/commands` | 命令歷史 |
| `GET` | `/tenants/{tid}/devices/{did}/telemetry` | 遙測（最新上報 + 近 7 天使用時長） |
| `POST` | `/tenants/{tid}/devices/{did}/app-lock` | 啟用單 App 模式（Kiosk） |
| `DELETE` | `/tenants/{tid}/devices/{did}/app-lock` | 停用單 App 模式 |

**跨平台命令路由**：同一個 `POST /commands` 端點，我方根據 `device.platform` 自動分流：
- `apple` → 透過 Jamf API 派送
- `windows` → 透過自建 OMA-DM 排隊 + WNS push 觸發

### 5.5 設備操作（Admin）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/devices/{did}/transfer` | 跨校轉移（改分組 + 觸發 Wipe） |
| `POST` | `/admin/tenants/{tid}/devices/{did}/install-agent` | 一鍵派 Agent MSI + 注入配置（Windows） |
| `POST` | `/admin/tenants/{tid}/devices/{did}/agent-token` | 簽發 Agent token（不派 App；iOS 注入 managed config / 撤銷換發） |
| `POST` | `/admin/tenants/{tid}/agent-rollout` | 灰度推送 Agent（by deviceIds / count / percentage） |
| `GET` | `/admin/tenants/{tid}/agent-rollout/health` | 灰度健康驗證（偵測靜默失敗） |

### 5.6 密碼與安全託管（Admin，Windows）

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/admin/tenants/{tid}/devices/{did}/laps-password` | 查詢 LAPS 管理員密碼（解密明文，寫 audit log） |
| `POST` | `/admin/tenants/{tid}/devices/{did}/laps-rotate` | 手動觸發 LAPS 密碼輪換 |
| `GET` | `/admin/tenants/{tid}/devices/{did}/bitlocker-recovery` | 查詢 BitLocker Recovery Password（解密明文，寫 audit log） |

### 5.7 配置描述檔與策略（Admin，Windows）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/profiles` | 建 profile（CSP payload） |
| `GET` | `/admin/tenants/{tid}/profiles` | 列 profiles |
| `GET/PATCH/DELETE` | `/admin/tenants/{tid}/profiles/{pid}` | 詳情 / 更新 / 刪除 |
| `POST` | `/admin/tenants/{tid}/profiles/{pid}/assign` | 指派到設備或分組 |
| `GET` | `/admin/tenants/{tid}/profiles/{pid}/status` | 查詢套用狀態 |
| `DELETE` | `/admin/tenants/{tid}/profiles/{pid}/assignments/{aid}` | 移除指派 |

**策略預設**（高層封裝，自動轉換為 CSP payload）：

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/profile-presets/blocked-sites` | 網站黑名單 |
| `POST` | `/admin/tenants/{tid}/profile-presets/defender` | Defender 強制啟用 |
| `POST` | `/admin/tenants/{tid}/profile-presets/update-policy` | Windows Update 策略 |

### 5.8 Agent 上報（Tenant，iOS + Windows 共用）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/tenants/{tid}/agent/checkin` | Agent 啟動 checkin（回傳待辦：LAPS 輪換、BitLocker 等） |
| `POST` | `/tenants/{tid}/agent/reports` | 上報設備狀態（電量、儲存、OS、LAPS/BitLocker facts） |
| `GET` | `/tenants/{tid}/agent/devices/{sn}/reports` | 查歷史上報 |
| `GET` | `/tenants/{tid}/agent/devices/{sn}/reports/latest` | 最新一筆 |
| `POST` | `/tenants/{tid}/agent/usage` | 上報使用時長（每日 upsert） |
| `GET` | `/tenants/{tid}/agent/devices/{sn}/usage` | 查歷史使用（支援 date/range/limit） |

### 5.9 應用管理（Admin）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/apps` | 上傳 App（multipart/form-data） |
| `GET` | `/admin/tenants/{tid}/apps` | 列 App |
| `GET` | `/admin/tenants/{tid}/apps/{appId}` | App 詳情 |
| `DELETE` | `/admin/tenants/{tid}/apps/{appId}` | 刪除 App + 本地檔案 |

### 5.10 批次註冊（Admin，Windows）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/enrollment/ppkg-config` | 生成 customizations.xml（可選 `deviceGroupId` 讓設備 enroll 自動歸學校；**`wifi[]` 必填**、含本機帳號 / `skipOobe` / `forceChangePasswordAtNextLogon` 配置） |

**PPKG 與 device_group 的關係**：

- **帶 `deviceGroupId`** → 生成「學校專用 PPKG」，DiscoveryUrl 嵌入 `/g/{code}` 段。設備 enroll 即自動歸組（INSERT 寫 group_id / UPDATE 覆蓋既有 group_id）。
- **省略** → 生成「教育局通用 PPKG」。**首次 enroll** 設備 `device_group_id = null`（直屬 tenant，後續可 PATCH 分配）；**重 enroll 既有設備**保留原 `device_group_id`（不誤清——通用 PPKG 不會把已歸校設備拉回直屬 tenant）。

```bash
# 教育局通用 PPKG（首次 enroll 落直屬 tenant；重 enroll 既有設備保留歸屬）
POST /admin/tenants/{tid}/enrollment/ppkg-config
body: {
  "upn": "enrollment@school.local",
  "secret": "...",
  "wifi": [{ "ssid": "Campus-WiFi", "securityType": "WPA2-Personal", "securityKey": "..." }],
  "skipOobe": true,
  "localAccounts": [
    { "username": "student", "password": "<統一初始密碼>", "isAdmin": false, "forceChangePasswordAtNextLogon": true },
    { "username": "itadmin", "password": "...", "isAdmin": true }
  ]
}

# 學校專用 PPKG（自動歸大安國小，首次 / 重 enroll 都覆蓋為大安國小）
POST /admin/tenants/{tid}/enrollment/ppkg-config
body: {
  "upn": "...", "secret": "...",
  "deviceGroupId": "<大安國小 device_group UUID>",
  "wifi": [{ "ssid": "...", "securityKey": "..." }],
  ...
}
```

**關鍵欄位**：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `wifi[]` | ✅ | 至少 1 個 SSID。OOBE 階段裝置斷網，沒此段 enrollment 必失敗（真機驗證） |
| `skipOobe` | 選填 | `true` 跳過「您要如何設定此裝置」頁，配 `forceChangePasswordAtNextLogon` 直達 student 登入畫面 |
| `localAccounts[].forceChangePasswordAtNextLogon` | 選填 | `true` 該帳號首次登入要求自設密碼（教育場景：統一初始密碼 + 首次自設） |
| `deviceGroupId` | 選填 | 設備 enroll 即自動歸校（INSERT/UPDATE 寫 group_id） |

**修改設備歸屬的正確方式**：

| 操作 | 怎麼做 |
|---|---|
| 把直屬 tenant 設備派到某校 | `PATCH /tenants/{tid}/devices/{did}` body `{"deviceGroupId": "<學校 UUID>"}` |
| 把設備從 A 校轉到 B 校 | 同上，傳 B 校 UUID |
| 把學校設備收回直屬 tenant | `PATCH ... {"deviceGroupId": null}` |
| ⚠️ 想清空歸屬 | **必須走 PATCH**，不要靠「重 enroll 通用 PPKG」清空——後者保留原值 |

**校驗規則**：

- `deviceGroupId` 必須屬於同一 tenant，否則回 404 `device_group_not_found`
- `device_group.code` 必須符合 `[a-z0-9_-]{1,64}`（要進 URL path），不符回 400 `device_group_code_not_url_safe`
- Group 解析在 enrollment 路由是 **fail-safe**：PPKG 含的 group code 若在 enroll 時被刪 / 改名找不到，設備仍可 enroll 成功，落庫時**保留原 device_group_id**（首次 enroll 則為 null），並寫 server warn log 提示

### 5.11 Webhook 端點（Admin，自助註冊）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/webhook-endpoints` | 註冊接收端（回傳一次性 secret 明文） |
| `GET` | `/admin/tenants/{tid}/webhook-endpoints` | 列出端點（不含 secret） |
| `GET` | `/admin/tenants/{tid}/webhook-endpoints/{eid}` | 端點詳情 |
| `PATCH` | `/admin/tenants/{tid}/webhook-endpoints/{eid}` | 更新 URL / 訂閱 / 啟停 |
| `DELETE` | `/admin/tenants/{tid}/webhook-endpoints/{eid}` | 停用端點（軟刪，保留投遞歷史） |
| `POST` | `/admin/tenants/{tid}/webhook-endpoints/{eid}/rotate-secret` | 輪換 secret（回傳一次性新 secret） |

### 5.12 合規與審計（Admin）

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/admin/tenants/{tid}/devices/{did}/compliance/evaluate` | 即時合規評估（OS 版本 + 離線天數） |
| `GET` | `/admin/tenants/{tid}/audit-logs` | 審計日誌查詢（分頁 + 多條件過濾） |
| `GET` | `/admin/tenants/{tid}/audit-logs/export.csv` | 審計日誌匯出 CSV（同過濾維度；單次上限 10 萬筆，超限回 `X-Export-Truncated: true`，用 `since`/`until` 分段） |
| `GET` | `/admin/tenants/{tid}/event-log` | Webhook 事件日誌（含未訂閱的事件） |
| `GET` | `/admin/tenants/{tid}/webhook-deliveries` | Webhook 投遞記錄（含重試 / 死信狀態） |

### 5.13 公開下載

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/apps/{appId}/download/{filename}` | 下載 .msi/.exe（支援 HTTP Range，供 EDA-CSP BITS 拉取） |

---

## 6. iOS 設備全流程

```
1. 你方建 tenant + device_group
   POST /admin/tenants                       → { id: "..." }
   POST /admin/tenants/{tid}/device-groups    → { id: "..." }

2. 你方新增 Jamf Pro 實例
   POST /admin/tenants/{tid}/jamf-instances
   body: { host: "xxx.jamfcloud.com", clientId, clientSecret }

3. 驗證 Jamf 連線
   POST /admin/tenants/{tid}/jamf-instances/{iid}/verify
   ← 200 = 憑據有效

4. 從 Jamf 同步設備
   POST /admin/tenants/{tid}/jamf-instances/{iid}/sync-devices
   ← 我方 upsert 到 mdm_devices（platform="apple"）

5. 為設備簽發 Agent token（iOS 無 install-agent，需單獨簽發）
   POST /admin/tenants/{tid}/devices/{deviceId}/agent-token
   ← { deviceId, agentToken, issuedAt }   // agentToken 僅此回傳一次

6. iOS Agent App 部署
   我方 ABM 派發 Custom App → 你方 MDM 透過 InstallApplication
   + ManagedConfiguration 注入以下鍵（App 讀 UserDefaults "com.apple.configuration.managed"）：
     - serverURL    : "https://api.cogrow.com"   // 基礎 host（App 自行拼多租戶路徑）
     - tenantId     : "<tenant uuid>"            // 必填，缺則 App 不上報
     - serialNumber : "<設備序號>"                // 必填，iOS 讀不到硬體序號 → 必須 MDM 注入
     - agentToken   : "<步驟 5 的 agentToken>"    // 必填，上報鑑權；缺則被後端 401（已簽發後）
     - deviceId     : "<可選，預設用 Vendor UUID>"

7. Agent 每日錯峰上報（App 用 serverURL + tenantId 拼路徑，帶 Bearer agentToken）
   POST {serverURL}/api/v1/tenants/{tenantId}/agent/reports
   POST {serverURL}/api/v1/tenants/{tenantId}/agent/usage

8. 你方收到 webhook agent.reported → 更新你方設備狀態
```

> ⚠️ **iOS Agent App 多租戶 + token 契約**：必須由 MDM 注入 `tenantId`（缺則拋 `missingTenant` 不上報）
> 與 `agentToken`（簽發後缺則被後端 401）。`serialNumber` 是後端設備標識（非 deviceId）。
> 完整鍵契約、token 簽發流程、SSID/entitlement 說明見
> [`ios-deployment/managed-app-config.md`](./ios-deployment/managed-app-config.md)。

### iOS 命令路由

你方統一調 `POST /tenants/{tid}/devices/{did}/commands`，body 為 `{ "command": "LOCK", ... }`，
我方依 `device.platform` 自動路由（Apple → Jamf；Windows → 自建 OMA-DM）。

**推薦用跨平台中性命令**（兩平台通用）：`LOCK` / `WIPE` / `REBOOT`。
另支援 Apple-only 命令（Windows 收到回 400）：`DEVICE_LOCK` / `ERASE_DEVICE` / `CLEAR_PASSCODE` /
`DEVICE_INFORMATION` / `RESTART_DEVICE` / `SHUT_DOWN_DEVICE` / `ENABLE_LOST_MODE` / `DISABLE_LOST_MODE`。

> Apple 設備上，中性命令內部映射為 `LOCK→DEVICE_LOCK` / `WIPE→ERASE_DEVICE` / `REBOOT→RESTART_DEVICE`
> 後送 Jamf；你方只需用中性命令，不必關心映射。

---

## 7. Windows 設備全流程

```
1. 你方建 tenant + device_group（同 iOS）

2. 初始化 MDM 配置
   POST /admin/tenants/{tid}/mdm-config
   body: {
     "publicBaseUrl": "https://mdm.example.com",   // 必填，設備 enrollment / OMA-DM 用
     "appDownloadBaseUrl": "http://192.168.1.10"    // 可選，MSI 下載走校內 LAN
   }
   ← 自動生成 CA 根憑證（不在回應中返回）

3. 生成 PPKG 配置（回傳 XML 文本，非 JSON）
   POST /admin/tenants/{tid}/enrollment/ppkg-config
   body: {
     "deviceGroupId": "<學校 device_group UUID>",  // 可選；省略 → 設備直屬教育局
     "upn": "enrollment@school.local",   // enrollment 服務帳號（必含 @）
     "secret": "<OnPremise 密碼>",        // 必填
     "authPolicy": "OnPremise",           // 可選，預設 OnPremise
     "wifi": [{ "ssid": "Campus-WiFi", "securityType": "WPA2-Personal", "securityKey": "..." }],
     "localAccounts": [
       { "username": "student", "password": "...", "isAdmin": false },  // 學生標準帳號
       { "username": "itadmin", "password": "...", "isAdmin": true }    // IT 管理帳號
     ]
   }
   ← 回 customizations.xml（Content-Type: application/xml）→ 用 Windows ICD 編譯成 .ppkg
   ← 帶 deviceGroupId 時 DiscoveryUrl 含 /g/{code} 段，設備 enroll 即自動歸學校
   ← 不帶 → 設備 enroll 後 device_group_id=null，後續可 PATCH /tenants/{tid}/devices/{did} 分配

4. 設備 enrollment（PPKG 或手動註冊，OS 自動跑 SOAP + OMA-DM）
   你方收到 webhook: device.enrolled（payload 含 device_group_id；歸學校時非 null）

5. 你方上傳 Agent MSI
   POST /admin/tenants/{tid}/apps  (multipart)
   fields: file=CoGrowMDMAgent.msi, displayName, version, bundleId

6. 派 Agent 到設備
   POST /admin/tenants/{tid}/devices/{did}/install-agent
   body: { "appId": "<uuid>", "apiEndpoint": "https://api.cogrow.com/api/v1" }
   ← 回 { "deviceId": "<uuid>", "agentToken": "...", "commandIds": ["<uuid>", ...] }
   ← 自動排隊：Registry 注入配置 → EDA-CSP 下載 MSI → LAPS ADMX → BitLocker ADMX

7. 設備自動完成
   MSI 安裝 → Agent Service 啟動 → checkin → LAPS 自動改密 → BitLocker 自動加密
   你方收到 webhook: command.completed × N, agent.reported
```

### 7.1 LAPS 密碼查詢

設備納管後 Agent 自動輪換管理員密碼（20 字隨機）。IT 需要時：

```
GET /admin/tenants/{tid}/devices/{did}/laps-password
← {
    "password": "kX9#mP2$vL7@nQ4",   // 解密後明文
    "adminAccount": "Administrator",  // 受管帳號名
    "rotatedAt": "2026-06-09T...",
    "rotationId": "<uuid>",
    "status": "confirmed"             // confirmed=Agent 已確認；pending=待回報
  }
```

手動觸發輪換（設備下次 checkin 時執行）：
```
POST /admin/tenants/{tid}/devices/{did}/laps-rotate
```

### 7.2 BitLocker Recovery Key 查詢

設備納管後自動靜默加密（XTS-AES 256 + TPM），Recovery Password 自動捕獲存 DB。
硬碟損壞或忘記 PIN 時：

```
GET /admin/tenants/{tid}/devices/{did}/bitlocker-recovery
← {
    "recoveryPassword": "034386-466246-...",  // 48 位，nullable（pending 時為 null）
    "encryptionMethod": "XtsAes256",           // nullable
    "encryptionId": "<uuid>",
    "status": "confirmed",                     // confirmed=已確認；pending=待 Agent 回報
    "confirmedAt": "2026-06-09T..."            // nullable
  }
```

### 7.3 灰度推送 Agent 更新

```
# 先推 2-3 台觀察（建議用 deviceIds 模式起步）
POST /admin/tenants/{tid}/agent-rollout
body: {
  "appId": "<新版 MSI 的 appId>",
  "apiEndpoint": "https://api.cogrow.com/api/v1",
  "selection": { "mode": "deviceIds", "deviceIds": ["<uuid>", "<uuid>"] }
}
← { "targetVersion": "1.4.0.0", "eligible": 200, "selected": 2,
    "skipped": 0, "queued": 2, "failed": 0, "results": [...] }

# 等一個上報窗口後查健康（windowMinutes 預設 30）
GET /admin/tenants/{tid}/agent-rollout/health?appId=<appId>&windowMinutes=30
← {
    "targetVersion": "1.4.0.0",
    "windowMinutes": 30,
    "upgraded": ["<deviceId>", ...],      // 已升級且正常上報
    "silent": ["<deviceId>", ...],        // 曾上報、現失聯 → 回滾告警目標
    "pending": ["<deviceId>", ...],       // 未升級但窗口內有上報（進行中）
    "neverReported": ["<deviceId>", ...]  // 從未上報（可能未裝 agent）
  }
# silent 非空 = 升級後失聯，需評估回滾

# 確認 silent 為空，逐步擴大（count 取前 N 或 percentage 取候選百分比）
POST /admin/tenants/{tid}/agent-rollout
body: {
  "appId": "<appId>", "apiEndpoint": "...",
  "selection": { "mode": "percentage", "percent": 50 }
}
```

> **selection 三種模式**：`deviceIds`（指定 UUID 列表）/ `count`（取候選前 N 台）/
> `percentage`（取候選百分比，欄位名 `percent`）。候選 = tenant 下當前版本 ≠ 目標版本的 Windows 設備，逐批調用自然收斂。
> **health 回傳的是設備 ID 陣列而非計數**——你方按陣列長度自行算比例，`silent` 陣列即失聯設備清單。

---

## 8. Webhook 整合

### 8.1 註冊接收端點（自助 API）

透過 Admin API 自助註冊（端點清單見 §5.11，完整 schema 查 OpenAPI `/docs`）：

```
POST /api/v1/admin/tenants/{tid}/webhook-endpoints
body: {
  "url": "https://api.tw.example/cogrow/webhook/v1",   // HTTPS，建議帶路徑版本
  "eventTypes": ["device.enrolled", "command.completed"], // 留空 / 省略＝訂閱全部（見 §8.6）
  "description": "生產環境設備事件"                       // 可選
}
← { "id": "<uuid>", "url": "...", "eventTypes": [...], "isActive": true,
    "secret": "9f8e7d6c..." }   // ⚠️ secret 明文僅此回傳一次，請立即存入密鑰管理
```

- **secret** 是 HMAC 簽名密鑰（驗簽見 §8.3），**僅建立時回傳一次**；遺失只能輪換重發：
  ```
  POST /api/v1/admin/tenants/{tid}/webhook-endpoints/{eid}/rotate-secret
  ← { ..., "secret": "<新明文>" }   // 舊 secret 立即失效，記得同步更新你方驗簽密鑰
  ```
- **改 URL / 訂閱 / 啟停**：`PATCH .../webhook-endpoints/{eid}`（body 同上欄位，皆可選）。
- **停用**：`DELETE .../webhook-endpoints/{eid}`（軟刪 `isActive=false`，保留投遞歷史；`PATCH isActive=true` 可重新啟用）。
- **eventTypes** 會在後端校驗（未知類型回 400 `validation_failed`）；留空＝全訂閱。

> **測試→生產切換**：建議**新建一個生產 endpoint**而非改測試 endpoint，驗證無誤後再 `DELETE` 停用測試的。

### 8.2 推送格式

```
POST <你方 URL>
Content-Type: application/json
X-CoGrow-Event: device.enrolled
X-CoGrow-Delivery: <uuid>          ← 每次推送唯一
X-CoGrow-Timestamp: 1748171234
X-CoGrow-Signature: sha256=<hex>

{
  "event_id": "evt_uuid",          ← 業務事件 ID（重試不變，當冪等鍵）
  "delivery_id": "dlv_uuid",
  "event_type": "device.enrolled",
  "occurred_at": "2026-05-26T03:14:15.926Z",
  "tenant_id": "...",
  "data": { ... }
}
```

### 8.3 簽名驗證（必做）

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyCoGrowWebhook(opts: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;       // 原始 request body（不是 JSON.stringify 過的物件）
}): boolean {
  // 1. timestamp 在 5 分鐘窗口內（防 replay）
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(opts.timestamp, 10)) > 300) return false;

  // 2. 計算期望簽名
  const expected = "sha256=" + createHmac("sha256", opts.secret)
    .update(`${opts.timestamp}.${opts.rawBody}`)
    .digest("hex");

  // 3. timing-safe 比對
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

### 8.4 回應規範

| 你方回應 | 我方處理 |
|---|---|
| 2xx | 標 delivered，不再重試 |
| 非 2xx 或逾時 15s | 重試：30s → 5min → 30min，4 次後標 dead |

### 8.5 冪等性

推送可能重複，請用 `event_id`（不是 `delivery_id`）作冪等鍵。

### 8.6 事件類型清單

| 類別 | 事件 |
|---|---|
| 設備 | `device.enrolled` / `online` / `offline` / `transferred` / `unenrolled` |
| 命令 | `command.queued` / `sent` / `acknowledged` / `completed` / `failed` |
| 描述檔 | `profile.applied` / `failed` / `removed` |
| 應用 | `app.installed` / `install_failed` / `uninstalled` |
| Agent | `agent.installed` / `reported` / `checkin` / `usage_reported` / `usage_anomaly` |
| 庫存 | `inventory.updated` |

---

## 9. 上線前 Checklist

### 9.1 帳號與憑證

- [ ] 取得 `ADMIN_API_TOKEN`（我方產出時通知你方）
- [ ] 準備 Webhook 接收 URL（HTTPS）
- [ ] 建立 webhook endpoint 取得 secret（`POST .../webhook-endpoints` 回傳一次，見 §8.1）
- [ ] iOS 場景：ABM/ASM 帳號 + Organization ID（Custom App 派發用）

### 9.2 系統能力

- [ ] HMAC SHA-256 簽名實作（呼叫 Admin API）
- [ ] HMAC SHA-256 驗證實作（Webhook 接收）
- [ ] Webhook 冪等（用 `event_id` 去重）
- [ ] Webhook 在 15 秒內回 2xx

### 9.3 資料對應

- [ ] 你方 tenant ↔ 我方 tenant
- [ ] 你方學校 ↔ 我方 device_group
- [ ] 你方設備 ID ↔ 我方 device.external_id
- [ ] SSO 帳號 → 你方 user → 我方 tenant 對應

### 9.4 第一個整合驗證里程碑

1. 呼叫 `GET /admin/tenants` 收到 200（admin 鑑權通過）
2. 建 tenant + device_group
3. iOS：新增 Jamf 實例 + verify + sync-devices
4. Windows：初始化 mdm-config + 生成 ppkg-config
5. 註冊 webhook endpoint → 收到測試事件 → 驗簽通過

---

## 10. FAQ

**Q1：tenant 多大？**
對應「合約主體」。最常見：1 tenant = 1 縣市教育局，底下掛 N 所學校（每所一個 `device_group`）。

**Q2：iOS 和 Windows 設備在同一張表？**
是。`mdm_devices.platform` = `apple` 或 `windows`。設備列表與詳情 API 的每筆都帶 `platform` 欄位，你方在前端按此區分 iOS / Windows（目前無服務端 platform query 過濾，按欄位自行篩選）。

**Q3：命令 API 怎麼知道走 Jamf 還是自建 MDM？**
`POST /devices/{did}/commands` 根據 `device.platform` 自動路由，你方不需關心底層協議差異。

**Q4：Agent token 洩漏怎麼處理？**
重新呼叫 `install-agent` 即可，新 token 自動覆蓋舊 hash，舊 token 立即失效。

**Q5：Webhook 重複推怎麼辦？**
用 `event_id` 作冪等鍵（DB UNIQUE 約束或 Redis SET NX）。

**Q6：LAPS 密碼、BitLocker Recovery Key 的查詢會留記錄嗎？**
會。每次查詢自動寫 audit_log（操作者 + 時間 + 目標設備），可用 `GET /audit-logs` 查閱。

---

## 11. 變更記錄

| 日期 | 版本 | 變更 |
|---|---|---|
| 2026-05-26 | v0.1 | 首版（W1 完成版，Windows 為主） |
| 2026-05-28 | v0.2 | W2 全部完成：OMA-DM webhook / CRUD / 跨平台命令 / Profile 引擎 / OpenAPI |
| 2026-06-09 | **v0.3** | **W3-W5 全落地**：+iOS Jamf 整合全流程 / +LAPS 密碼託管 / +BitLocker 靜默加密 / +Agent checkin / +灰度推送+健康驗證 / +HMAC 簽名 / +配置描述檔+策略預設 / +合規評估 / +審計日誌 / 端點清單從 ~20 擴充至 ~70 |
| 2026-06-09 | **v0.4** | **iOS 對接補完**：iOS 上報改強制 token（新增 `POST .../devices/{did}/agent-token` 簽發端點 + `agentToken` managed config 鍵）/ 新增 `docs/ios-deployment/`（managed config 鍵契約、ABM Custom App 分發、APNs 憑證管理、iOS App 更新策略）/ §4.2 §6 同步更新 |
| 2026-06-10 | **v0.5** | 修正 `apiEndpoint` 範例 `/api/agent/v1` → `/api/v1`（對齊實際路由，避免 Windows Agent 上報 404）/ §8.1 補 Webhook 接入工作表（ops 註冊流程標準化）/ 移除「聯絡窗口」節（聯絡方式雙方已知）/ iOS 文檔導航補簽名憑據交接 Checklist 連結 |
| 2026-06-10 | **v0.6** | **Webhook 自助註冊上線**：§5.11 新增 endpoint CRUD + rotate-secret（取代 ops 手動寫 DB），§8.1 改為自助 API（secret 僅建立 / 輪換回傳一次，軟刪保留投遞歷史）/ secret 改加密儲存 / §5.5 補 §5.4 jamf-devices 棄用標注 |
| 2026-06-23 | **v0.7** | **PPKG 帶 device_group 自動歸校**：§5.10 ppkg-config 新增可選 `deviceGroupId` 參數，PPKG DiscoveryUrl 嵌入 `/g/{code}` 段，設備 enroll 即落 `device_group_id`；§7 Windows 全流程同步更新；新增 `/t/{slug}/g/{code}/EnrollmentServer/*` SOAP 路由（fail-safe：group 解析失敗回退「直屬 tenant」，不阻斷 enroll） |
| 2026-06-25 | **v0.8** | **PPKG OOBE 0 觸控 + 強制改密**（端到端真機驗證）：§5.10 ppkg-config `wifi[]` 改**必填**（OOBE 階段裝置斷網，沒此段 enrollment 必失敗）/ 新增 `skipOobe` 跳過「設定方式」頁直達 student 登入畫面（⚠️ Win10 22H2 不能 bypass 隱私頁與資料海外存儲同意頁）/ 新增 `localAccounts[].forceChangePasswordAtNextLogon` 對應 PPKG `ProvisioningCommands` 段以 SYSTEM 跑 `net user /logonpasswordchg:yes`（教育場景：統一初始密碼 + 首次自設） |
