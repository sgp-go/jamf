# 構建機環境搭建指南

> **適用對象**：台灣團隊後端工程師。
> **目的**：準備一台 Windows 構建機，承擔生產部署所需的**三類構建**。可由台灣團隊集中維護一台（不需每校一台）。
> **背景提醒**：公司網路下載 >100MB 大檔易斷線/hang（見 §6），本文盡量用中小檔（nupkg + devpack）規避整套 GB 級 SDK。

---

## 0. 構建機要做哪三類構建

| 構建物 | 用途 | 工具鏈 | 對應文檔 |
|--------|------|--------|---------|
| **Agent MSI** | 設備上的後台服務（76MB） | .NET 8 SDK + WiX 5 | [agent-app-build-and-deploy.md](agent-app-build-and-deploy.md) |
| **push MSIX** | WNS 推送接收器（全域一個） | Windows SDK BuildTools + Contracts winmd + .NET 4.8.1 devpack | [push-infrastructure-setup.md](push-infrastructure-setup.md) |
| **`.ppkg`** | 設備初始化預配套件（每批生成） | Windows ADK 的 ICD | [device-provisioning-guide.md](device-provisioning-guide.md) §4 |

> 三類可在同一台機器上備齊。push MSIX 只在改 Identity / 換 publisher 時 build 一次；`.ppkg` 每批設備生成（後端產 XML，ICD 編譯）；Agent MSI 改版時 build。

---

## 1. 基礎環境

| 項目 | 要求 |
|------|------|
| 作業系統 | Windows 10 / 11 **Pro / Enterprise / Education**（Home 版工具鏈不全） |
| 架構 | **x64**（push MSIX 與 Agent MSI 均 win-x64；ARM64 機不能 build/sideload x64 產物） |
| 磁碟 | ≥ 30GB 空閒（ADK + SDK + 工具鏈 + 產物） |
| 網路 | 能訪問 nuget.org / Microsoft 下載；注意大檔斷線（§6） |

---

## 2. Agent MSI 工具鏈

| 工具 | 版本 | 安裝 |
|------|------|------|
| .NET SDK | 8.0+ | `winget install Microsoft.DotNet.SDK.8`，或官網 installer。`dotnet --version` 確認 |
| WiX Toolset | 5.0+ | **NuGet 自動還原**，不需單獨裝。build.ps1 跑 `dotnet build` 時拉取 |

驗證：

```powershell
cd win-agent-app
powershell -ExecutionPolicy Bypass -File build.ps1 -Version 1.0.0.0
# 產出 win-agent-app/build/msi/CoGrowMDMAgent.msi (~76MB, self-contained)
```

> build.ps1 用 `dotnet publish -r win-x64 --self-contained true -p:PublishSingleFile=true`，產出單檔 exe 含 .NET 8 runtime，設備端不需裝 .NET。

---

## 3. push MSIX 工具鏈（規避 GB 級 SDK）

push MSIX 的 build 需要 `makeappx` / `signtool` / `WinMDExp.exe` / `csc` + 全套 contract winmd。**不需要裝完整 Visual Studio 或整套 Windows SDK installer**——用 nupkg + 一個 devpack 拼出來（都是中小檔，避開幾 GB 下載）：

