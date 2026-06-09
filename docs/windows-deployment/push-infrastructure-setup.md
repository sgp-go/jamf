# Push 推送基礎設施自建 Playbook

> **適用對象**：台灣團隊後端工程師。
> **目的**：獨立部署環境從零自建 WNS 秒級推送整套資產。**這是生產部署的硬前提之一**——不自建則只能降級到 polling（分鐘級）下發命令。
> **前提**：已有一台 Windows 構建機（見 [build-machine-setup.md](build-machine-setup.md)）+ 後端已部署（見 [backend-deployment.md](../backend-deployment.md)）。

---

## 0. 為什麼必須自建（先讀）

秒級推送依賴一整套**互相綁定**的資產，全部綁某個 Microsoft Store 應用註冊：

```
Microsoft Store 應用註冊
   ├─ WNS_PACKAGE_SID    （WNS OAuth client_id）
   ├─ WNS_CLIENT_SECRET  （Azure App Registration 生成）
   ├─ WNS_PFN            （Package Family Name，燒進 PPKG 的 DMClient/Push/PFN）
   └─ push MSIX          （Identity Name + Publisher 必須與註冊值一致，否則 PFN 對不上）
          └─ push cert   （簽 MSIX 的自簽憑證，設備需信任才能 sideload）
```

**關鍵認知（兩條，務必理解）**：

1. **不可沿用開發環境（cogrow）的值**。`CLIENT_SECRET` 是應用綁定的私密憑據無法跨團隊共享；`PACKAGE_SID` 跟著應用走，WNS 按 SID 路由；git 倉庫裡的 `data/test/CogrowMDMPush-2.0.msix` 是按 cogrow 的 PFN/Publisher 簽的，PFN 對不上 WNS 就推不到設備。

2. **這套是「全域一套」，不是「每租戶/每校一套」**。push cert + MSIX + PFN + WNS 憑據是**帳號級**推送基礎設施，與租戶無關。所有租戶、所有學校的設備都裝**同一個** push MSIX、共用**同一套** WNS 憑據；設備靠各自唯一的 ChannelURI 區分，租戶隔離在後端業務層。**只需註冊一個 Store 應用、build 一個 push MSIX、一張 cert 全域共用**，切勿每校一套。

> push 不可用時系統不會壞——命令仍透過設備 SyncML polling 下發（分鐘級），只是失去秒級喚醒（遠端鎖定/抹機的即時性）。可先上線基本納管，push 後補。

---

## 1. 最終產出

| 產出 | 落地位置 | 說明 |
|------|---------|------|
| `WNS_PACKAGE_SID` | 後端 `.env` | `ms-app://S-1-15-2-...`（**必帶** `ms-app://` 前綴） |
| `WNS_CLIENT_SECRET` | 後端 `.env` | Azure 生成，**只顯示一次** |
| `WNS_PFN` | 後端 `.env` | 形如 `YourPublisher.YourApp_xxxxxxxxxxxxx` |
| `WNS_STORE_PRODUCT_ID` | 後端 `.env` | 偵錯用（選填） |
| push MSIX | 派發給設備（後端 enrollment hook 自動裝） | Identity 與註冊一致、含 IBackgroundTask DLL |
| push cert（`.cer` 公鑰） | 後端 `data/push-cert.cer` | **不入 git**；缺此檔則 push 自動配置被跳過 |

---

## 2. 流程全景

```
Step 1  註冊 Microsoft Store 應用 → 取 PACKAGE_SID / PFN / CLIENT_SECRET
            ↓
Step 2  構建機備妥工具鏈（makeappx/signtool/winmdexp/csc）  ← build-machine-setup.md
            ↓
Step 3  改 build-push-msix-v2.ps1 的 Identity → build 自己 PFN 的 push MSIX
            ↓
Step 4  生成 push cert（自簽）→ 公鑰 .cer 放後端 data/push-cert.cer
            ↓
Step 5  4 個 WNS 值寫進 .env → OAuth 換 token 驗證 → 重啟後端
            ↓
（之後）設備 enrollment 時，後端自動下發信任 cert + 裝 push MSIX + 配 channel（全自動）
```

---

## 3. Step 1：註冊 Microsoft Store 應用 + 取 WNS 憑據

完整步驟（含踩坑：唯一入口 `storedeveloper.microsoft.com`、Deactivated 處理、Package SID 加 `ms-app://` 前綴、Secret 只顯示一次）見：

> 📄 **[wns-account-setup.md](wns-account-setup.md)**（WNS 申請完整流程，本 Step 的細節展開）

精簡版 5 步：

