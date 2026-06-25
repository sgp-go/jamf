# Windows 電腦初始化配置指南（給台灣團隊 → IT 團隊）

> ⚠️ **正式生產交付文件**（區別於 `docs/` 下的 demo/探索文件）。本文規則由我方制定。
>
> **文件目的**：指導學校 IT 團隊把採購的 Windows 電腦批量初始化成「學生標準帳號 + 自動納管 MDM + 防脫離」的標準狀態。
> **適用對象**：台灣團隊（規劃 / 對接）+ 學校 IT 執行人員。
> **適用系統**：Windows 10 / 11 **Pro / Enterprise / Education**（**Home 版不支援 MDM，不可用**）。

---

## 0. 核心觀念（先讀，避免走錯路）

1. **PPKG（Provisioning Package，預配套件）是初始化的核心載體**：一個 `.ppkg` 檔案可一次完成「連 WiFi（必填）+ 建本機帳號 + 跳 OOBE 帳號類型頁 + 納管進 MDM + 強制學生首次改密」。透過 USB 在開機設定階段（OOBE）套用。
2. **PPKG 是「疊加」配置，不能刪除設備上已有的管理員帳號**：所以已被人用過、已有管理員的設備，必須先「重置」回到乾淨狀態，才能套用 PPKG。
3. **防學生脫離 MDM 的根本是「學生用標準帳號」**：管理員權限可以繞過任何 MDM 策略（移除預配套件、改註冊表、刪註冊資訊）。禁手動註銷等策略只對標準帳號有效。**學生絕不可給管理員帳號。**
4. **本方案無 Windows Autopilot**（需 Intune + Azure AD）：所以批量配置**必須有人工介入**（插 USB 或刷映像），做不到「開機連網全自動零接觸」。

---

## 1. 整體流程總覽

```
┌─ 設備到手 ─┐
│            │
│  判斷狀態   │
└─────┬──────┘
      │
   ┌──┴───────────────────────┐
   │                          │
全新（在 OOBE）            已激活 / 已有管理員
   │                          │
   │                    先「重置此電腦」回到 OOBE
   │                          │
   └──────────┬───────────────┘
              │
        OOBE 階段插 USB 套用 PPKG
              │
   自動：連 WiFi → 建學生標準帳號 → 納管 MDM → 跳 OOBE → 學生首次登入改密
              │
   後端自動：禁手動註銷 + 配 push 推送通道
              │
        進入桌面（學生標準帳號，開箱即用）
              │
        IT 補：BIOS 鎖 + BitLocker（防重裝/拆盤）
```

---

## 1.5 新租戶初始化（台灣團隊後端操作，每校一次）

每個學校（租戶）首次使用前，需完成以下初始化：

```bash
# 1. 建立租戶
curl -X POST /api/v1/admin/tenants \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"slug": "school-a", "displayName": "A 學校"}'
# → 記下 tenantId

# 2. 初始化 MDM 配置（自動生成 CA 根憑證）
curl -X POST /api/v1/admin/tenants/{tenantId}/mdm-config \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"publicBaseUrl": "https://mdm.school-a.edu"}'

# 3. （選填）設定文件下載走校內 LAN
curl -X PATCH /api/v1/admin/tenants/{tenantId}/mdm-config \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"appDownloadBaseUrl": "http://192.168.1.100:3000"}'

# 4. 上傳 Agent MSI（詳見 agent-app-build-and-deploy.md）
curl -X POST /api/v1/admin/tenants/{tenantId}/apps \
  -F "file=@CoGrowMDMAgent.msi" \
  -F "displayName=CoGrow MDM Agent" \
  -F "version=1.3.12.0" \
  -F "bundleId={176848CB-7917-4829-B158-F18F7585B7DA}"
```

完成後即可生成 PPKG、接受設備 enrollment。

> ⚠️ `POST /mdm-config` 會自動生成 per-tenant CA 根憑證（10 年有效期）。無需手動建立 CA。
> PPKG 裡的 DiscoveryUrl 會自動帶上 tenant slug：`{publicBaseUrl}/t/{slug}/EnrollmentServer/Discovery.svc`，確保多租戶 enrollment 路由正確。

---

