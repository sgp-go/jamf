# Windows MDM 帳戶註冊與 WNS 配置指南

> 📌 **本文自 `docs/archived/windows-mdm-account-setup.md` 遷入**——帳戶註冊 / WNS 憑據取得流程與租戶無關，**生產仍完全適用**。push 自建總流程見 [push-infrastructure-setup.md](push-infrastructure-setup.md)，本文是其 Step 1 的細節展開。
>
> ⚠️ 文中出現的 `cogrow` / demo 應用標識僅為範例；接手團隊**必須註冊自己的 Store 應用**，不可沿用。

> 本文記錄自建 Windows MDM 服務所需的 Microsoft 帳戶註冊、WNS 推播憑證取得，以及踩坑經驗。供日後維運（Secret 輪替、換帳戶、新環境部署）參考。

## 最終產出

寫進 `.env` 的四個值（範例見 `.env.example`）：

```bash
WNS_PACKAGE_SID=ms-app://<your-package-sid>
WNS_CLIENT_SECRET=<your-client-secret>    # 只在 Azure 建立瞬間顯示一次，過了就要重新生成
WNS_PFN=<your-pfn>                        # 形如 CoGrow.CogrowMDMPush_r2dv7jx02rjxr
WNS_STORE_PRODUCT_ID=<your-store-product-id>
```