1. **註冊開發者帳戶** — `https://storedeveloper.microsoft.com`（唯一入口，免費）。個人帳戶身份驗證分鐘級；公司帳戶 DUNS 驗證。
2. **Reserve App Name** — Partner Center → Apps and games → 取 Product ID。
3. **取 Package SID + PFN** — Product → Product Identity 頁複製。**Package SID 必須手動加 `ms-app://` 前綴**。
4. **取 Client Secret** — WNS/MPNS 頁 → App Registration portal → Azure Portal「證書和密碼」→ 新建客戶端密碼 → **立即複製（只顯示一次）**。
5. **記錄 4 個值** 備用（先別寫 .env，等 MSIX build 完一起驗）。

---

## 4. Step 2：構建機工具鏈

push MSIX 的 build 需要 `makeappx` / `signtool` / `WinMDExp.exe` / `csc` + 全套 contract winmd。環境準備見 [build-machine-setup.md](build-machine-setup.md) §3（push MSIX 工具鏈）。

---

## 5. Step 3：build 自己 PFN 的 push MSIX

倉庫已附現成腳本 **`docs/scripts/build-push-msix-v2.ps1`**（這版含 `IBackgroundTask` DLL，OS 才會把 raw push 路由到該 PFN——manifest-only 的 v1 收 push 後會丟棄，真機驗證不夠）。

### 5.1 改 Identity 為你的註冊值

編輯腳本頂部三個常數，改成 Step 1 註冊的值：

```powershell
$identityName = 'CoGrow.CogrowMDMPush'              # ← 改成你 Store 註冊的 Identity Name
$publisher    = 'CN=27397969-3D59-40F4-A9A2-...'    # ← 改成你的 Publisher（CN=...）
$publisherDN  = 'CoGrow'                            # ← 改成你的 Publisher 顯示名
```

> ⚠️ Identity Name + Publisher 必須**與 Microsoft Partner Center 註冊值完全一致**，否則算出的 PFN ≠ `WNS_PFN`，WNS 路由失敗。

### 5.2 驗證 PFN 一致性

用 `docs/scripts/get-pfn.ps1`（改成同樣的 `$identityName` / `$publisher`）算出 PFN，比對 Step 1 取到的 `WNS_PFN`，必須相等：

```powershell
# get-pfn.ps1：UTF-16LE → SHA-256 → first 8 bytes → custom base32 13 chars
powershell -File get-pfn.ps1
# 輸出 PFN: CoGrow.CogrowMDMPush_xxxxxxxxxxxxx  ← 應 == WNS_PFN
```

### 5.3 在構建機跑

```bash
# Mac 透過 SSH 跑（EncodedCommand 避引號問題）：
B64=$(python3 -c "import base64; print(base64.b64encode(open('docs/scripts/build-push-msix-v2.ps1','r').read().encode('utf-16-le')).decode())")
ssh <build-machine> "powershell -EncodedCommand $B64"
# 產出 C:\Temp\CogrowMDMPush-2.0.msix
```

### 5.4 build 踩坑（brain 實戰，按出現順序）

| 坑 | 症狀 | 解 |
|----|------|----|
| BITS 在 SSH session 0 跑不了 | `Start-BitsTransfer` 報 `0x800704DD`（BITS 是 per-user 服務，非交互 session 不可用） | 大檔下載回退 Mac `curl -C -` 續傳 + scp，或 IWR |
| PS 5.1 here-string + LF | Mac 寫的 .ps1 是 LF，PS 5.1 here-string 終止符解析錯 | scp 前 `perl -i -pe 's/\r?\n/\r\n/'` 轉 CRLF |
| macOS tar `._` 污染 | `tar czf *.winmd` 把 AppleDouble 資源叉 `._*.winmd` 打進去，csc 報 `CS0009 檔案已損壞` | 解壓後 `Remove-Item ._*`，或打包用 `COPYFILE_DISABLE=1` |
| winmd contracts 拆分 | `Windows.winmd` 只是門面，`IBackgroundTask` 等轉發到 contract winmd（`CS1070`） | csc + winmdexp `/reference` winmd 目錄下**全部** 95 個 contract winmd，不只 Windows.winmd |

---

## 6. Step 4：push cert（簽 MSIX 的憑證）

`build-push-msix-v2.ps1` 內含 cert 處理（`New-SelfSignedCertificate` 或重用既有 `.pfx`）。build 完取出**公鑰 `.cer`** 放後端：

```bash
# 從構建機取出公鑰
scp <build-machine>:/Temp/msix-push-cert.cer ./data/push-cert.cer
```

- 放在後端工作目錄的 `data/push-cert.cer`（代碼寫死此路徑：`app/services/mdm/windows/push-setup.ts`）
- **此檔不入 git**（已 gitignore）。缺檔則 enrollment 時 push 自動配置被靜默跳過。
- 後端會在設備 enrollment 時自動把這張 cert 透過 `RootCATrustedCertificates` CSP 下發到設備的 Root + TrustedPeople store，讓設備信任、可 sideload push MSIX（否則報 `0x800B0109 CERT_E_UNTRUSTEDROOT`）。

