# PPKG Build Scripts (W3 主軸 4 partial)

USB PPKG (Provisioning Package) zero-touch 部署用 build 資產。

## 工具鏈狀態（2026-05-28 SSH Win10 192.168.50.68 驗證）

- ✅ Windows ADK 已裝（`/quiet /features OptionId.ImagingAndConfigurationDesigner` 4.7 分鐘）
- ✅ `ICD.exe` 路徑：`C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Imaging and Configuration Designer\x86\ICD.exe`
- ✅ ICD CLI build 工作流通（空 customization 產出 4003 bytes WIM 格式 .ppkg）

## 文件

| 檔 | 用途 |
|---|---|
| `install-adk-icd.ps1` | 遠程裝 ADK ICD feature。**用 Invoke-WebRequest 不用 BITS**（BITS 在 SSH 無 desktop session 撞 0x800704DD ERROR_NOT_LOGGED_ON） |
| `build-ppkg.ps1` | 跑 `ICD.exe /Build-ProvisioningPackage` 把 customization XML 打成 .ppkg |
| `ppkg-minimal-empty.xml` | 最小可 build 的 customization（空 Common），驗證 ICD 工具鏈 |

## 已知坑（避免重複踩）

1. **BITS 在 SSH 失敗**：`Start-BitsTransfer` 需 interactive user session，over SSH 撞 `0x800704DD`。用 `Invoke-WebRequest -UseBasicParsing` 配 `$ProgressPreference = "SilentlyContinue"`（後者必須，否則 PS 5.1 進度條讓 IWR 慢 10x）
2. **ICD boolean 參數**：`/Encrypted:True` 不被識別（"Boolean argument must be prepend with + or -"），但 `/Encrypted+` `/Encrypted-` 也不識別。**最穩做法：省略，用預設值**
3. **customization XML namespace 嚴格**：`Common/Personalization` 不存在（猜的，錯）；`Accounts/ComputerAccount/ComputerName` 對但僅 Win10 < 2004 適用。Win10 22H2+ 用新路徑。**規則：別 CLI 猜 schema，先查文檔**（見下節）
4. **PPKG 容器格式**：新 ADK 用 **WIM**（magic `4D 53 57 49 4D = MSWIM`），不是早期的 CAB（`MSCF`）

## Schema 查證工作流（取代 CLI 猜）

WCD customization XML schema 嚴格，CLI 試錯成本極高（每次 ICD build 要 scp + ssh）。順序：

1. **Context7 查**：MS Learn 鏡像 `/websites/learn_microsoft_en-us_windows`（123k snippets）
   ```
   mcp__plugin_context7_context7__query-docs
     context7CompatibleLibraryID = /websites/learn_microsoft_en-us_windows
     topic + query = 具體欄位/CSP 路徑
   ```
2. **WebSearch + WebFetch 兜底**：`learn.microsoft.com/en-us/windows/configuration/wcd/...`
3. **最後才 ICD GUI**（`ICDStarter.exe`，需 desktop interactive）：「Available customizations」樹瀏覽完整 schema + 自動產 XML

**反模式**：直接寫 customization XML → scp → ICD build → 看報錯改 → 再 scp → 再 build。猜對概率低、來回 ssh 慢。

## TODO（下次 Win10 desktop 會話）

完整 customization XML schema 用 ICD GUI（`ICDStarter.exe`）設計效率比 CLI 猜高 10x：

```powershell
# 啟動 GUI（需 desktop interactive，不能 SSH）
ICDStarter.exe
```

GUI 步驟：
1. New project → Provision desktop devices 模板
2. 設備名稱 + WiFi（可選）+ 本機帳號（學生 Standard + Admin）+ 鎖定移除 MDM 政策
3. **MDM enrollment 區段**：DiscoveryServiceFullURL = `{self_mdm_config.public_base_url}/EnrollmentServer/Discovery.svc`、AuthPolicy = OnPremise / Federated
4. Export → customization.xml + Build PPKG（GUI 自動處理 schema）
5. 拿到 .ppkg 後可用本目錄 `build-ppkg.ps1` 模板做 server-driven 變體 build

