# PPKG GUI 反向工程 Checklist — OOBE Skip + 強制首次改密

> **狀態（2026-06-25）**：✅ schema 已反向工程並落代碼（見 enrollment-ppkg.ts:OOBE 段 / ProvisioningCommands 段）。
> 真實 export 樣本：`/private/tmp/.../scratchpad/ppkg-oobe-skip-reverse.xml`。
>
> **任務背景**：當前 PPKG 套完後 OOBE 還會跑，逼使用者多建一個帳號。
> 目標：PPKG 套完 → 跳過 OOBE → 直接到 student 帳號**登入頁**（不是直接進桌面）→ student 首次登入強制改密碼。
>
> ⚠️ Win10 22H2 上 `HideOobe` 不保證完全 bypass OOBE，真機驗證後若仍卡 OOBE 帳號類型選擇頁需另走 unattend.xml 方案。

## ✅ 反向工程結果（已驗證 schema）

```xml
<OOBE>
  <Desktop>
    <HideOobe>True</HideOobe>          <!-- 注意 "Oobe" 小寫 obe -->
  </Desktop>
</OOBE>

<ProvisioningCommands>
  <DeviceContext>
    <CommandLine>cmd /c net user student /logonpasswordchg:yes</CommandLine>
  </DeviceContext>
</ProvisioningCommands>
```

ICD GUI 暴露的選項：
- `OOBE/Desktop` 只有 `HideOobe` 和 `EnableCortanaVoice` 兩個布林（沒有 SkipMachineOOBE / SkipUserOOBE）
- `ProvisioningCommands/DeviceContext` 是 `CommandFiles` + `CommandLine` 兩個葉子節點（不是列表，每個 PPKG 一條）

API 用法：
- `POST /api/v1/admin/tenants/{tid}/enrollment/ppkg-config` body 加 `skipOobe: true`
- `localAccounts[]` 內加 `forceChangePasswordAtNextLogon: true` → 自動進 ProvisioningCommands CommandLine

---

> 以下保留原反向工程過程，作為下次新段落（unattend.xml / 其他 schema）反向工程的方法論參考。
>
> 嚴格遵守反向工程紀律（[README.md](README.md):23）：別 CLI 猜 schema，先 ICD GUI 設好 → Export → 看真實 XML → 填代碼。

## 兩段 schema 要拿

| schema 段 | 用途 | 預計 Runtime settings 路徑（猜測，去 GUI 驗證） |
|---|---|---|
| **OOBE skip** | 跳過「您要如何設定此裝置」、區域 / 鍵盤 / Microsoft 帳號等所有 OOBE 頁 | 可能在 `Runtime settings → OOBE` 或 `Common/OOBE`，也可能在 `DesktopBackgroundAndColors` 旁邊。**在 GUI 樹裡找帶 OOBE / FirstRun / Setup 字樣的節點**。 |
| **強制首次改密** | student 第一次登入時被要求重設密碼 | 可能在 `Runtime settings → Accounts → Users → <某個 student 子節點>` 裡有 `ForceChangePasswordAtNextLogon` 或 `ChangePasswordAtNextLogon` 之類的布林屬性。**展開 Accounts/Users/<student> 把所有可選欄位都試一遍**。 |

> ⚠️ 路徑是猜的（之前 README.md:23 已有教訓：`Common/Personalization` 是錯的）。**以 GUI 樹實際顯示為準**。找不到節點就回報 Claude，我們改方案。

## 前置（同 W4 反向工程）

- Win10 192.168.50.68（cogrow 帳號 RDP）
- ADK ICD 已裝：`C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Imaging and Configuration Designer\x86\ICDStarter.exe`

## 步驟

### 1. 啟動 ICD GUI（cogrow 帳號 desktop）

```powershell
& "C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Imaging and Configuration Designer\x86\ICDStarter.exe"
```

- 主頁 → **Advanced provisioning**（不要選 Provision desktop wizard）
- Project name: `cogrow-ppkg-oobe-skip-reverse`
- **All Windows desktop editions** → Next
- 跳過 "Import a provisioning package" → Finish

### 2. 設 Workplace enrollment（保留作完整樣本）

左側 Runtime settings → Workplace → Enrollments：
- UPN: `enrollment@cogrow-reverse.local` → Add
- AuthPolicy: **OnPremise**
- DiscoveryServiceFullUrl: `https://placeholder.example.com/EnrollmentServer/Discovery.svc`
- Secret: `reverse-secret-placeholder`

### 3. 設 student 帳號（**這次重點：找強制改密欄位**）