## 2. 前置準備（IT / 台灣團隊一次性）

| 項目 | 說明 |
|---|---|
| **後端服務 + 公網 HTTPS** | MDM 後端須對外有有效 CA 的 HTTPS 域名（Windows 拒絕自簽 TLS）。生產用固定域名。 |
| **租戶已初始化** | 已完成 §1.5 的租戶建立 + MDM 配置。 |
| **一台 ADK 工具機** | 裝有 Windows ADK 的 Win10/11，用來把 API 產出的 `customizations.xml` build 成 `.ppkg`（ICD 是 Windows 專屬工具）。可由台灣團隊集中維護一台。 |
| **Admin API Token** | 呼叫 PPKG 生成 API 用。 |
| **校園 WiFi 資訊** | SSID + 密碼（填進 PPKG，設備 OOBE 即自動連網）。 |
| **帳號規劃** | 學生標準帳號名/密碼規則；IT 管理帳號名/密碼（只有 IT 掌握）。 |
| **USB 隨身碟** | 數量視批量規模；可多支並行。 |

---

## 3. 第一步：判斷設備狀態 + 歸一化

### 判斷
- **全新、沒開過機**（一開機就是藍底設定向導）→ 跳到第二步。
- **已激活 / 已有人建帳號 / 狀態不一** → 先歸一化。

### 歸一化（已激活設備）
1. 進入系統 → **設定 → 系統 → 復原 → 重設此電腦**
2. 選「**移除所有內容**」→ 本機重裝或雲端重裝
3. 重設完成後設備自動回到 OOBE

> **大批量（數十台以上）**：建議改用「統一映像」——用 DISM/sysprep 製作一個金標準映像（預置標準帳號模板 + 開機自動納管），透過 MDT / WDS / PXE 或 USB 映像批量刷機，比逐台重設高效。

---

## 4. 第二步：生成 PPKG（台灣團隊 / IT 後端操作）

### 4.1 呼叫 API 生成 customizations.xml

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://<後端域名>/api/v1/admin/tenants/<tenantId>/enrollment/ppkg-config" \
  -o customizations.xml \
  -d '{
    "deviceGroupId": "<該校 device_group UUID>",
    "upn": "enrollment@school.local",
    "secret": "<enrollment 密碼>",
    "skipOobe": true,
    "wifi": [
      { "ssid": "Campus-WiFi", "securityType": "WPA2-Personal", "securityKey": "<WiFi密碼>" }
    ],
    "localAccounts": [
      { "username": "student", "password": "<學生統一初始密碼>", "isAdmin": false, "forceChangePasswordAtNextLogon": true },
      { "username": "itadmin", "password": "<IT管理密碼>", "isAdmin": true }
    ]
  }'