> ⚠️ **接手團隊必須註冊自己的 Microsoft Store / Azure AD 應用**，**不能沿用本 repo 的 demo 值**。原因：
> - `CLIENT_SECRET` 屬於應用註冊綁定的私密憑據，無法跨團隊共享
> - `PACKAGE_SID` 跟著應用走，WNS 推送會根據 SID 路由到對應應用
> - **連帶：git 中的 `data/test/CogrowMDMPush-2.0.msix` 是按本 demo 的 PFN/Publisher 簽的，接手團隊做 push 演示時必須重 build 自己 PFN 的 push MSIX**（install 演示不受影響）
>
> 接手第 1 週優先做完整套註冊（見 [production-deployment §13 P1 #4](../archived/windows-mdm-production-deployment.md#13-待實現項清單)）。

| 變數 | 用途 |
|------|------|
| `WNS_PACKAGE_SID` | WNS OAuth `client_id`（**必須**帶 `ms-app://` 前綴） |
| `WNS_CLIENT_SECRET` | WNS OAuth `client_secret`（從 Azure App Registration 生成，**只看一次**） |
| `WNS_PFN` | Package Family Name，寫入 `.ppkg` 的 `DMClient/Push/PFN`，讓設備接受該應用發出的推播 |
| `WNS_STORE_PRODUCT_ID` | Partner Center Product ID，偵錯與聯繫支援時帶上 |

## 前置需求

- **HTTPS 後端域名**（公開 CA TLS 證書，Let's Encrypt 即可）
- **Windows 11 Pro / Enterprise / Education**（Home 版不支援 MDM）
- **乾淨的 Microsoft 帳戶（MSA）**：建議用一個未曾加入企業 Azure AD / Entra ID 租戶的帳戶。本案實際用的是 `appledev@jinsehua.com.cn`（公司域名 MSA），運作正常。

---

## 流程總覽

```
1. 註冊 Microsoft Store 開發者帳戶  ── storedeveloper.microsoft.com（免費）
       ↓
2. Partner Center 自動 provision「Apps and games」工作區
       ↓
3. Reserve App Name → 取 Product ID
       ↓
4. Product Identity 取 Package SID + Package Family Name
       ↓
5. WNS/MPNS 頁 → App Registration portal → Azure Portal
       ↓
6. Azure Portal「證書和密碼」→ 新建客戶端密碼 → 立即複製
       ↓
7. 寫入 .env，OAuth 換 token 驗證
```

---

## 第 1 步：註冊 Microsoft Store 開發者帳戶

### 入口：`storedeveloper.microsoft.com`（這是唯一支援的入口）

| ❌ 走錯入口 | ✅ 正確入口 |
|------------|------------|
| `partner.microsoft.com/zh-CN/`（推 Microsoft AI Cloud Partner Program，與發布應用無關） | **`storedeveloper.microsoft.com`** |
| 後果：可能進入舊版收費流程，且不會解鎖 Apps and games 工作區 | 2026 起官方唯一支援的零費用入口 |

### 帳戶類型

| 類型 | 驗證方式 | 通過時間 | 注冊費 |
|------|---------|---------|------|
| **個人開發者** | 政府身份證 + 自拍 | 通常幾秒到 1 分鐘 | **免費** |
| **公司帳戶** | DUNS 號碼（建議）/ 公司證件 + 域名工作信箱 | DUNS 自動驗證分鐘級；文件人工審核 3-5 工作日 | **免費** |

### 步驟

1. 開 `https://storedeveloper.microsoft.com`
2. 點藍色「Get started」
3. 選帳戶類型 → 走完 4 步：① Account type → ② Identity verification → ③ Profile details → ④ Account setup
4. 完成後會收到兩封郵件：
   - "We've successfully verified your Partner Center profile information"
   - "Your Windows Dev Center account is ready"，含 `publisher name`

### ⚠️ 遇到 Deactivated 怎麼辦

**症狀**：登入 `partner.microsoft.com/dashboard` 後只看到「我的訪問權限」，沒有「Apps and games」；直接訪問 `/dashboard/apps-and-games/overview` 跳到 `restrictedaccess?reason=Deactivated`。

**確認事實**：Microsoft Q&A 上 2025 年起此症狀密集出現，社群案例幾乎全部需要人工激活。

**處理**：
- 寄信到 **`storesupport@service.microsoft.com`**，附 publisher 名 + correlation ID + 兩封確認郵件截圖
- 主旨：`New individual developer onboarding - Account Deactivated immediately after verification`
- 首響 1-3 工作日，完整解決 3-10 工作日
- **本案紀錄**：先用 `dabuddha@126.com` 註冊遭遇 Deactivated（中國 IP + 中國郵箱風控），改用乾淨的 `appledev@jinsehua.com.cn` 重新註冊後正常通過

**絕對不要做**：
- ❌ 重複註冊新 MSA（風控判定會更糟）
- ❌ 點「使用 Microsoft Entra ID 登入」（個人開發者不需要 Entra ID，誤點會脫鉤 publisher）
- ❌ 在 `partner.microsoft.com` 點「立即加入合作夥伴計畫」（那是 AI Cloud Partner Program，與發布應用無關）

---

## 第 2 步：建立應用佔位（取 Package SID 用）

確認登入 `partner.microsoft.com/en-us/dashboard/apps-and-games/overview` 能看到「Apps and games | Overview」頁面：

![Apps and games 工作區](./images/wns-apps-and-games.png)

### 步驟

1. 點頂部「**+ New product**」按鈕
2. 在彈出選單選 **MSIX or PWA app**（**必須**——只有這個類型能取得 Package SID 與 PFN，EXE/MSI 與 Game 都不行）

   ![Product type 選單](./images/wns-new-product-menu.png)

3. 在「Create your app by reserving a name」對話框輸入應用名（**保留 3 個月，不上架不收費，名字會成為 PFN 前綴的一部分，建議獨特易識別**）

   ![Reserve dialog](./images/wns-reserve-dialog.png)

4. 點 **Check availability** 確認名稱可用（綠色 ✓）

   ![Check availability](./images/wns-check-availability.png)

5. 點 **Reserve product name** 提交。提交後若彈「Sign in required - Your session has expired」，點 **Sign in** 重新登入即可（應用其實已建好，URL 會自動帶上 Product ID）

### 本案結果

- **應用名**：`CogrowMDMPush`
- **Product ID**：`9N9MPHFLQNXB`
- **狀態**：Not started（永遠不會上架，只取 SID/PFN/Secret）

---

## 第 3 步：取 Package SID 與 Package Family Name

### 路徑

進入剛建立的應用詳情頁，URL 為 `/dashboard/products/<Product ID>/overview`：

![App overview 左欄](./images/wns-app-overview.png)

點左欄 **Product management → Product Identity**（直連 URL：`/dashboard/products/<Product ID>/identity`）：

![Product identity 頁面](./images/wns-identity.png)

### 取值

頁面會列出多個值，與 WNS 相關的是：

| 標籤 | 範例值 | 用途 |
|------|--------|------|
| **Package Family Name (PFN)** | `CoGrow.CogrowMDMPush_r2dv7jx02rjxr` | 寫進 `.ppkg DMClient/Push/PFN` |
| **Package SID** | `S-1-15-2-1253093273-833848983-1416962196-...` | WNS OAuth `client_id` |

### ⚠️ 關鍵坑：Package SID 必須加 `ms-app://` 前綴

頁面顯示的是裸 SID（`S-1-15-2-...`），**WNS OAuth 用的 `client_id` 必須是完整 URI 形式**：

```
ms-app://S-1-15-2-1253093273-833848983-1416962196-922505673-1233200576-2981719577-3762432075
```

少了前綴會回 `invalid_client`。

---

## 第 4 步：取 WNS Client Secret（在 Azure Portal）

### 進入 WNS/MPNS 頁

仍在應用詳情頁，左欄 **Product management → WNS/MPNS**（直連 URL：`/dashboard/apps/<Product ID>/pushnotifications`）：

![WNS/MPNS 頁面](./images/wns-partner-push-page.png)

頁面文字會引導你去「**App Registration portal**」連結 → 跳轉到 Azure Portal 的 App Registration 詳情頁，appId 已預填。

### Azure Portal 登入

> ⚠️ Azure Portal 與 Partner Center 是**獨立的 SSO**——即使 Partner Center 已登入，Azure Portal 仍會要求登入。

帳戶選擇器若列出多個帳戶，**必須選與 Partner Center 同一個帳戶**（本案：`appledev@jinsehua.com.cn`）。選錯帳戶會找不到對應的 App Registration。

![Azure 登入帳戶選擇](./images/wns-azure-login.png)

### 進入「證書和密碼」

直連 URL（替換 appId）：

```
https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Credentials/appId/<MSA-app-id>/isMSAApp~/true
```

`<MSA-app-id>` 在 Partner Center 的 Product Identity 頁底部「MSA app id」欄位。本案是 `98236c7d-c812-4294-b9b4-5c0d7f15bf5e`。

進入後預設在「客戶端密碼」分頁：

![Azure 客戶端密碼空](./images/wns-azure-secrets-empty.png)

### 新建客戶端密碼

1. 點 **+ 新客戶端密碼**

   ![新增 secret 對話框](./images/wns-azure-add-secret-dialog.png)

2. 填入「說明」（建議寫用途，例如 `WNS push for Cogrow MDM`）
3. 「截止期限」**MSA app 受限只能 180 天（6 個月）**——到期前必須輪替，否則 WNS 推播會回 `invalid_client`，建議在日曆上設提醒
4. 點 **添加**

### ⚠️⚠️ Secret 只顯示一次

新增後會立刻在表格顯示一行新 secret，**「值」欄位明文顯示一次**——**立即複製並寫進 `.env`**。一旦離開或刷新頁面，「值」永遠變成 `✱✱✱`，要重新生成新的 secret。

| 欄位 | 範例值 | 何時可取 |
|------|--------|---------|
| 說明 | `WNS push for Cogrow MDM (jamf_explore)` | 永久 |
| 截止期限 | `2026-11-02`（180 天後） | 永久 |
| **值** | `<your-client-secret-here-only-shown-once-on-creation>` | **僅本次顯示** |
| 機密 ID | `77191dbb-b865-48d9-811f-c70938e0892d` | 永久 |

---

## 第 5 步：寫入 `.env` 並驗證

### 寫入

```bash
# .env（接手團隊請替換成自己註冊應用的值）
WNS_PACKAGE_SID=ms-app://<your-package-sid>
WNS_CLIENT_SECRET=<your-client-secret>
WNS_PFN=<your-pfn>
WNS_STORE_PRODUCT_ID=<your-store-product-id>
```

### OAuth 換 token 驗證

```bash
source .env
curl -sS -X POST "https://login.live.com/accesstoken.srf" \
  -d "grant_type=client_credentials" \
  --data-urlencode "client_id=$WNS_PACKAGE_SID" \
  --data-urlencode "client_secret=$WNS_CLIENT_SECRET" \
  -d "scope=notify.windows.com"
```

**成功回應**：

```json
{
  "token_type": "bearer",
  "access_token": "EgCdAQMAAAAMgAAAwQAB...",
  "expires_in": 86400
}
```

`access_token` TTL 86400 秒（24 小時），後端 cache 即可。每次推送在 `Authorization: Bearer <token>` 標頭帶上。

### 常見錯誤對照

| 錯誤回應 | 原因 | 解法 |
|---------|------|------|
| `invalid_client` | SID 沒加 `ms-app://` 前綴 / Secret 拼錯或過期 | 檢查 SID 完整 URI 形式；Secret 過期則重新生成 |
| `invalid_scope` | scope 拼錯 | 必須是 `notify.windows.com`（不要加 `/v3` 之類） |
| `invalid_request` | client_id 沒 URL-encode | 用 `--data-urlencode` |
| `unauthorized_client` | Secret 過期 / 應用被停用 | 重新生成 Secret 或檢查 App Registration 狀態 |

---

## 第 6 步：將 PFN 寫進 `.ppkg`

在自建 MDM 的 enrollment 回應 `wap-provisioningdoc` 中加入：

```xml
<characteristic type="DMClient">
  <characteristic type="Provider">
    <characteristic type="MS DM Server">
      <characteristic type="Push">
        <parm name="PFN" value="CoGrow.CogrowMDMPush_r2dv7jx02rjxr" datatype="string"/>
      </characteristic>
    </characteristic>
  </characteristic>
</characteristic>
```

設備收到後會註冊 WNS Channel URI 並透過 SyncML 上報給後端，後端寫入 `mdm_devices.wns_channel_uri`。之後管理員下命令 → 後端對該 ChannelURI 發 raw notification → 設備立即拉命令。

---

## 開發期替代：不用 WNS 也能跑

WNS 憑證未到位時，可在 enrollment 的 `wap-provisioningdoc` 中設置輪詢，命令延遲 ≤ 1 分鐘：

```xml
<characteristic type="Poll">
  <parm name="NumberOfFirstRetries" value="5" datatype="integer"/>
  <parm name="IntervalForFirstSetOfRetries" value="1" datatype="integer"/>      <!-- 1 分鐘 -->
  <parm name="NumberOfSecondRetries" value="10" datatype="integer"/>
  <parm name="IntervalForSecondSetOfRetries" value="5" datatype="integer"/>     <!-- 5 分鐘 -->
  <parm name="IntervalForRemainingScheduledRetries" value="60" datatype="integer"/>
  <parm name="PollOnLogin" value="true" datatype="boolean"/>
</characteristic>
```

WNS 取得後可隨時補上，不破壞架構。

---

## 維運：Secret 輪替（每 6 個月）

MSA app 的 client secret 最長 180 天。到期前 7 天建議：

1. 登入 Azure Portal「證書和密碼」頁（直連 URL 同第 4 步）
2. 點「+ 新客戶端密碼」生成新 secret
3. **同時保留舊 secret 至少 24 小時**（避免在輪替的縫隙裡推播失敗）
4. 將新 secret 寫進 `.env` 並 deploy 後端
5. 後端切換成功（觀察 24h 無 invalid_client 錯誤）後，回 Azure 刪除舊 secret

---

## 故障排除速查

| 症狀 | 可能原因 | 處理 |
|------|---------|------|
| Dashboard 主頁無 Apps and games 工作區 | Provisioning 未完成 / Deactivated | 等 24h 或寄 storesupport |
| `/dashboard/products/new` → Not authorized | 帳戶 Deactivated | 同上 |
| `/dashboard/apps-and-games/overview` → restrictedaccess?reason=Deactivated | 帳戶被風控標記 | 寄 storesupport 附截圖 |
| 「我的訪問權限 → 用戶管理」要求 Entra ID | 個人開發者本不需此頁 | 忽略，**勿點 Entra ID 登入** |
| Reserve product name 後彈 "Sign in required" | Session 過期 | 點 Sign in，應用其實已建好 |
| Azure Portal 登入後找不到 App Registration | 登入了錯的帳戶 | 用與 Partner Center 同一帳戶登入 |
| WNS OAuth 回 `invalid_client` | SID 缺前綴 / Secret 過期 | 檢查 ms-app:// 前綴；輪替 secret |
| WNS 推送回 410 Gone | Channel URI 失效（30 天） | 等設備自動重新上報，後端被動更新 |

---

## 參考

- [Free developer registration for individual developers](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer)
- [Free developer registration for company developers](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-company-developer)
- [Reserve your MSIX app's name](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name)
- [Push notification service request and response headers (WNS)](https://learn.microsoft.com/en-us/previous-versions/windows/apps/hh465435)
- [Partner Portal Access Restricted Deactivated（社群案例）](https://learn.microsoft.com/en-us/answers/questions/3866901/partner-portal-access-restricted-deactivated)