## Server 端對接（2026-05-28 已實作 + 端到端驗證 ✅）

`GET /api/v1/admin/tenants/{tid}/enrollment/ppkg-config?upn={upn}&secret={secret}`
- Admin Bearer auth；自帶 `upn` + `secret` query（server 不持久化 enrollment 凭据）
- Server 填本 tenant 的 `self_mdm_config.public_base_url` + `slug` + `displayName`
- 返回 `application/xml` + `Content-Disposition: attachment`
- 真實 schema（從 Win10 GUI 反向工程）：
  `Common/Workplace/Enrollments/UPN[UPN+Name attrs]/{AuthPolicy,DiscoveryServiceFullUrl,Secret}`

端到端流程（2026-05-28 在 192.168.50.68 跑通）：
1. `curl -H "Authorization: Bearer ..." ".../enrollment/ppkg-config?upn=...&secret=..."` → 拿 1013 bytes XML
2. SCP XML 到 Win10 工具機
3. `powershell -File build-ppkg.ps1`（ICD CLI）→ exit 0，5899 bytes .ppkg（WIM magic `MSWIM`）
4. .ppkg 插 USB 進新設備觸發 zero-touch enrollment

實作位置：
- `app/services/admin/enrollment-ppkg.ts` — `generatePpkgCustomizations(input)` + 純函式 `renderCustomizationsXml(ctx)`
- `app/routes/v1/admin/enrollment-ppkg.ts` — GET endpoint zod-openapi

簽名：
```ts
interface GeneratePpkgInput {
  tenantId: string;
  upn: string;
  secret: string;
  authPolicy?: "OnPremise" | "Certificate";  // 預設 OnPremise（已真機驗證）
  wifi?: WifiCustomization[];                // schema 待 GUI 反向工程
  localAccounts?: LocalAccountCustomization[]; // schema 待 GUI 反向工程
}
```

擴展骨架狀態：
- ✅ OnPremise — 2026-05-28 真機驗證通過
- ⏳ `authPolicy="Certificate"` — helper throw 501 `ppkg_section_not_validated`（業務未確認是否需要 Certificate 模式；OnPremise 已足夠）
- ✅ `wifi[]` — 2026-05-28 Win10 ICD GUI export 反向工程完成 + 5 unit test
- ✅ `localAccounts[]` — 2026-05-28 Win10 ICD GUI export 反向工程完成（Standard Users 真機驗證；Administrators 推測值未真機驗證）+ 4 unit test

`renderWifiSection` 與 `renderAccountsSection` 的 XML 結構（節點名 / attribute / enum 字面值）來自 [GUI-REVERSE-CHECKLIST.md](./GUI-REVERSE-CHECKLIST.md) 流程拿到的權威樣本。

Certificate 段持續 throw 501 直到業務確認需求。

18 個 unit test（11 新增）覆蓋 OnPremise XML 格式 + WiFi 各 SecurityType 路徑 + Accounts standard/admin 路徑 + escape + 多 SSID/多 user 並列 + 三段共存（`app/services/admin/enrollment-ppkg.test.ts`）。

**Administrators follow-up**：當前 isAdmin=true 渲染 `<UserGroup>Administrators</UserGroup>` 為推測值。下次 RDP 在 GUI 給某 user 選 Administrator UserGroup 後 export 驗證 — 若實際字面值不同（如 "Administrator" 單數或其他），同步改 USER_GROUP_ADMIN 常數 + 對應 test assertion。

未來擴展（按需）：
- enrollment secret 落表 + server 驗證（取代 admin 自帶 query）
- Certificate authPolicy（業務確認需要後反向工程 Certificate 段）

## 用法（手動跑）

```powershell
# Win10 上（已裝 ADK）
scp ppkg-minimal-empty.xml Admin@win:C:/Users/Admin/
scp build-ppkg.ps1         Admin@win:C:/Users/Admin/
powershell -ExecutionPolicy Bypass -File C:\Users\Admin\build-ppkg.ps1
# 預期：4003 bytes ppkg，magic 4D 53 57 49 4D
```
