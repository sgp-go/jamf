# 自建 MDM 部署與裝置管理指南

本文件涵蓋兩個場景：

- **場景 A**：將現有 Jamf + ABM 管理的裝置遷移到自建 MDM
- **場景 B**：新裝置直接加入自建 MDM

---

## 前置作業（一次性設定）

以下步驟只需執行一次，完成後即可反覆用於遷移和新增裝置。

### 步驟 1：啟動自建 MDM 伺服器

```bash
# 1. 設定 .env
# MDM_SERVER_URL 填入 ngrok 公網地址
MDM_SERVER_URL=https://succinctly-ashless-thuy.ngrok-free.dev

# 2. 啟動伺服器
deno task dev

# 3. 啟動 ngrok（另一個終端）
ngrok http 3000
```

驗證伺服器是否正常：

```bash
curl https://<your-ngrok-url>/api/mdm/certs/status
```

### 步驟 2：取得 APNS 推播憑證

APNS 推播憑證用於伺服器向裝置發送喚醒通知。完整流程分為五步：

```
生成 Vendor CSR → Apple Developer 簽發 Vendor Cert
    → 生成 APNS CSR → 用 Vendor Cert 簽署 → Apple Push Portal 簽發推播憑證
```

所有步驟都透過 API 完成，無需手動操作 openssl。

#### 2a. 生成 Vendor CSR 並到 Apple Developer 後台取得 MDM Vendor Certificate