```

**參數說明**：

| 參數 | 必填 | 說明 |
|---|---|---|
| `deviceGroupId` | 選填 | 該校 `device_group` UUID。**帶上** → PPKG 含 `/g/{code}` 段，設備 enroll 即自動歸校；**省略** → 設備直屬教育局（tenant），後續可 PATCH 分配 |
| `upn` | ✅ | Enrollment 服務帳號（任意含 `@`），bulk enrollment 用 |
| `secret` | ✅ | OnPremise 模式密碼（後端不驗證，任意值）|
| `wifi[]` | ✅ | 至少 1 個 SSID。`ssid` + `securityType`(Open/WEP/WPA2-Personal) + `securityKey`。**必填**——OOBE 階段裝置在套 PPKG 前是斷網的，沒 WiFi 段 enrollment 必失敗（2026-06-25 真機驗證確認）|
| `localAccounts[]` | 選填 | `username` + `password` + `isAdmin` + `forceChangePasswordAtNextLogon`。**`isAdmin:false`=學生標準帳號（必須）**；`isAdmin:true`=IT 管理帳號 |
| `skipOobe` | 選填 | `true` → PPKG 寫 `<HideOobe>True</HideOobe>`，跳過 OOBE「您要如何設定此裝置」（個人/公司）頁，直接到 student 登入畫面。⚠️ Win10 22H2 上 HideOobe **不能** bypass 隱私頁與資料海外存儲同意頁（後者是 MS 法律 hardcode 的，無法繞過）|
| `localAccounts[].forceChangePasswordAtNextLogon` | 選填 | `true` → 該帳號首次登入時被迫改密。對應 PPKG `<ProvisioningCommands>` 段以 SYSTEM 跑 `net user <username> /logonpasswordchg:yes`。多個帳號帶 `true` 會用 `&&` 串成一條命令。教育場景常見組合：PPKG 配統一臨時密碼 + 此旗標 → 學生首次登入自設密碼，明文密碼僅作派發 |

> 💡 **每校一份 PPKG 的命名規則**：API 回傳的檔名會自動帶 group code，例如 `cogrow-{tenant-slug}-{group-code}-{date}-customizations.xml`，IT 區分多份 PPKG 不會搞混。
>
> ⚠️ **device_group.code 必須是 URL-safe**（`[a-z0-9_-]{1,64}`）。如果建 group 時 code 含中文 / 空格 / 大寫，PPKG 生成會回 400 `device_group_code_not_url_safe`，需先 PATCH 改 code 才能用於 PPKG。

> ⚠️ **安全**：`customizations.xml` 含明文 WiFi 金鑰與帳號密碼。產出後妥善保管，build 完即刪，勿外流。

### 4.2 在 ADK 工具機 build 成 .ppkg

把 `customizations.xml` 傳到 ADK 工具機，執行：

```powershell
& "C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Imaging and Configuration Designer\x86\ICD.exe" `
  /Build-ProvisioningPackage `
  /CustomizationXML:C:\path\customizations.xml `
  /PackagePath:C:\path\school.ppkg
# 期望 $LASTEXITCODE = 0

# 校驗（權威，不要看檔案魔數）
Get-ProvisioningPackage -PackagePath C:\path\school.ppkg
# 期望 PARSE_OK，PackageName / PackageId 與 XML 一致
```

### 4.3 寫入 USB

把 `school.ppkg` 複製到 USB 隨身碟根目錄。

> 💡 **PackageId 每次生成都不同**（API 每次產生新 GUID）。同一台設備若要重裝，先移除舊預配套件（見第 7 節故障排除），否則報 `0x800700B7`。

---

## 5. 第三步：OOBE 階段套用 PPKG（每台設備）

### 什麼是 OOBE
OOBE（Out-of-Box Experience）= Windows 開機後的**開箱設定向導**（選地區、鍵盤、網路、帳號那一連串藍底頁面）。全新設備首次開機自動進入；重設後也會回到這裡。

### 操作步驟

```
1. 設備開機 → 進入 OOBE 第一個畫面（通常是「選擇國家或地區」）

2. 插入裝好 .ppkg 的 USB 隨身碟

3. ⭐ 在第一個畫面，快速連按 5 次 ⊞ Windows 鍵（鍵盤左下角窗口鍵）
   → 彈出「設定此裝置 / Provision this device」頁面

4. 系統列出 USB 裡的 .ppkg → 選中 → 彈「是否信任並安裝此預配套件?」→ 是

5. PPKG 自動套用（數秒~1分鐘）：
   - 連校園 WiFi（OOBE 0 觸控）
   - 建學生標準帳號 + IT 管理帳號
   - 納管進 MDM
   - `skipOobe=true` → 跳過「您要如何設定此裝置」頁
   - `forceChangePasswordAtNextLogon=true` → 學生首次登入要求自設密碼

6. 套用完成 → 進入登入畫面（學生帳號）→ 輸入統一初始密碼 → 被迫設定新密碼 → 進入桌面
   - ⚠️ 隱私設定頁 + 資料海外存儲同意頁仍會出現（Win10 22H2 hardcode，PPKG 跳不過）

7. 後端自動接管（無需操作）：禁手動註銷 + 配 push 推送通道
```

> **無鍵盤平板機型**：5 次 Windows 鍵不適用，需用各廠商的音量鍵組合（查機型文件）。
>
> **聯網時機**：enrollment 須連後端。PPKG `wifi[]` 已是**必填**欄位（2026-06-25 改），套用後 OOBE 0 觸控即自動連網。桌機 / 有線網路場景目前不支援，如需請聯繫後端團隊開放 `allowNoWifi` 旗標。
>
> **錯過第一畫面**：若已過第一畫面，可等進系統後走「設定 → 帳戶 → 存取公司或學校資源 → 新增預配套件」手動套用，效果相同（只是非開箱即用）。

