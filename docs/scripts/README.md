# Win10 真機驗證 PowerShell 腳本（重 build MSIX）

這些腳本在 Win10/11 上跑（透過 SSH `powershell -EncodedCommand`），生成簽名 MSIX 與計算 PFN。

> 💡 **演示 / 接手不需要跑這些腳本**——git 倉庫 [`data/test/`](../../data/test/) 已附 3 個簽好的 demo MSIX，[`quick-start.md` 第 5 步](../archived/windows-mdm-quick-start.md#第-5-步派送-demo-msix-安裝)直接拿來派送即可。
>
> 🏭 **生產 push 自建**見 [`windows-deployment/push-infrastructure-setup.md`](../windows-deployment/push-infrastructure-setup.md)（本目錄的 `build-push-msix-v2.ps1` / `get-pfn.ps1` 即該流程使用的腳本）。
>
> **何時才需要來這裡重 build**：
> - 改了源碼（如 `hello.cs` 加新功能）
> - 改了 manifest（加 capability、改 ProcessorArchitecture）
> - 換了 publisher cert（公司更換簽署主體）
> - **Win11 ARM64 環境**（git 現成 MSIX 是 x64，ARM 上會 `0x80070005` 拒絕 sideload，必須重 build ARM64 / neutral 版）

## 環境前置

需要 Win10 上裝完整 Windows 10 SDK（含 makeappx + signtool + WinMDExp）：
```powershell
# winsdksetup.exe 從 https://go.microsoft.com/fwlink/?linkid=2272610
winsdksetup.exe /quiet /norestart
```

工具路徑：
- `C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64\makeappx.exe`
- `C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64\signtool.exe`
- `C:\Program Files (x86)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8.1 Tools\WinMDExp.exe`
- `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（編譯 C# 與 winmdobj）

## 腳本清單

| 腳本 | 用途 |
|---|---|
| `build-msix.ps1` | 生成簡單 demo MSIX (`AspiraMdmDemo-1.0`)：自簽 cert + WinForms hello.exe + makeappx + signtool。用於驗證 install/inventory。 |
| `build-msix-v2.ps1` | 生成 v2 demo MSIX（同 PFN，version 2.0.0.0）。用於驗證 update。 |
| `build-push-msix.ps1` | 生成 push-capable MSIX v1（manifest-only，**真機驗證不夠**，OS 收 push 後因無 background task 而丟棄）。 |
| `build-push-msix-v2.ps1` | 生成 push-capable MSIX v2 含 IBackgroundTask DLL。Identity Name + Publisher 必須符合 Microsoft Partner Center 註冊值，PFN 計算後等於 `.env WNS_PFN`。**這個版本真機跑通 WNS push 秒級觸發**。 |
| `get-pfn.ps1` | 從 Identity Name + Publisher 計算 PFN（SHA-256 UTF-16LE → 8 bytes → custom base32 13 chars）。用於驗證 PFN 一致性。 |

## SSH 跑腳本範本

```bash
B64=$(python3 -c "import base64; print(base64.b64encode(open('docs/scripts/<script>.ps1','r').read().encode('utf-16-le')).decode())")
ssh -i ~/.ssh/win10_mdm_test -o UserKnownHostsFile=$HOME/.ssh/known_hosts.win10mdm AHS@192.168.50.68 "powershell -EncodedCommand $B64"
```

## SCP 取出 .msix

腳本產出在 Win10 的 `C:\Temp\*.msix`，用 SCP 拉回（注意 OpenSSH for Windows 用正斜杠路徑）：

```bash
scp -i ~/.ssh/win10_mdm_test AHS@192.168.50.68:/Temp/AspiraMdmDemo-1.0.msix data/test/
```

## 接手：替換為你自己的應用標識（生產 / 獨立部署必做）

接手團隊**獨立註冊 Microsoft Store / Azure AD 應用**後，必須重 build push MSIX 才能讓 WNS push 走通。完整 6 步：

### Step 1：完成 Microsoft Store + Azure AD 應用註冊

跟著 [`windows-mdm-account-setup.md`](../archived/windows-mdm-account-setup.md) 5 個步驟做完，拿到：
- `WNS_PACKAGE_SID`（`ms-app://S-1-15-2-...`）
- `WNS_CLIENT_SECRET`（Azure 一次性顯示）
- `WNS_PFN`（`<YourPublisherDisplayName>.<YourAppName>_<13-char-hash>`）
- `WNS_STORE_PRODUCT_ID`（`9N9...` 或類似）
- **Identity Publisher GUID**（`CN=<UUID>` 形式，由 Microsoft Store 給的 publisher 字符串）
- **Identity Name**（你 Reserve 的應用名，例如 `YourCorp.YourMDMPush`）

### Step 2：寫進 `.env`

```bash
WNS_PACKAGE_SID=ms-app://<your-package-sid>
WNS_CLIENT_SECRET=<your-client-secret>
WNS_PFN=<your-pfn>
WNS_STORE_PRODUCT_ID=<your-store-product-id>
```

### Step 3：改 `build-push-msix-v2.ps1` 三個變數（**核心動作**）

打開 `docs/scripts/build-push-msix-v2.ps1`，找到 L11-13：

```diff
- $identityName = 'CoGrow.CogrowMDMPush'                              # ← demo 值
- $publisher    = 'CN=27397969-3D59-40F4-A9A2-AEEC09535DB3'           # ← demo 值
- $publisherDN  = 'CoGrow'                                             # ← demo 值
+ $identityName = 'YourCorp.YourMDMPush'                              # ← 改成你的
+ $publisher    = 'CN=<YOUR-PUBLISHER-GUID-FROM-PARTNER-CENTER>'      # ← 改成你的
+ $publisherDN  = 'YourCorp'                                          # ← 改成你的
```

> ⚠️ `$publisher` 必須**逐字符**等於 Microsoft Partner Center 給你的 publisher 字符串（通常是 `CN=<GUID>` 形式）。差一個空格 / 大小寫 PFN 都會算錯。

### Step 4：跑腳本 build + 簽

把改好的 `build-push-msix-v2.ps1` 透過 SSH 在 Win10/11 上跑：

```bash
B64=$(python3 -c "import base64; print(base64.b64encode(open('docs/scripts/build-push-msix-v2.ps1','r').read().encode('utf-16-le')).decode())")
ssh -i <key> <user>@<win-build-machine> "powershell -EncodedCommand $B64"
```

腳本輸出最後會打印 `EXPECTED_PFN: ...`。

### Step 5：用 `get-pfn.ps1` 驗證 PFN 一致

PFN 必須等於 `.env` 的 `WNS_PFN`，否則 WNS 不路由：

```bash
B64=$(python3 -c "import base64; print(base64.b64encode(open('docs/scripts/get-pfn.ps1','r').read().encode('utf-16-le')).decode())")
ssh ... "powershell -EncodedCommand $B64 -ArgumentList 'YourCorp.YourMDMPush' 'CN=<YOUR-GUID>'"
# 輸出應等於 .env WNS_PFN
```

### Step 6：scp 拉回 + 派送

```bash
scp -i <key> <user>@<win-build-machine>:/Temp/YourCorpMDMPush-2.0.msix data/test/

# 接著走 quick-start §7.1 派送 install
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/install \
  -H "Content-Type: application/json" \
  -d "{
    \"packageFamilyName\": \"$WNS_PFN\",
    \"contentUri\": \"https://<ngrok-url>/test/YourCorpMDMPush-2.0.msix\"
  }"
```

完成後 device 上報 ChannelURI 入庫，後續秒級 push 就緒（流程接 quick-start §7.2 / §7.3）。

> 💡 也可以重新生成 `data/test/CogrowMDMPushCert.cer` 並覆蓋（從新 .msix 提取，方法見 [`data/test/README.md` 重 build 場景](../../data/test/README.md#重-build-場景與步驟)），讓客戶端裝到的 cert 跟新 publisher 對得上。

---

## push-capable MSIX manifest 三件套

build-push-msix-v2.ps1 的 manifest 三大關鍵聲明（任缺一個 device 的 OS 都不會把 push 路由到該 PFN）：

```xml
<!-- 1. Application 層的 background task 聲明 -->
<Applications>
  <Application ...>
    <Extensions>
      <Extension Category="windows.backgroundTasks" EntryPoint="CogrowMDMPush.PushHandler">
        <BackgroundTasks>
          <Task Type="pushNotification" />
        </BackgroundTasks>
      </Extension>
    </Extensions>
  </Application>
</Applications>

<!-- 2. Package 層的 in-proc server 聲明（告訴 OS 該 class 在哪個 DLL） -->
<Extensions>
  <Extension Category="windows.activatableClass.inProcessServer">
    <InProcessServer>
      <Path>CogrowMDMPush.dll</Path>
      <ActivatableClass ActivatableClassId="CogrowMDMPush.PushHandler" ThreadingModel="both" />
    </InProcessServer>
  </Extension>
</Extensions>

<!-- 3. Capabilities -->
<Capabilities>
  <rescap:Capability Name="runFullTrust"/>
  <DeviceCapability Name="systemPushNotification"/>
</Capabilities>
```

## winmd + dll 編譯流程

```powershell
# 1. csc /target:winmdobj 產 PE 文件（含 IL + metadata）
csc /target:winmdobj /out:PushHandler.winmdobj `
    /reference:"...\Windows.winmd" `
    /lib:"...\NETFramework\v4.8.1\Facades" `
    /reference:System.Runtime.dll `
    PushHandler.cs

# 2. WinMDExp 提取 metadata 部分 → .winmd（OS 用此驗 manifest 中宣告的 class）
WinMDExp.exe /out:CogrowMDMPush.winmd `
    /reference:"...\mscorlib.dll" `
    /reference:"...\System.dll" `
    /reference:"...\Facades\System.Runtime.dll" `
    /reference:"...\Facades\System.Runtime.InteropServices.dll" `
    /reference:"...\Facades\System.Runtime.InteropServices.WindowsRuntime.dll" `
    /reference:"...\Windows.winmd" `
    PushHandler.winmdobj

# 3. winmdobj 本身就是合法 PE，重命名為 .dll 即實現
Copy-Item PushHandler.winmdobj CogrowMDMPush.dll
```

最終 MSIX 內含 `CogrowMDMPush.winmd` + `CogrowMDMPush.dll`。