**說明**：MDM Vendor Certificate 是 Apple 授權你簽署 APNS CSR 的憑證。詳細說明見 [Apple 官方文件](https://developer.apple.com/help/account/certificates/mdm-vendor-csr-signing-certificate/)。

##### 第一步：從伺服器生成 CSR

```bash
# 瀏覽器直接下載
open "https://<your-ngrok-url>/api/mdm/certs/vendor/csr?download=true"

# 或用 curl 下載
curl -o mdm_vendor.csr \
  "https://<your-ngrok-url>/api/mdm/certs/vendor/csr?download=true"
```

> 私鑰已自動儲存在伺服器上。

##### 第二步：在 Apple Developer 後台上傳 CSR，下載憑證

1. 登入 [Apple Developer](https://developer.apple.com/account)
2. 進入 **Certificates, Identifiers & Profiles**
3. 點選左側 **Certificates**，然後點選右上角 **+**（Create a New Certificate）
4. 在 **Services** 區塊中選擇 **MDM CSR Signing Certificate**，點 **Continue**
5. 點 **Choose File**，上傳剛下載的 `mdm_vendor.csr`
6. 點 **Continue**
7. 點 **Download** 下載 Apple 簽發的 `.cer` 檔案（如 `mdm.cer`）

##### 第三步：將 Vendor Certificate 上傳到伺服器

> **注意**：如果步驟一中的 CSR 是由伺服器 API 生成的，只需上傳 `.cer`（私鑰已在伺服器上）。
> 如果 CSR 是你自行生成的（例如透過 Keychain Access），需要同時上傳 `.cer` 和對應的私鑰 `.key`。

```bash
# 方式 A：CSR 由伺服器生成（只需上傳 cert）
curl -X POST https://<your-ngrok-url>/api/mdm/certs/vendor \
  -F "cert=@/path/to/mdm.cer"

# 方式 B：CSR 由自行生成（同時上傳 cert + key）
curl -X POST https://<your-ngrok-url>/api/mdm/certs/vendor \
  -F "cert=@/path/to/mdm.cer" \
  -F "key=@/path/to/mdm_vendor.key"
```

回應範例：

```json
{
  "message": "MDM Vendor Certificate 上傳成功",
  "subject": "UID=UK774VN48M, CN=MDM Vendor: ..., O=..., C=CN",
  "issuer": "CN=Apple Worldwide Developer Relations ..., O=Apple Inc., C=US",
  "expiry": "2026-11-21T08:51:08.000Z"
}
```

#### 2b. 生成 APNS CSR

```bash
curl -o mdm_apns.csr \
  "https://<your-ngrok-url>/api/mdm/certs/apns/csr?download=true"
```

> 私鑰已自動儲存在伺服器上，後續上傳推播憑證時不需要再提供。

#### 2c. 用 Vendor Certificate 簽署 APNS CSR

伺服器自動使用步驟 2a 上傳的 Vendor Certificate 簽署，同時下載 Apple WWDR G3 中間 CA 和 Apple Root CA 組成完整證書鏈：

```bash
curl -X POST https://<your-ngrok-url>/api/mdm/certs/apns/sign \
  -o SignedCSR.plist
```

會下載一個 `SignedCSR.plist` 檔案（base64 編碼的 plist，包含 PushCertRequestCSR、PushCertSignature、PushCertCertificateChain 三個欄位）。

#### 2d. 在 Apple Push Certificates Portal 取得推播憑證

1. 開啟 [Apple Push Certificates Portal](https://identity.apple.com/pushcert/)
2. 用 Apple ID 登入（**記住此 Apple ID，續期時必須使用同一個**）
3. 點選 **Create a Certificate**
4. 同意條款
5. 點 **Choose File**，上傳 `SignedCSR.plist`
6. 等待處理完成後，點選 **Download** 下載推播憑證（`.pem`）

#### 2e. 上傳推播憑證到自建 MDM

```bash
# 只需上傳憑證，私鑰已在伺服器上（步驟 2b 時自動儲存）
curl -X POST https://<your-ngrok-url>/api/mdm/certs/apns \
  -F "cert=@/path/to/MDM_Push_Certificate.pem"
```

回應範例：

```json
{
  "message": "APNS 憑證上傳成功",
  "topic": "com.apple.mgmt.External.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "expiry": "2027-03-26T10:06:30.000Z",
  "subject": "UID=com.apple.mgmt.External.xxx, CN=APNS, O=Aspira"
}
```

`topic` 會從憑證中自動提取，無需手動設定。

### 步驟 3：在 ABM 中新增自建 MDM Server

#### 3a. 下載自建 MDM 公鑰

```bash
# 瀏覽器直接下載
open "https://<your-ngrok-url>/api/mdm/dep/pubkey?download=true"

# 或 curl 下載
curl -o mdm_dep_pubkey.pem \
  "https://<your-ngrok-url>/api/mdm/dep/pubkey?download=true"
```

#### 3b. 在 ABM 中新增 MDM Server

1. 登入 [Apple Business Manager](https://business.apple.com)
2. 點選側邊欄底部 **Settings**
3. 點選 **Device Management Settings** → **Add MDM Server**
4. 名稱填入：`Self-Hosted MDM`
5. 上傳剛下載的 `mdm_dep_pubkey.pem` 公鑰
6. 點選 **Save**
7. 點選 **Download Token** → 儲存 `.p7m` 檔案

#### 3c. 上傳 DEP Server Token

```bash
curl -X POST https://<your-ngrok-url>/api/mdm/dep/token \
  -F "token=@/path/to/downloaded_token.p7m"
```

回應範例：

```json
{
  "message": "DEP Token 上傳成功",
  "tokenId": 1,
  "account": {
    "server_name": "Self-Hosted MDM",
    "org_name": "Your Organization",
    "org_email": "admin@example.com"
  },
  "sync": {
    "synced": 0,
    "total": 0
  }
}
```

伺服器會自動：解密 token → 驗證帳戶 → 首次同步裝置列表。

### 步驟 4：建立 ADE 描述檔

ADE 描述檔定義了裝置在 Setup Assistant 中的行為（跳過哪些步驟、是否 supervised 等）。

若不帶 `skip_setup_items`，伺服器會套用內建的完整預設清單（Apple 官方 SkipKeys 近乎完整子集，共 35 項，**保留** `WiFi` 與 `Passcode`）。實機驗證結果（iPad 9th Gen）：裝置僅會看到 **語言 → 地區 → Wi-Fi → 「遠端管理」→ 設密碼 → 桌面**，不再出現 Welcome、TapToSetup、Appearance、TrueTone、Keyboard、Accessibility、Privacy、Apple ID、Siri、Touch ID、Terms 等約 25 頁。

```bash
# 採用內建預設（最精簡 Setup Assistant 體驗）
curl -X POST https://<your-ngrok-url>/api/mdm/dep/profile \
  -H "Content-Type: application/json" \
  -d '{
    "is_supervised": true,
    "is_mdm_removable": false,
    "support_phone_number": "your-phone",
    "support_email_address": "admin@example.com"
  }'

# 或自訂 skip 清單（覆蓋預設）
curl -X POST https://<your-ngrok-url>/api/mdm/dep/profile \
  -H "Content-Type: application/json" \
  -d '{
    "skip_setup_items": ["Location", "Restore", "AppleID"]
  }'
```

回應範例：

```json
{
  "message": "ADE 描述檔已建立",
  "profile_uuid": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
  "devices": {}
}
```

**記下 `profile_uuid`**，後續分配裝置時需要。

> **升級既有 profile 的方法**：Apple DEP 後台已上傳的 profile 不會隨代碼預設值自動更新。若要套用新 skip 清單，重新呼叫 `POST /api/mdm/dep/profile` 建立新版本（取得新 `profile_uuid`），再呼叫 `POST /api/mdm/dep/assign` 重新分配給裝置。已完成 Setup Assistant 的裝置需抹掉重進才會生效。
>
> 實測流程範例（已驗證通過）：
>
> ```bash
> # 1. 重建 profile（body 傳空物件以採用內建預設）
> curl -X POST $BASE/dep/profile -H 'Content-Type: application/json' -d '{}'
> # → { "profile_uuid": "21ED45...4154" }
>
> # 2. 查 DEP 裝置序號
> curl -s $BASE/dep/devices
>
> # 3. 將新 profile 分配給目標裝置
> curl -X POST $BASE/dep/assign -H 'Content-Type: application/json' \
>   -d '{"profileUuid":"21ED45...4154","serialNumbers":["JHNWY39N9M"]}'
> # → { "devices": { "JHNWY39N9M": "SUCCESS" } }
>
> # 4. 在 iPad 上抹掉（設定 → 一般 → 傳送或重置 iPad → 清除所有內容和設定）
> # 5. 重進 Setup Assistant 後 skip 清單自動套用
> ```

### 步驟 5：驗證前置作業完成

```bash
curl -s https://<your-ngrok-url>/api/mdm/certs/status
```

確認三項都為 `exists: true`：

```json
{
  "apnsCert": { "exists": true, "topic": "com.apple.mgmt.External.xxx", "expiry": "..." },
  "caCert":   { "exists": true, "expiry": "..." },
  "depToken": { "exists": true, "orgName": "...", "expiry": "..." }
}
```

---

## 場景 A：從 Jamf 遷移現有裝置到自建 MDM

適用於：裝置目前在 Jamf Pro 管理下，且已透過 ABM 註冊。

### 流程概覽

```
ABM 重新分配 → DEP 同步 → 分配描述檔 → 抹掉裝置 → Setup Assistant → 自動註冊
```

### A-1. 建立遷移記錄

```bash
curl -X POST https://<your-ngrok-url>/api/mdm/migration/start \
  -H "Content-Type: application/json" \
  -d '{
    "serialNumber": "JHNWY39N9M",
    "jamfDeviceId": "1"
  }'
```

### A-2. 在 ABM 中重新分配裝置

1. 登入 [Apple Business Manager](https://business.apple.com)
2. 進入 **Devices**
3. 搜尋裝置序列號（如 `JHNWY39N9M`）
4. 點選裝置
5. 將 **MDM Server** 從 `Jamf Pro - Cogrow` 改為 **`Self-Hosted MDM`**
6. 儲存

### A-3. 同步裝置到自建 MDM

ABM 重新分配後，自建 MDM 需要同步裝置列表：

```bash
curl -X POST https://<your-ngrok-url>/api/mdm/dep/sync
```

驗證裝置已出現：

```bash
curl -s https://<your-ngrok-url>/api/mdm/dep/devices
```

### A-4. 分配 ADE 描述檔給裝置

```bash
curl -X POST https://<your-ngrok-url>/api/mdm/dep/assign \
  -H "Content-Type: application/json" \
  -d '{
    "profileUuid": "<步驟 4 取得的 profile_uuid>",
    "serialNumbers": ["JHNWY39N9M"]
  }'
```

### A-5. 抹掉裝置

裝置必須經過 Setup Assistant 才能觸發 ADE 自動註冊。有兩種方式抹掉裝置：

**方式 A：透過 Jamf 遠端抹掉**

```bash
# 使用現有的 Jamf 管理命令端點
curl -X POST https://<your-ngrok-url>/api/devices/<jamf-device-id>/command \
  -H "Content-Type: application/json" \
  -d '{ "command": "EraseDevice" }'
```

**方式 B：在裝置上手動抹掉**

在 iPad 上操作：**Settings → General → Transfer or Reset iPad → Erase All Content and Settings**

### A-6. 裝置自動註冊

裝置抹掉重啟後進入 Setup Assistant。採用內建預設 skip 清單時的完整路徑（iPad 9th Gen 實測）：

1. 選擇語言
2. 選擇地區
3. 連線 Wi-Fi
4. 裝置自動從 Apple 取得 ADE 描述檔
5. 出現 **「遠端管理」** 提示，顯示由你的組織管理 → 點繼續
6. 裝置自動向自建 MDM 發送 Authenticate → TokenUpdate
7. 設定裝置密碼（Passcode 頁面，按預設保留）
8. 進入桌面，註冊完成

其餘 ~25 頁（Welcome、TapToSetup、Appearance、TrueTone、Keyboard、Accessibility、Privacy、Apple ID、Siri、Touch ID、Terms 等）由 skip_setup_items 自動略過。

### A-7. 驗證註冊成功

```bash
# 查看自建 MDM 已註冊裝置
curl -s https://<your-ngrok-url>/api/mdm/devices
```

應看到裝置，狀態為 `enrolled`：

```json
{
  "totalCount": 1,
  "devices": [{
    "udid": "...",
    "serial_number": "JHNWY39N9M",
    "enrollment_status": "enrolled",
    "push_token": "...",
    "push_magic": "..."
  }]
}
```

發送 DeviceInformation 命令確認通訊正常：

```bash
# 排入命令
curl -X POST https://<your-ngrok-url>/api/mdm/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "DeviceInformation" }'

# 推播喚醒裝置拉取命令
curl -X POST https://<your-ngrok-url>/api/mdm/devices/<udid>/push

# 查看命令結果
curl -s https://<your-ngrok-url>/api/mdm/devices/<udid>/commands
```

---

## 場景 B：新裝置加入自建 MDM

適用於：全新裝置或已抹掉的裝置，直接加入自建 MDM 管理。

### 流程概覽

```
裝置加入 ABM → 分配到自建 MDM → 分配描述檔 → Setup Assistant → 自動註冊
```

### B-1. 將新裝置加入 ABM

#### 方法 A：使用 Mac 上的 Apple Configurator 2

1. 在 iPad 上抹掉資料（如果不是全新裝置）
2. iPad 停在 **Setup Assistant**（Hello 介面），選擇語言、地區、連線 Wi-Fi 後**停住**
3. 用 USB 線將 iPad 連接到 Mac
4. 開啟 **Apple Configurator 2**
5. 選中 iPad → 選單欄 **Prepare** 或右鍵 **Add to Apple Business Manager**
6. 按嚮導完成

#### 方法 B：使用 iPhone 上的 Apple Configurator App

1. iPad 抹掉並停在 Setup Assistant，連線 Wi-Fi
2. 開啟 iPhone 上的 [Apple Configurator](https://apps.apple.com/app/apple-configurator/id1588040660) App
3. 用 ABM 管理員賬號登入
4. 將 iPhone 靠近 iPad，App 自動發現裝置
5. 按提示完成新增

### B-2. 在 ABM 中分配裝置給自建 MDM

1. 登入 [Apple Business Manager](https://business.apple.com)
2. 進入 **Devices**，搜尋新裝置的序列號
3. 點選裝置，將 **MDM Server** 設為 **`Self-Hosted MDM`**
4. 儲存

### B-3. 同步並分配描述檔

```bash
# 同步裝置列表
curl -X POST https://<your-ngrok-url>/api/mdm/dep/sync

# 確認裝置已出現
curl -s https://<your-ngrok-url>/api/mdm/dep/devices

# 分配 ADE 描述檔
curl -X POST https://<your-ngrok-url>/api/mdm/dep/assign \
  -H "Content-Type: application/json" \
  -d '{
    "profileUuid": "<profile_uuid>",
    "serialNumbers": ["<新裝置序列號>"]
  }'
```

### B-4. 在裝置上完成 Setup Assistant

採用內建預設 skip 清單時的完整路徑（參考 A-6）：

1. 確保 iPad 處於 **Setup Assistant**（Hello 介面）—— 已設定過需先抹掉
2. 選擇語言 → 選擇地區 → 連線 Wi-Fi
3. 出現 **「遠端管理」** → 點繼續
4. 設定裝置密碼
5. 進入桌面，註冊完成

### B-5. 驗證

```bash
# 查看已註冊裝置
curl -s https://<your-ngrok-url>/api/mdm/devices

# 發送測試命令
curl -X POST https://<your-ngrok-url>/api/mdm/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "DeviceInformation" }'

curl -X POST https://<your-ngrok-url>/api/mdm/devices/<udid>/push
```

---

## 常用管理命令

裝置註冊成功後，可透過以下命令管理裝置：

```bash
BASE=https://<your-ngrok-url>/api/mdm

# 查詢裝置資訊
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "DeviceInformation" }'

# 查詢安全狀態
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "SecurityInfo" }'

# 查詢已安裝 App
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "InstalledApplicationList" }'

# 鎖定裝置
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "DeviceLock", "params": { "Message": "此裝置已鎖定" } }'

# 重新啟動裝置
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "RestartDevice" }'

# 啟用 Lost Mode（Message / PhoneNumber / Footnote 至少給一項）
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "EnableLostMode",
        "params": { "Message": "請聯繫失主", "PhoneNumber": "0912345678" } }'

# 停用 Lost Mode
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "DisableLostMode" }'

# 查詢 Lost Mode 狀態（list 與 detail 都會附 lostMode 物件）
curl -s $BASE/devices/<udid> | jq .lostMode
# → { "enabled": true, "message": "...", "phone": "...", "footnote": "...", "enabledAt": "2026-..." }
#
# 實作說明：
# - 狀態由伺服器在裝置 ack EnableLostMode / DisableLostMode 命令時自動簿記
#   （對應 src/mdm/command.ts 的 applyLostModeBookkeeping）
# - enabledAt 是本地伺服器記錄的時間，不是裝置回報的時間
# - 與 Jamf 路徑不同：Jamf 需額外呼叫 Classic API 才能拿到狀態，
#   自建 MDM 直接從 mdm_devices 表的 lost_mode_* 欄位讀取

# 啟用單 App 模式（App Lock）
curl -X POST $BASE/devices/<udid>/app-lock \
  -H "Content-Type: application/json" \
  -d '{ "bundleId": "com.apple.mobilesafari",
        "options": { "disableAutoLock": true } }'

# 停用單 App 模式
curl -X DELETE $BASE/devices/<udid>/app-lock

# 派送 App（iTunesStoreID / ManifestURL / Identifier 擇一）
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "InstallApplication",
        "params": { "iTunesStoreID": 1234567890, "ManagementFlags": 4 } }'

# 移除派送的 App
curl -X POST $BASE/devices/<udid>/command \
  -H "Content-Type: application/json" \
  -d '{ "commandType": "RemoveApplication",
        "params": { "Identifier": "com.example.app" } }'

# 排入命令後，推播喚醒裝置執行
curl -X POST $BASE/devices/<udid>/push
```

### 批次下發同一命令到多台裝置

透過長連線 HTTP/2 multiplexing 併發推播，N 台裝置 ~ 秒級完成：

```bash
curl -X POST $BASE/commands/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "udids": ["UDID-1", "UDID-2", "UDID-3"],
    "commandType": "DeviceLock",
    "params": { "Message": "統一鎖定" }
  }'
```

回應會回報 `enqueued`、`pushed`、`failed` 與每台 `commandUuid`；部分失敗（未註冊、缺 push token）會列入 `failed` 但不 rollback 已入隊的命令。

---

## 故障排除

| 問題 | 解決方案 |
|------|----------|
| 裝置在 Setup Assistant 中沒有收到 MDM 設定 | 確認 ABM 中裝置已分配給 `Self-Hosted MDM`，且已分配 ADE 描述檔 |
| DEP 同步看不到裝置 | 等待幾分鐘讓 ABM 同步完成，然後重新呼叫 `POST /api/mdm/dep/sync` |
| 裝置已經過了 Setup Assistant | 需要抹掉裝置重新進入 Setup Assistant，ADE 只在 Setup Assistant 階段觸發 |
| APNS 推播失敗 | 檢查 APNS 憑證是否過期（`GET /api/mdm/certs/status`），過期需重新上傳 |
| enroll 端點報錯「APNS 憑證尚未上傳」 | 呼叫 `POST /api/mdm/certs/apns` 上傳推播憑證 |
| ngrok URL 變了 | 更新 `.env` 中的 `MDM_SERVER_URL`，重啟伺服器，重新建立 ADE 描述檔 |
| DEP Token 過期 | 在 ABM 中重新下載 token，再呼叫 `POST /api/mdm/dep/token` 上傳 |
| 裝置顯示 `authenticated` 但沒變成 `enrolled` | 裝置可能未完成 TokenUpdate，檢查網路連線和 ngrok 是否正常運行 |

---

## 證書續期提醒

| 證書 | 有效期 | 續期方式 |
|------|--------|----------|
| MDM Vendor Certificate | 1 年 | 在 Apple Developer 後台重新下載，上傳 `POST /api/mdm/certs/vendor` |
| APNS 推播憑證 | 1 年 | 重新走步驟 2b → 2c → 2d → 2e（**必須在 Apple Push Certificates Portal 用 Renew 而非 Create，且使用同一個 Apple ID**） |
| DEP Server Token | 1 年 | 在 ABM 中重新下載 token，上傳 `POST /api/mdm/dep/token` |
| CA 根憑證 | 10 年 | 自動生成，一般無需續期 |

**建議**：在日曆中設定提前 30 天的續期提醒。

---

## API 端點速查

### 憑證管理

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/mdm/certs/status` | GET | 查看所有憑證狀態 |
| `/api/mdm/certs/vendor/csr` | GET | 生成 Vendor CSR（供 Apple Developer 後台使用） |
| `/api/mdm/certs/vendor` | POST | 上傳 Vendor Certificate（.cer） |
| `/api/mdm/certs/apns/csr` | GET | 生成 APNS CSR |
| `/api/mdm/certs/apns/sign` | POST | 用 Vendor Cert 簽署 APNS CSR，下載 SignedCSR.plist |
| `/api/mdm/certs/apns` | POST | 上傳 Apple 簽發的推播憑證（.pem） |
| `/api/mdm/certs/ca/regenerate` | POST | 重新生成 CA 根憑證 |

### DEP / ADE

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/mdm/dep/pubkey` | GET | 下載 DEP 公鑰（供 ABM 上傳） |
| `/api/mdm/dep/token` | POST | 上傳 .p7m DEP token |
| `/api/mdm/dep/account` | GET | 查詢 DEP 帳戶資訊 |
| `/api/mdm/dep/devices` | GET | 列出 DEP 同步的裝置 |
| `/api/mdm/dep/sync` | POST | 手動觸發裝置同步 |
| `/api/mdm/dep/profile` | POST | 建立 ADE 描述檔 |
| `/api/mdm/dep/assign` | POST | 分配描述檔給裝置 |

### 裝置管理

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/mdm/devices` | GET | 列出所有 MDM 註冊裝置 |
| `/api/mdm/devices/:udid` | GET | 取得裝置詳情 |
| `/api/mdm/devices/:udid/command` | POST | 排入 MDM 命令（含 Lost Mode / App 派送） |
| `/api/mdm/devices/:udid/commands` | GET | 查詢命令歷史 |
| `/api/mdm/devices/:udid/push` | POST | APNS 推播喚醒裝置 |
| `/api/mdm/devices/:udid/app-lock` | POST | 啟用單 App 模式（動態 profile + InstallProfile） |
| `/api/mdm/devices/:udid/app-lock` | DELETE | 停用單 App 模式 |
| `/api/mdm/commands/bulk` | POST | 批次下發同一命令到多台裝置（併發 APNS 推播） |

### 遷移

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/mdm/migration/start` | POST | 建立遷移記錄 |
| `/api/mdm/migration/status` | GET | 查詢遷移狀態 |

### MDM 協議（裝置自動呼叫）

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/mdm/checkin` | PUT | 裝置簽入（Authenticate / TokenUpdate / CheckOut） |
| `/api/mdm/command` | PUT | 裝置拉取命令 / 回傳結果 |
| `/api/mdm/enroll` | GET/POST | ADE 註冊端點，回傳 .mobileconfig |
