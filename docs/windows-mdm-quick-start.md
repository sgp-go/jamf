# Windows MDM 快速上手（30 分鐘）

> 給新接手工程師。從 0 到「Win10 真機加入自建 MDM + 裝上 demo 應用 + inventory 反查」全流程。

## 前置條件

| 項目 | 要求 |
|---|---|
| 開發機 | macOS / Linux / Windows，裝 [Deno](https://deno.land) ≥ 1.40（含 `--unstable-http` 支援） |
| 公網暴露 | [ngrok](https://ngrok.com) 帳戶（免費版即可）或 Cloudflare Tunnel |
| 測試裝置 | Win10 22H2 / Win11 **x64** **Pro/Enterprise/Education**（**Home 不支援 MDM**）。<br>⚠️ **Win11 ARM64**（如 Apple Silicon UTM）裝不上 git 中的 x64 MSIX，需自行重 build ARM64 版（[scripts/README.md](./scripts/README.md)） |
| 帳戶配置 | `.env` 已配 WNS_PACKAGE_SID / WNS_CLIENT_SECRET / WNS_PFN（見 [windows-mdm-account-setup.md](./windows-mdm-account-setup.md)） |
| Demo MSIX | git 倉庫已附 3 個簽好的 demo MSIX 在 [`data/test/`](../data/test/)（install/update/push v2，全 x64），**無須自己 build** |
| 客戶端 SDK | **僅在重 build MSIX 或改源碼時需要**，純跑 demo / 演示**不需要** |

## 流程總覽

```
①  clone repo + .env 配好（含 WNS_PACKAGE_SID/CLIENT_SECRET/PFN）
②  deno task dev 起後端 + ngrok 暴露公網
③  客戶端首次準備：信任 cert + 開 sideload（5 行 PowerShell，第 3.1 步）
④  Win10/11 GUI 加入 MDM（第 3.2 步）
⑤  發 inventory query 驗證命令通道（第 4 步）
⑥  派送現成 demo MSIX install / update（第 5 步）
⑦  縮短 polling 到 5 min（第 6 步，B 路徑兜底）
⑧  裝 push MSIX + 配 push channel → 開啟秒級觸發（第 7 步，A 路徑）
⑨  驗證秒級 wipe：POST /wipe → ≤15s device 進 OOBE（第 8 步）
```

> 第 7-8 步是**演示重點**：enrollment 完只能拉模型（B 路徑 polling，最快 5 min）；
> 要做「立即推送」演示（如緊急 wipe ≤15s 生效）必須走 A 路徑 WNS push。

---

## 第 1 步：起後端

```bash
git clone <repo> jamf_explore && cd jamf_explore
cp .env.example .env  # 填寫 WNS_* 凭据等
deno task dev          # 起在 http://localhost:3000
```

**驗證**：
```bash
curl http://localhost:3000/api/mdm/win/devices
# 預期 {"devices":[]}（空列表，正常）
```

## 第 2 步：暴露公網

開發期推薦 ngrok：
```bash
ngrok http 3000 --request-header-remove="Accept-Encoding"
```

拿到 URL 如 `https://succinctly-ashless-thuy.ngrok-free.dev`。

> ⚠️ ngrok URL 每次重啟可能變。Win10 enrollment 時記住的是當時的 URL，若 ngrok URL 變化舊 enrollment 會失效。生產環境用固定域名（見 [windows-mdm-production-deployment.md](./windows-mdm-production-deployment.md)）。

## 第 3 步：客戶端首次準備 + 加入 MDM

### 3.1 客戶端裝置首次準備（**必跑，否則 install 會卡**）

在客戶端 Win10/11 開**管理員 PowerShell**，跑這段（安裝公鑰 cert + 開 sideload + DevMode）：

```powershell
# 假設專案 clone 在 D:\jamf_explore，根據實際路徑調整
$repo = "D:\jamf_explore"
Import-Certificate -FilePath "$repo\data\test\AspiraCert.cer" -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath "$repo\data\test\AspiraCert.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople

$p = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
if (-not (Test-Path $p)) { New-Item $p -Force | Out-Null }
New-ItemProperty $p -Name AllowDevelopmentWithoutDevLicense -Value 1 -PropertyType DWORD -Force
New-ItemProperty $p -Name AllowAllTrustedApps              -Value 1 -PropertyType DWORD -Force
```

不跑會卡：
- `0x800B0109 CERT_E_UNTRUSTEDROOT`（cert 沒裝）
- `0x80070005 拒絕存取`（Win11 24H2 sideload 沒開）

> 如果客戶端沒法直接讀到專案目錄，把 `data/test/AspiraCert.cer` 拷到客戶端任意目錄再 `Import-Certificate`。
>
> 演示秒級推送（§7）時還需要裝**自家 build 的 push MSIX 對應的 publisher cert**——那個 cert 從接手自己 build 的 push .msix 提取（不在 git 中），裝法相同。

### 3.2 GUI enrollment

詳細操作見 [windows-mdm-enrollment-guide.md](./windows-mdm-enrollment-guide.md) 第 2 步。簡版：

設定 → 帳戶 → **存取公司或學校資源** → 鏈接工作或學校帳戶 → **僅註冊到設備管理**（右欄選項，不是「加入」）→ 任意郵箱 → enrollment URL 填：
```
https://<ngrok-url>/EnrollmentServer/Discovery.svc
```

接下來會彈 username/password 框（OnPremise auth，後端不驗證），任意填：`jay` / `1234` 之類即可。

成功後 GUI 顯示「已連接到 Aspira-XXX MDM」。後端 log 會看到：
```
[Win MDM] Enrolled: deviceId=... udid=windows-...
```

## 第 4 步：發 inventory query 驗證命令通道

```bash
UDID=$(curl -s http://localhost:3000/api/mdm/win/devices | jq -r '.devices[0].udid')
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/refresh
```

**等 device 自動 poll**（默認 5-60 分鐘，第一次 enrollment 後通常更快）。

驗證：
```bash
sqlite3 data/agent_reports.db "SELECT COUNT(*) FROM mdm_windows_apps WHERE device_udid='$UDID';"
# 預期 80+ 條應用記錄
```

> 如果遲遲拿不到應用清單：發 `/poll-config` 把 polling 縮短到 5 分鐘（見 第 6 步）。

## 第 5 步：派送 demo MSIX 安裝

### 5.1 用 git 中現成的 demo MSIX（推薦）

git 倉庫 [`data/test/`](../data/test/) 已附 2 個簽好的 demo MSIX：

| 檔案 | 用途 | 接手是否要重 build |
|---|---|---|
| `AspiraMdmDemo-1.0.msix` | install 演示 | ❌ 沿用 git |
| `AspiraMdmDemo-2.0.msix` | update 演示（同 PFN，version 2） | ❌ 沿用 git |

> ✅ install / update 兩個 MSIX **接手可直接沿用** git 中現成的——它們走 LOB sideload，OS 只校驗 publisher cert chain（裝 `AspiraCert.cer` 即可），**與 Microsoft Store / Azure 註冊無關**。任何 device 裝 cert 後都能 install。
>
> ⚠️ push 演示用的 push MSIX **不在 git 中、必須接手自己 build**（見 §7.1）—— PFN 綁 Microsoft Store 應用註冊，跨團隊不可共享。

Deno 後端會自動把 `data/test/` host 在 `/test/<filename>`，client 可直接下載。接手自己 build 的 push MSIX 也放這個目錄即可被 host。

### 5.2 派送 install

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageFamilyName": "AspiraMDM.Demo_cmnaf4m6btwng",
    "contentUri": "https://<ngrok-url>/test/AspiraMdmDemo-1.0.msix"
  }'
```

device 拉到後在開始選單會出現「Aspira MDM Demo」應用（藍色圖示），跑起來會彈 `Hello from MDM HostedInstall! v1.0` 對話框。

### 5.3 派送 update

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/update \
  -H "Content-Type: application/json" \
  -d '{
    "packageFamilyName": "AspiraMDM.Demo_cmnaf4m6btwng",
    "contentUri": "https://<ngrok-url>/test/AspiraMdmDemo-2.0.msix"
  }'
```

升級成功後再開應用會看到 `v2.0` 字樣。

### 5.4 想自己改源碼 / 重 build？

完整 build 流程（含改 manifest、cert 規範、ARM64 重簽）在 [`docs/scripts/README.md`](./scripts/README.md)。
**注意 Win11 ARM64 必須重 build ARM64 版**（git 中現成 MSIX 是 x64，ARM 上會 `0x80070005`）。

## 第 6 步：縮短 polling 間隔（可選但推薦）

默認 polling 8 小時太久。改 5 分鐘密集 + 15 分鐘穩態：

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/poll-config \
  -H "Content-Type: application/json" \
  -d '{"intervalFirst":5,"countFirst":8,"intervalRest":15}'
```

device 套用後**最遲 5 分鐘內自動 poll**，再也不用手動同步。

## 第 7 步：開啟 WNS 秒級推送（演示必備）

⚠️ **這是演示「立即推送」的必要步驟**。enrollment 完只能走 polling（B 路徑），最快 5 min；要 ≤15s 生效必須走 WNS push（A 路徑）。

### 7.0 前置確認

`.env` 必須配齊（見 [account-setup.md](./windows-mdm-account-setup.md) 怎麼申請）：
```bash
WNS_PACKAGE_SID=ms-app://<your-package-sid>
WNS_CLIENT_SECRET=<your-client-secret>
WNS_PFN=<your-pfn>
WNS_STORE_PRODUCT_ID=<your-store-product-id>
```

> ⚠️ 接手團隊**必須註冊自己的 Microsoft Store / Azure AD 應用**取得這 4 個值。不能沿用本 repo 歷史中的 demo 值（CLIENT_SECRET 已輪替；其他值跟著應用註冊綁定無法跨團隊共享）。

驗證：
```bash
grep -E "^WNS_" .env | wc -l   # 期望 4
```

### 7.1 派送 push-capable MSIX（先裝，後配）

WNS push 需要客戶端**先有一個 push 接收器**（manifest 含 `pushNotification` BG Task 的 MSIX），OS 才會調 `CreatePushChannel` 拿 ChannelURI。

> ⚠️ **push MSIX 不在 git 中**（PFN 綁 cogrow Microsoft Store 註冊跨團隊不可共享）。接手必須自行 build，跟完整 6 步：[`scripts/README.md` §接手：替換為你自己的應用標識](./scripts/README.md#接手替換為你自己的應用標識生產--獨立部署必做)（含改 `build-push-msix-v2.ps1` 三個變數、跑 build、驗 PFN、scp 拉回 `data/test/`）。

下面用 `<your-pfn>` 代表接手自家 push MSIX 的 PFN：

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageFamilyName": "<your-pfn>",
    "contentUri": "https://<ngrok-url>/test/<your-push-msix-filename>.msix"
  }'
```

> ⚠️ 必須用 **v2 級別**的 push MSIX（含真實 `IBackgroundTask` DLL）。v1 manifest 寫了 BG Task 但**沒實作 DLL**，OS 收 push 後找不到 PushHandler class 會丟棄消息。本 repo 的 `build-push-msix-v2.ps1` 是 v2 範本。
>
> ⚠️ PFN 必須**逐字符**等於 `.env` 的 `WNS_PFN`，否則 WNS 不路由消息到該 PFN。

**等 install 完成**（5 min polling 內，第 6 步配過 5 min 的話）。驗證：

```bash
sqlite3 data/agent_reports.db "
  SELECT package_family_name, version, install_state
  FROM mdm_windows_apps
  WHERE device_udid='$UDID' AND package_family_name='<your-pfn>';
"
# 預期：<your-pfn> | 2.0.0.0 | 0
```

`install_state=0` 表示成功裝上。

> 💡 **加速等待**：每次 `POST /apps/install`、`/push-config`、`/poll-config` 後，讓 device 上的人在「設定 → 帳戶 → 存取公司或學校資源 → MDM 條目 → 資訊 → 同步」**點一下「同步」按鈕**，命令立即被拉走執行，不必等下次 polling。第 7-8 步全程都可以用這招把 5 min 等待壓成秒級。

### 7.2 配 push channel

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/push-config \
  -H "Content-Type: application/json" -d '{}'
```

這會 enqueue 一條 OMA-DM `Replace ./Vendor/MSFT/DMClient/.../Push/PFN` 命令告訴 device「用這個 PFN 註冊 push channel」。

### 7.3 等 device 上報 ChannelURI

device 下次 sync 後會：
1. 套用 PFN 配置
2. 調 `PushNotificationChannelManager.CreatePushNotificationChannelForApplicationAsync(PFN)` 拿 ChannelURI
3. 通過 OMA-DM `Replace ./.../Push/ChannelURI` 把 URI 上報給服務端

**驗證入庫**：
```bash
sqlite3 data/agent_reports.db "
  SELECT wns_channel_uri, wns_channel_expiry
  FROM mdm_devices WHERE udid='$UDID';
"
# 預期：https://wns2-xxx.notify.windows.com/?token=... | <未來時間戳>
```

如果 `wns_channel_uri` 仍是 NULL，等下一次 polling，或**立即觸發 device sync**（兩種方式都行，演示推薦用方式 A）：

**方式 A：在 device GUI 點「同步」（演示推薦）**

```
設定 → 帳戶 → 存取公司或學校資源 → 點選已連接的 MDM 條目
  → 資訊 (Info) → 滾到下方 → 【同步 (Sync)】按鈕
```

按下後幾秒內觸發 OMA-DM session，命令立即拉走。**演示時讓客戶看到「設備與雲端同步」是合理的標準動作**，不會破壞演示節奏。

**方式 B：PowerShell 觸發（自動化 / SSH 場景）**

```powershell
Get-ScheduledTask -TaskPath "\Microsoft\Windows\EnterpriseMgmt\*" |
  Where-Object TaskName -match OMADMClient |
  Start-ScheduledTask
```

兩種方式底層都是調 OMA-DM client 立即 sync，等價。

### 7.4 之後一切 enqueue 自動 push

ChannelURI 入庫後，後端 `enqueueWindowsCommand`（M4 機制，commit `cef10c7`）會**自動**對 push 路徑可用的 device 發 WNS push。也可以手動測：

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/push -d '{}'
```

預期後端 log：
```
[WNS] push sent: notificationStatus=received, deviceConnectionStatus=connected
[Win MDM] Device <id> 觸發 1206 (ServerInitiated)   ← 6-9s 後出現
```

`1206` = WNS 觸發的 OMA-DM session。看到 1206 = push 路徑成功。

## 第 8 步：演示秒級 wipe（端到端驗證）

打開兩個終端：

**終端 A**（盯後端日誌 + 計時）：
```bash
tail -f /tmp/deno-mdm.log | grep -E "Device $UDID|RemoteWipe|1206|WNS"
```

**終端 B**（觸發 wipe）：
```bash
date "+%H:%M:%S.%N"   # 記錄起點
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/wipe \
  -H "Content-Type: application/json" \
  -d '{"action":"doWipeProtected"}'
```

預期看到的時間線（A 路徑 push）：
```
T+0.0s   curl 返回 200 + commandUuid
T+0.5s   後端 [Win MDM] 命令已排入: ... type=RemoteWipe
T+0.5s   後端 [WNS] push sent
T+6-9s   device 觸發 1206
T+7-10s  後端 [Win MDM] 發送命令: ... csp=./Device/.../RemoteWipe/doWipeProtected
T+10-15s device 螢幕：「正在重設這部電腦」
```

對比 B 路徑（沒裝 push MSIX）：
```
T+0.0s   curl 返回 200
T+0-5min device 等下次 polling 才拉到
T+5-15min device 螢幕：「正在重設這部電腦」
```

完整觸發機制見 [windows-mdm-trigger-mechanism.md](./windows-mdm-trigger-mechanism.md)。

---

## 下一步閱讀

| 場景 | 文檔 |
|---|---|
| 「我要呼叫某個 API」 | [windows-mdm-api-reference.md](./windows-mdm-api-reference.md) |
| 「device 為什麼遲遲不拉命令」 | [windows-mdm-trigger-mechanism.md](./windows-mdm-trigger-mechanism.md) |
| 「上線到生產環境」 | [windows-mdm-production-deployment.md](./windows-mdm-production-deployment.md) |
| 「遇到 404/405/500/E_INVALIDARG」 | [windows-mdm-troubleshooting.md](./windows-mdm-troubleshooting.md) |
| 「DB 各個欄位什麼意思」 | [windows-mdm-data-model.md](./windows-mdm-data-model.md) |
| 「MSIX 為什麼裝不上」 | [windows-mdm-msix-signing.md](./windows-mdm-msix-signing.md) |
