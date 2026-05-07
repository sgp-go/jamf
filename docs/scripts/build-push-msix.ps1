$ErrorActionPreference = 'Stop'

# Push-capable MSIX (Identity 必須與 Microsoft Store 註冊一致)
$tmp        = 'C:\Temp'
$pkgDir     = Join-Path $tmp 'msix-push-pkg'
$assets     = Join-Path $pkgDir 'Assets'
$msixPath   = Join-Path $tmp 'CogrowMDMPush-1.0.msix'
$pfxPath    = Join-Path $tmp 'msix-push-cert.pfx'
$cerPath    = Join-Path $tmp 'msix-push-cert.cer'
$pfxPwdText = 'pushcert1234'

# Microsoft Partner Center 註冊值（不可改）
$identityName = 'CoGrow.CogrowMDMPush'
$publisher    = 'CN=27397969-3D59-40F4-A9A2-AEEC09535DB3'
$publisherDN  = 'CoGrow'

# SDK 工具
$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory | Where-Object { $_.Name -match '^10\.' } | Sort-Object Name -Descending
$bin = Join-Path $kits[0].FullName 'x64'
$makeappx = Join-Path $bin 'makeappx.exe'
$signtool = Join-Path $bin 'signtool.exe'

# ============================================================
# 1. 自簽 cert，Subject 必須匹配 Publisher
# ============================================================
$existing = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -eq $publisher }
if ($existing) {
    Write-Output ('Reusing cert: ' + $existing.Thumbprint)
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $publisher } | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $publisher `
            -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(5) `
            -CertStoreLocation 'Cert:\CurrentUser\My'
    }
} else {
    Write-Output 'Creating self-signed cert for push MSIX...'
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $publisher `
        -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(5) `
        -CertStoreLocation 'Cert:\CurrentUser\My'
    $pwd = ConvertTo-SecureString -String $pfxPwdText -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
    Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
    Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
    Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
}
Write-Output ('Cert thumbprint: ' + $cert.Thumbprint)

if (-not (Test-Path $pfxPath)) {
    $pwd = ConvertTo-SecureString -String $pfxPwdText -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
}

# ============================================================
# 2. 內容目錄
# ============================================================
if (Test-Path $pkgDir) { Remove-Item $pkgDir -Recurse -Force }
New-Item -ItemType Directory -Path $assets -Force | Out-Null

# 編譯一個極簡 hello.exe（雖然 push 場景不真的啟動 UI，但 manifest 需要 entry executable）
$srcPath = Join-Path $pkgDir 'pushhost.cs'
@'
using System.Windows.Forms;
public class Program {
  [System.STAThread]
  public static void Main() {
    MessageBox.Show("Cogrow MDM Push host (do not run directly)", "Cogrow MDM Push");
  }
}
'@ | Out-File -Encoding utf8 -FilePath $srcPath
$csc = (Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64' -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'csc.exe') } | Select-Object -Last 1).FullName + '\csc.exe'
$exePath = Join-Path $pkgDir 'pushhost.exe'
& $csc /nologo /target:winexe /out:$exePath /reference:System.Windows.Forms.dll $srcPath | Out-Null

# ============================================================
# 3. AppxManifest.xml — 含 push 接收聲明（試 manifest-only，無 background task DLL）
# ============================================================
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="$identityName" Version="1.0.0.0" Publisher="$publisher" ProcessorArchitecture="x64"/>
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
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
    <DeviceCapability Name="systemPushNotification"/>
  </Capabilities>
</Package>
"@
$manifest | Out-File -Encoding utf8 -FilePath (Join-Path $pkgDir 'AppxManifest.xml')

# ============================================================
# 4. 資源 PNG（純色）
# ============================================================
Add-Type -AssemblyName System.Drawing
function New-LogoPng([string]$path, [int]$size, [string]$colorName) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromName($colorName))
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
New-LogoPng (Join-Path $assets 'StoreLogo.png') 50 'OrangeRed'
New-LogoPng (Join-Path $assets 'Square150x150Logo.png') 150 'OrangeRed'
New-LogoPng (Join-Path $assets 'Square44x44Logo.png') 44 'OrangeRed'

# ============================================================
# 5. Pack + Sign
# ============================================================
if (Test-Path $msixPath) { Remove-Item $msixPath -Force }
& $makeappx pack /d $pkgDir /p $msixPath /o
if (-not (Test-Path $msixPath)) { throw 'makeappx pack failed' }
& $signtool sign /fd SHA256 /a /f $pfxPath /p $pfxPwdText $msixPath
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed: $LASTEXITCODE" }

# ============================================================
# 6. 結果
# ============================================================
$hash = (Get-FileHash $msixPath -Algorithm SHA256).Hash
Write-Output '======== RESULT ========'
Write-Output ("MSIX_PATH: $msixPath")
Write-Output ("MSIX_SHA256: $hash")
Write-Output ("MSIX_SIZE: " + (Get-Item $msixPath).Length)
Write-Output ("EXPECTED_PFN: CoGrow.CogrowMDMPush_r2dv7jx02rjxr")