| 工具 | 來源 | 大小 |
|------|------|------|
| `makeappx` / `signtool` | `Microsoft.Windows.SDK.BuildTools` nupkg | ~22MB |
| `Windows.winmd` + 95 個 contract winmd | `Microsoft.Windows.SDK.Contracts` nupkg | ~21MB（winmd 全集） |
| .NET 4.8.1 Reference Assemblies + Facades | `Microsoft.NETFramework.ReferenceAssemblies.net481` nupkg | ~20MB |
| **`WinMDExp.exe`** + NETFX tools | **.NET Framework 4.8.1 Developer Pack**（`fwlink linkid=2203306`） | ~103MB（唯一要 devpack） |
| `csc` | 系統自帶（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`） | — |

### 取得 nupkg

nupkg 本質是 zip，下載後解壓即可（不需 NuGet 客戶端）：

```powershell
# 範例：以 nuget.org 下載再解壓到 C:\push-toolchain
Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Windows.SDK.BuildTools" -OutFile sdk-buildtools.zip
Expand-Archive sdk-buildtools.zip -DestinationPath C:\push-toolchain\sdk-buildtools
# 同理 Contracts、ReferenceAssemblies
```

> 完整替代方案：裝完整 Windows 10 SDK（`winsdksetup.exe` 從 `fwlink linkid=2272610`，`/quiet /norestart`），則 `makeappx`/`signtool`/`WinMDExp` 都在標準路徑。但下載大、慢——公司網路建議走 nupkg 拼裝。

### 工具標準路徑（裝了完整 SDK 時）

```
makeappx / signtool: C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64\
WinMDExp.exe:        C:\Program Files (x86)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8.1 Tools\
csc.exe:             C:\Windows\Microsoft.NET\Framework64\v4.0.30319\
Windows.winmd:       C:\Program Files (x86)\Windows Kits\10\UnionMetadata\<ver>\
```

build 腳本 `docs/scripts/build-push-msix-v2.ps1` 會自動偵測這些路徑。詳細 build 步驟與 4 個踩坑見 [push-infrastructure-setup.md](push-infrastructure-setup.md) §5。

---

## 4. PPKG 工具鏈（Windows ADK / ICD）

`.ppkg` 由後端生成的 `customizations.xml` 經 **ICD（Imaging and Configuration Designer）** 編譯產生。ICD 隨 **Windows ADK** 安裝。

```powershell
# 裝 ADK（只需勾「Configuration Designer」功能，不需全套）
# adksetup.exe 從 https://learn.microsoft.com/windows-hardware/get-started/adk-install
adksetup.exe /quiet /features OptionId.ImagingAndConfigurationDesigner
```

ICD 路徑：

```
C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Imaging and Configuration Designer\x86\ICD.exe
```

編譯 `.ppkg`（詳見 device-provisioning-guide §4.2）：

```powershell
& "C:\...\ICD.exe" /Build-ProvisioningPackage `
  /CustomizationXML:C:\path\customizations.xml `
  /PackagePath:C:\path\school.ppkg
Get-ProvisioningPackage -PackagePath C:\path\school.ppkg   # 期望 PARSE_OK
```

---

## 5. 一次性安裝檢查清單

- [ ] Windows 10/11 Pro/Enterprise/Education，x64
- [ ] .NET SDK 8.0+（`dotnet --version`）→ Agent MSI
- [ ] push 工具鏈：makeappx / signtool / WinMDExp / csc + 95 個 contract winmd 就位 → push MSIX
- [ ] Windows ADK（ICD 功能）→ `.ppkg`
- [ ] 能成功跑 `build.ps1` 產出 Agent MSI（驗證 .NET + WiX 鏈）

---

## 6. 公司網路大檔策略（必讀）

公司網路下載 **>100MB 的檔案易斷線 / hang**（實戰反覆遇到）。影響：完整 Windows SDK、VS installer、.NET runtime、devpack。

對策：

1. **能用 nupkg 拼就別裝整套 SDK**（§3）——把單一 GB 級下載拆成數個 ≤22MB 的 nupkg。
2. **大檔（如 103MB devpack）用續傳**：`curl -C -`（斷了重跑接續），或瀏覽器下載管理器。
3. **跨機傳輸**：在 Mac 上 `curl -C -` 下好，再 `scp` 到構建機，比在受限網路的構建機上直接拉穩。
4. **SSH 構建注意**：透過 OpenSSH 非交互 session 跑時，BITS 不可用（per-user 服務，報 `0x800704DD`），大檔下載改 `Invoke-WebRequest` 或 Mac 端下好 scp。

> 詳見 brain `project_company_network_large_file` / `windows-push-rebuild-and-autoconfig`。

---

## 7. SSH 遠端構建（Mac 驅動 Windows 構建機）

台灣團隊若用 Mac 驅動 Windows 構建機，透過 SSH `powershell -EncodedCommand`（避免引號轉義地獄）：

```bash
# 腳本轉 base64（UTF-16LE，PowerShell EncodedCommand 要求）
B64=$(python3 -c "import base64; print(base64.b64encode(open('docs/scripts/build-push-msix-v2.ps1','r').read().encode('utf-16-le')).decode())")
ssh <build-machine> "powershell -ExecutionPolicy Bypass -EncodedCommand $B64"

# 產物用 scp 拉回（OpenSSH for Windows 用正斜杠路徑）
scp <build-machine>:/Temp/CogrowMDMPush-2.0.msix data/test/
```

> ⚠️ Mac 寫的 .ps1 是 LF 換行，PowerShell 5.1 here-string 解析會錯——scp 前 `perl -i -pe 's/\r?\n/\r\n/' script.ps1` 轉 CRLF。