---

## 6. 第四步：驗證納管成功

### 設備端
設定 → 帳戶 → 存取公司或學校資源 → 看到「**已連接到 ... MDM**」條目。

### 後端側（台灣團隊 / IT 確認）
```bash
curl -s -H "Authorization: Bearer <TOKEN>" "https://<後端域名>/api/mdm/win/devices"
# 新設備出現，enrollmentStatus = enrolled
```

納管成功後後端會**自動**完成（無需手動）：
- 下發「禁手動註銷」策略（設定裡「中斷連線」按鈕變灰）
- 配 push 通道：下發信任憑證 + 安裝 push 接收器 + 自動取得推送 ChannelURI
- 之後緊急命令（如遠端鎖定/清除）可秒級下發

---

## 7. 防脫離配套配置（IT 必做，否則學生可脫管）

| 層 | 措施 | 目的 | 由誰做 |
|---|---|---|---|
| 1 | **學生用標準帳號**（PPKG 已建，`isAdmin:false`）；管理員密碼只給 IT | 擋住「移除預配套件 / 改策略 / 重置系統」 | PPKG（已含）|
| 2 | 禁手動註銷（後端自動下發） | 擋標準帳號 GUI 中斷連線 | 後端（已自動）|
| 3 | **BIOS/UEFI 鎖**：設密碼 + 禁 USB/外部介質開機 + Secure Boot | 擋「USB 重裝系統」繞過 | IT（廠商工具批量：Dell Command / HP / Lenovo）|
| 4 | **BitLocker** 全碟加密 | 擋拆硬碟 / 離線竄改 | IT / MDM 策略 |
| 5 | 失聯告警（後端） | 即使脫離也能即時得知 | 後端 |

> **關鍵**：第 1 層是根。若學生有管理員權限，第 2 層形同虛設——管理員可移除預配套件直接脫管。**務必確認交付給學生的是標準帳號。**

---

## 8. 帳戶與密碼策略（生產規則）

> 核心矛盾：安全（每台不同密碼）↔ 分發簡便（統一 PPKG）。
> **破法：PPKG 永遠統一，密碼差異化交給「納管後 MDM 動態注入」**——分發簡便與密碼安全不衝突。

### 8.1 學生標準帳號
- PPKG 建立，`isAdmin: false`（Standard Users）—— **這是防脫離的根，學生絕不可給管理員權限**
- 給統一臨時初始密碼 + **強制首次登入改密**（PPKG ProvisioningCommands 或開機腳本 `net user <user> /logonpasswordchg:yes`）
- 學生改密後自己掌握；IT 需重置時透過管理員 / MDM

### 8.2 IT 管理員帳號（關鍵風險點）
- PPKG 建立，`isAdmin: true`
- ⚠️ **絕不可全設備統一固定密碼**：PPKG 含明文密碼、`.ppkg` 可解包讀出；統一密碼一旦洩漏（U 盤流出 / 學生逆向）= **全設備管理員密碼洩漏 = 第 7 節所有防脫離全線失效**
- 密碼**每台不同**，但不靠 PPKG 差異化（否則每台一個 PPKG、分發崩潰），改由納管後注入：

| 階段 | 做法 |
|---|---|
| **簡版（當前）** | PPKG 統一強臨時密碼 + **用完即焚** + 納管後盡快輪換；統一密碼暴露窗口僅在納管前 |
| **完整版（後續開發）** | 自建 LAPS-like：設備納管後由 agent/後端自動把管理員密碼改成每台隨機值 + 上報托管 + IT 按設備查。（Windows MDM 無改本機密碼的標準 CSP，靠 agent 執行 + Registry CSP 信箱機制，與遠端鎖屏同一套機制）|

### 8.3 核心原則
1. **PPKG 永遠統一**（一個檔刷所有機器）；密碼的每台差異化交給「納管後 MDM 動態注入」（即 LAPS-like 思路）
2. PPKG 含明文密碼 → **用完即焚，絕不流到學生手中**
3. 學生用標準帳號（防脫離的根）；管理員密碼每台不同（避免「一台洩漏全體淪陷」的單點失效）

