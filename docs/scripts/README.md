# Win10 真機驗證 PowerShell 腳本

這些腳本在 Win10 上跑（透過 SSH `powershell -EncodedCommand`），生成簽名 MSIX 與計算 PFN，配合 `src/mdm/windows/` 真機驗證使用。

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
