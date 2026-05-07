$ErrorActionPreference = 'Stop'

# Push-capable MSIX v2: 帶 IBackgroundTask DLL，OS 才會路由 raw push 到該 PFN
$tmp        = 'C:\Temp'
$pkgDir     = Join-Path $tmp 'msix-push-pkg-v2'
$assets     = Join-Path $pkgDir 'Assets'
$msixPath   = Join-Path $tmp 'CogrowMDMPush-2.0.msix'
$pfxPath    = Join-Path $tmp 'msix-push-cert.pfx'
$pfxPwdText = 'pushcert1234'

$identityName = 'CoGrow.CogrowMDMPush'
$publisher    = 'CN=27397969-3D59-40F4-A9A2-AEEC09535DB3'
$publisherDN  = 'CoGrow'

# 工具
$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory | Where-Object { $_.Name -match '^10\.' } | Sort-Object Name -Descending
$bin = Join-Path $kits[0].FullName 'x64'
$makeappx = Join-Path $bin 'makeappx.exe'
$signtool = Join-Path $bin 'signtool.exe'
$winmdexp = 'C:\Program Files (x86)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8.1 Tools\WinMDExp.exe'
$csc = (Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64' -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'csc.exe') } | Select-Object -Last 1).FullName + '\csc.exe'

# Windows.winmd（UWP API metadata）
$kitsVer = $kits[0].Name
$windowsWinmd = "C:\Program Files (x86)\Windows Kits\10\UnionMetadata\$kitsVer\Windows.winmd"
if (-not (Test-Path $windowsWinmd)) {
    # 試找其他版本
    $windowsWinmd = (Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\UnionMetadata' -Recurse -Filter 'Windows.winmd' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if (-not $windowsWinmd) { throw 'Windows.winmd not found' }
Write-Output ("Windows.winmd: $windowsWinmd")

# mscorlib facade for winmdobj
$mscorlibFacade = (Get-ChildItem 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETCore\v4.5' -Filter 'mscorlib.dll' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $mscorlibFacade) {
    $mscorlibFacade = (Get-ChildItem 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETCore' -Recurse -Filter 'mscorlib.dll' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}

# ============================================================
# 1. Cert（重用之前的 push cert）
# ============================================================
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $publisher } | Select-Object -First 1
if (-not $cert) { throw 'Push cert not found in Cert:\CurrentUser\My; run build-push-msix.ps1 first to create' }
if (-not (Test-Path $pfxPath)) {
    $pwd = ConvertTo-SecureString -String $pfxPwdText -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
}
Write-Output ('Using cert thumbprint: ' + $cert.Thumbprint)

# ============================================================
# 2. 內容目錄
# ============================================================
if (Test-Path $pkgDir) { Remove-Item $pkgDir -Recurse -Force }
New-Item -ItemType Directory -Path $assets -Force | Out-Null

# pushhost.exe（Application 入口；不真啟動，只是 manifest 必填）
$srcExe = Join-Path $pkgDir 'pushhost.cs'
@'
using System.Windows.Forms;
public class Program {
  [System.STAThread]
  public static void Main() {
    MessageBox.Show("Cogrow MDM Push host", "Cogrow MDM Push");
  }
}
'@ | Out-File -Encoding utf8 -FilePath $srcExe
$exePath = Join-Path $pkgDir 'pushhost.exe'
& $csc /nologo /target:winexe /out:$exePath /reference:System.Windows.Forms.dll $srcExe | Out-Null

# ============================================================
# 3. PushHandler.winmd + PushHandler.dll（UWP background task）
# ============================================================
$srcCs = Join-Path $pkgDir 'PushHandler.cs'
@'
using Windows.ApplicationModel.Background;

namespace CogrowMDMPush {
    public sealed class PushHandler : IBackgroundTask {
        public void Run(IBackgroundTaskInstance taskInstance) {
            // empty — OS routes raw push to this handler so DMClient service can be triggered
        }
    }
}
'@ | Out-File -Encoding utf8 -FilePath $srcCs

# csc /target:winmdobj 编译为 .winmdobj（PE 文件，含 IL + metadata）
$winmdobj = Join-Path $pkgDir 'PushHandler.winmdobj'
$refRoot = 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8.1'
& $csc /nologo /target:winmdobj /out:$winmdobj `
    /reference:"$windowsWinmd" `
    /lib:"$refRoot\Facades" `
    /reference:System.Runtime.dll `
    $srcCs 2>&1 | Out-Null
if (-not (Test-Path $winmdobj)) { throw 'csc winmdobj failed' }

# WinMDExp：提取 metadata 部分 → .winmd（OS 用此檢查 manifest 中宣告的 class）
$winmdOut = Join-Path $pkgDir 'CogrowMDMPush.winmd'
$winmdExpRefs = @(
    "/reference:`"$refRoot\mscorlib.dll`"",
    "/reference:`"$refRoot\System.dll`"",
    "/reference:`"$refRoot\Facades\System.Runtime.dll`"",
    "/reference:`"$refRoot\Facades\System.Runtime.InteropServices.dll`"",
    "/reference:`"$refRoot\Facades\System.Runtime.InteropServices.WindowsRuntime.dll`"",
    "/reference:`"$windowsWinmd`""
)
& $winmdexp /out:$winmdOut @winmdExpRefs $winmdobj 2>&1 | Out-Null
if (-not (Test-Path $winmdOut)) { throw 'WinMDExp failed' }
Write-Output ('Generated winmd: ' + $winmdOut)

# winmdobj 本身就是合法 PE → 改名為 .dll 作為實現
$finalDll = Join-Path $pkgDir 'CogrowMDMPush.dll'
Copy-Item $winmdobj $finalDll -Force

# 清理 .cs / .winmdobj（不放进 MSIX）
Remove-Item $srcCs, $winmdobj -Force -ErrorAction SilentlyContinue
Remove-Item $srcExe -Force -ErrorAction SilentlyContinue

# ============================================================
# 4. AppxManifest.xml — 加 Extensions/backgroundTasks 声明
# ============================================================
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="$identityName" Version="2.0.0.0" Publisher="$publisher" ProcessorArchitecture="x64"/>
  <Properties>
    <DisplayName>Cogrow MDM Push</DisplayName>
    <PublisherDisplayName>$publisherDN</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us"/>
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0"/>
  </Dependencies>
  <Applications>
    <Application Id="App" Executable="pushhost.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Cogrow MDM Push" Description="MDM push receiver" BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png"/>
      <Extensions>
        <Extension Category="windows.backgroundTasks" EntryPoint="CogrowMDMPush.PushHandler">
          <BackgroundTasks>
            <Task Type="pushNotification" />
          </BackgroundTasks>
        </Extension>
      </Extensions>
    </Application>
  </Applications>
  <Extensions>
    <Extension Category="windows.activatableClass.inProcessServer">
      <InProcessServer>
        <Path>CogrowMDMPush.dll</Path>
        <ActivatableClass ActivatableClassId="CogrowMDMPush.PushHandler" ThreadingModel="both" />
      </InProcessServer>
    </Extension>
  </Extensions>
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
    <DeviceCapability Name="systemPushNotification"/>
  </Capabilities>
</Package>
"@
$manifest | Out-File -Encoding utf8 -FilePath (Join-Path $pkgDir 'AppxManifest.xml')

# ============================================================
# 5. 资源 PNG（橙色 v2）
# ============================================================
Add-Type -AssemblyName System.Drawing
function New-LogoPng([string]$path, [int]$size, [string]$colorName) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromName($colorName))
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
New-LogoPng (Join-Path $assets 'StoreLogo.png') 50 'DarkOrange'
New-LogoPng (Join-Path $assets 'Square150x150Logo.png') 150 'DarkOrange'
New-LogoPng (Join-Path $assets 'Square44x44Logo.png') 44 'DarkOrange'

# ============================================================
# 6. Pack + Sign
# ============================================================
if (Test-Path $msixPath) { Remove-Item $msixPath -Force }

# 列出 pack dir 内容验证
Write-Output 'Package contents:'
Get-ChildItem $pkgDir -Recurse | ForEach-Object { Write-Output ('  ' + $_.FullName.Substring($pkgDir.Length + 1)) }

& $makeappx pack /d $pkgDir /p $msixPath /o
if (-not (Test-Path $msixPath)) { throw 'makeappx pack failed' }
& $signtool sign /fd SHA256 /a /f $pfxPath /p $pfxPwdText $msixPath
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed: $LASTEXITCODE" }

$hash = (Get-FileHash $msixPath -Algorithm SHA256).Hash
Write-Output '======== RESULT ========'
Write-Output ("MSIX_PATH: $msixPath")
Write-Output ("MSIX_SHA256: $hash")
Write-Output ("MSIX_SIZE: " + (Get-Item $msixPath).Length)