---

## 9. 故障排除（本專案實戰踩過的）

| 現象 / 錯誤碼 | 根因 | 解法 |
|---|---|---|
| **`0x800700B7`** 預配失敗（ALREADY_EXISTS）| 同一台裝過**同 PackageId** 的預配套件（中斷 MDM 不會移除預配套件記錄）| 設定 → 帳戶 → 存取公司或學校資源 → **新增或移除預配套件** → 移除舊套件，再重裝 |
| **`0x800B0109`** CERT_E_UNTRUSTEDROOT | 設備不信任 MSIX 簽名憑證 | 後端自動下發信任憑證已處理；若手動裝需先匯入 cert 到 Root + TrustedPeople |
| 預配失敗、後端只收到 `GET Discovery` 無 POST | 設備本地階段就失敗，沒發起網路 enrollment（多為殘留 / 預配套件衝突）| 同 `0x800700B7` 排查；或檢查設備是否聯網 |
| GUI「無法自動探索」但後端 200 | Content-Type 缺 action 參數 / 欄位格式（後端問題）| 聯繫後端團隊 |
| 中斷連線按鈕是灰的、無法中斷 | 禁手動註銷策略生效（標準帳號預期行為）| 需 IT 用管理員：後端先解鎖（API `allow:true`）或管理員清除 |

---

## 10. 已知限制

- **無 Windows Autopilot**：批量配置須人工插 USB 或刷映像，無法開機零接觸。要零接觸只能上 Intune + Autopilot（需脫離自建方案）。
- **push 推送整套綁環境，獨立部署須自建**：秒級推送依賴一整套綁定的資產——push 簽名 cert + push MSIX + WNS 憑據（PACKAGE_SID/CLIENT_SECRET）+ PFN，全部綁某個 Microsoft Store 註冊。獨立生產部署**必須自建整套**：自己的 Store 註冊 → 自己的 WNS 憑據 → 自行 build push MSIX（PFN 不同）→ cert 隨之重新生成。**不可沿用開發環境（cogrow）的 push cert / MSIX**（PFN 與 WNS 對不上）。push 這套不可用時，命令仍可透過 polling 下發（較慢，分鐘級），不影響基本納管。生成的 cert 公鑰放後端 `data/push-cert.cer`（**本倉庫不含此檔**，已 gitignore；須自行生成放入，否則 push 自動配置會被跳過）。
  - ⭐ **這套是「全域一套」，不是「每租戶/每校一套」**：push cert + MSIX + PFN + WNS 憑據是帳號級推送基礎設施，與租戶無關。所有租戶、所有學校的設備都裝**同一個** push MSIX、共用**同一套** WNS 憑據；設備靠各自唯一的 ChannelURI 區分，租戶隔離在後端業務層（device 綁 tenantId）。**台灣團隊只需註冊一個 Microsoft Store 應用、build 一個 push MSIX、一張 cert 全域共用**，切勿每校一套（無隔離收益、徒增維護負擔）。
- **`.ppkg` 須在 Windows ADK 機器 build**：後端只生成 `customizations.xml`，ICD 是 Windows 專屬，需一台 ADK 工具機。
- **OOBE 套用需聯網**：enrollment 要連後端，PPKG `wifi[]` 是**必填**（2026-06-25 改）。
- **最低系統**：Pro/Enterprise/Education；部分策略（如鎖桌布 Personalization CSP）需 22H2 以上。

---

## 11. 流程速查（IT 一頁卡）

```
全新設備：
  開機 → OOBE 第一畫面 → 插 USB → 按 5 次 ⊞Win → 選 .ppkg → 是
  → 自動建標準帳號+連WiFi+納管 → 進桌面 → 驗證「已連接 MDM」

已激活設備：
  設定→系統→復原→重設此電腦→移除所有內容 → 回 OOBE → 同上

每批前：台灣團隊用 API 生成 customizations.xml → ADK 機 build .ppkg → 拷 USB
配套：學生標準帳號(PPKG已建) + BIOS鎖禁USB開機 + BitLocker
```