---

## 7. Step 5：寫 .env + 驗證

```bash
# 後端 .env
WNS_PACKAGE_SID=ms-app://S-1-15-2-...
WNS_CLIENT_SECRET=...
WNS_PFN=CoGrow.CogrowMDMPush_xxxxxxxxxxxxx
WNS_STORE_PRODUCT_ID=...
```

OAuth 換 token 驗證憑據有效（不依賴後端，直接打 WNS）：

```bash
curl -X POST "https://login.live.com/accesstoken.srf" \
  -d "grant_type=client_credentials" \
  -d "client_id=$WNS_PACKAGE_SID" \
  -d "client_secret=$WNS_CLIENT_SECRET" \
  -d "scope=notify.windows.com"
# 成功回 {"access_token":"...","token_type":"bearer","expires_in":86400}
# 失敗常見：invalid_client（SID/secret 錯或 secret 過期）
```

驗證通過 → 重啟後端（`systemctl restart cogrow-mdm` / `docker restart`）。

---

## 8. 上傳 push MSIX 到後端

push MSIX 與 Agent MSI 同走 apps 上傳機制，enrollment hook 自動派發。上傳方式見 [agent-app-build-and-deploy.md](agent-app-build-and-deploy.md) §3（同一套 `POST /admin/.../apps`）。

> 後端的 push MSIX 自動配置鏈（`setup-push`）會在設備 enrollment 時觸發，無需手動。

---

## 9. 註冊即自動配 push（設備端全自動）

配齊上述基礎設施後，設備端**完全自動**，IT/後端無需手動操作：

```
設備 enrollment 成功
  → enrollment hook 自動串：
    1. buildInstallTrustedCert：下發信任 push cert（Root + TrustedPeople 兩個 store）
    2. setupDevicePush：派 push MSIX install（Add + Exec HostedInstall）+ 密集 poll-config + 初始 inventory
    3. inventory 自愈循環：
         - MSIX 未就緒(installState≠0) + 無 channel → 續 inventory fetch
         - MSIX installState=0 + 無 channel → 自動 push-config（Replace Push/PFN + Get ChannelURI）
    4. 設備上報 ChannelURI 落庫 → WNS push 可用
```

> contentUri 用租戶的 `publicBaseUrl`（self_mdm_config），不用請求端 host——手動 curl localhost 會拿到 localhost，務必經正式域名觸發。

---

## 10. 驗證 push 鏈路打通

```bash
# 1. 設備 enrollment 後，等自愈循環跑完（看後端日誌）
#    應見：「push MSIX 未就緒,續 inventory fetch」(自愈×N) → 「push MSIX 已裝，自動配置 push channel」
#         → 「WNS ChannelURI 入庫: wns2-...」

# 2. 手動發一個 push 喚醒測試
curl -X POST https://mdm.your-domain.edu/api/mdm/win/devices/{udid}/push \
  -H "Authorization: Bearer $ADMIN_API_TOKEN"
# 後端日誌應見 wnsStatus=received；設備在 push 後數秒內 poll/執行命令

# 3. 若 device 尚未上報 ChannelURI，push 端點會回提示先 push-config
```

---

## 11. 維運

| 項目 | 說明 |
|------|------|
| **Secret 輪替** | `WNS_CLIENT_SECRET` 在 Azure 有有效期（建議每 6 個月輪替）。到期前在 Azure 新建 secret → 更新 .env → 重啟。舊 secret 失效前有重疊窗口。 |
| **限流** | 1000 台批量喚醒易撞 WNS per-app 配額。設 `WNS_PUSH_RATE_PER_SEC` / `WNS_PUSH_BURST` 從源頭限流（見 backend-deployment §2.3）。 |
| **PFN 永久綁定** | 一旦設備按某 PFN 註冊，換 PFN 需重配。push MSIX 換 Identity = 換 PFN，非必要勿動。 |

---

## 12. 故障排除速查

| 現象 | 根因 | 解 |
|------|------|----|
| OAuth `invalid_client` | SID/secret 錯或 secret 過期 | 核對 `ms-app://` 前綴；Azure 重生成 secret |
| MSIX sideload `0x800B0109` | 設備不信任 push cert | 確認 `data/push-cert.cer` 已放、enrollment 信任 cert 步驟成功 |
| push 發出但設備無反應 | PFN 不一致（MSIX Identity ≠ 註冊值） | `get-pfn.ps1` 重算比對 `WNS_PFN` |
| 後端日誌無 push 自動配置 | `data/push-cert.cer` 缺檔被跳過 | 放入 cert 後重新 enroll 或打 `/setup-push` |
| 命令一直 queued 但能 polling | push 通道掛了（管理通道走 polling 正常） | 查 ChannelURI 是否入庫；走 polling 不影響功能僅變慢 |
