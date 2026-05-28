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
3. **customization XML namespace 嚴格**：`Common/Personalization` 報 "not a valid child node for /"；`Accounts/ComputerAccount` 也錯。每個元素必須在正確的 CSP namespace 路徑下
4. **PPKG 容器格式**：新 ADK 用 **WIM**（magic `4D 53 57 49 4D = MSWIM`），不是早期的 CAB（`MSCF`）

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

## Server 端對接設計（後段）

```
GET /api/v1/admin/tenants/{tid}/enrollment/ppkg-config
  → 返回完整 customization XML（含 enrollment URL + secret + 設備配額）
  → 部署人員 SCP 到 Win10 工具機 → 跑 build-ppkg.ps1 → 拿 .ppkg → USB 部署
```

## 用法（手動跑）

```powershell
# Win10 上（已裝 ADK）
scp ppkg-minimal-empty.xml Admin@win:C:/Users/Admin/
scp build-ppkg.ps1         Admin@win:C:/Users/Admin/
powershell -ExecutionPolicy Bypass -File C:\Users\Admin\build-ppkg.ps1
# 預期：4003 bytes ppkg，magic 4D 53 57 49 4D
```