左側 Runtime settings → Accounts → Users：
- UserName: `student-reverse` → Add
- 展開新建的 user：
  - Password: `TempPass!123`
  - UserGroup: `Users`
  - **把所有其他可選欄位都展開看一遍**：
    - 有沒有 `ForceChangePasswordAtNextLogon`？勾 true。
    - 有沒有 `ChangePasswordAtNextLogon`？勾 true。
    - 有沒有 `PasswordExpires`？看到就記下。
    - 有沒有 `MustChangePassword`？看到就勾 true。
  - **記下你勾了哪幾個欄位、欄位的確切英文名**（後面對 export XML 用）。

如果展開的 user 節點下**沒有任何**強制改密相關欄位 → 跟 Claude 回報「Accounts/Users 樹下沒有強制改密選項」，我們改走 ProvisioningCommands 方案。

### 4. 找 OOBE skip 段（**這次重點：探索 GUI 樹**）

在左側 Runtime settings 樹**從上到下展開所有節點**，找帶下列關鍵字的：
- `OOBE`
- `FirstRun`
- `Setup`
- `Privacy`
- `Personalization`

可能的候選路徑（不一定都存在）：
- `Runtime settings → OOBE → HideOOBE`
- `Runtime settings → OOBE → SkipMachineOOBE`
- `Runtime settings → OOBE → SkipUserOOBE`
- `Runtime settings → DeviceUpdateCenter → OOBE`
- `Runtime settings → Policies → ...`

**操作**：
1. 找到任何看起來相關的節點 → 勾 true / 設值
2. 截圖樹形展開的整個 OOBE / FirstRun 區段（screenshot 存 desktop 一併拷回）
3. 沒找到的話：在樹頂部 GUI 搜尋框（如果有）輸入 `OOBE` 看搜出什麼

### 5. （重點）給定 student 後**指定 OOBE 用哪個帳號免互動完成**

OOBE 跳過後，系統需要知道「用誰登入第一次」。**找下列其中之一**：
- `Accounts → ComputerAccount`（這個之前 README.md:23 有提到，Win10 < 2004 才適用，22H2 可能變了）
- `Accounts → Users → <student> → AutoLogon` 或類似
- `Personalization → ...`

如果 OOBE skip 後沒地方指定「免互動帳號」→ 跟 Claude 回報，我們改方案（可能要 PPKG + unattend.xml 雙軌）。

### 6. Export

主菜單 → **File → Save**
主菜單 → **Export → Provisioning package**
- Package name: `cogrow-ppkg-oobe-skip-reverse`
- Owner: OEM
- Rank: 0
- 加密 / 簽名都 **跳過**（導出最乾淨 XML）
- Build → 等幾秒

完成後 customizations.xml 位置：
```
C:\Users\cogrow\Documents\Windows Imaging and Configuration Designer (WICD)\cogrow-ppkg-oobe-skip-reverse\customizations.xml
```

### 7. 拷回 Mac

```powershell
# Win10 上（cogrow 帳號）
Copy-Item 'C:\Users\cogrow\Documents\Windows Imaging and Configuration Designer (WICD)\cogrow-ppkg-oobe-skip-reverse\customizations.xml' C:\Users\Public\Documents\
```

```bash
# Mac 端（Claude 跑）
scp -i ~/.ssh/win10_mdm_test -o UserKnownHostsFile=$HOME/.ssh/known_hosts.win10mdm \
  'Administrator@192.168.50.68:C:/Users/Public/Documents/customizations.xml' \
  /tmp/ppkg-oobe-skip-reverse.xml
```

### 8. 完工標誌

回報 Claude：
> "customizations.xml 已落 `/tmp/ppkg-oobe-skip-reverse.xml`，本次勾了下列欄位：[列出你在步驟 3 / 4 / 5 勾的所有欄位名]，找不到的段：[列出找不到的]，開始填實 OOBE skip 與強制改密邏輯。"

Claude 會：
1. 解析 XML，定位 OOBE skip 與 ForceChangePassword 真實節點名稱
2. 在 `app/services/admin/enrollment-ppkg.ts` 新增：
   - `renderOobeSkipSection(input)` — 根據 export 真實 schema 渲染
   - 擴充 `LocalAccountCustomization` 加 `forceChangePasswordAtNextLogon?: boolean`
   - `renderAccountsSection` 加對應子元素
3. 在 `app/routes/v1/admin/enrollment-ppkg.ts` 加 input 欄位
4. 新增 unit test 覆蓋兩種情況（開 / 不開 OOBE skip）
5. 跑 `deno task test` 確認全綠
6. commit

## 不要做什麼

- ❌ 不要憑記憶填 `<HideOOBE>True</HideOOBE>`——schema 路徑可能完全不同
- ❌ 不要 build `.ppkg`（只要 customizations.xml）
- ❌ 不要在 GUI 裡同時開太多無關段——只開本次任務的 enrollment + accounts + OOBE 三段，方便對比 export
