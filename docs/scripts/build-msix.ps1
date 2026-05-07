$ErrorActionPreference = 'Stop'

# ============================================================
# 參數
# ============================================================
$tmp        = 'C:\Temp'
$pkgDir     = Join-Path $tmp 'msix-pkg'
$assets     = Join-Path $pkgDir 'Assets'
$msixPath   = Join-Path $tmp 'AspiraMdmDemo-1.0.msix'
$pfxPath    = Join-Path $tmp 'msix-cert.pfx'
$cerPath    = Join-Path $tmp 'msix-cert.cer'
$pfxPwdText = 'test1234'
$publisherCN = 'CN=Aspira-MDM-Test, O=Aspira, C=TW'

# ============================================================
# 1. SDK 工具鏈定位
# ============================================================
$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory -ErrorAction Stop | Where-Object { $_.Name -match '^10\.' } | Sort-Object Name -Descending
if (-not $kits) { throw 'No Windows SDK found' }
$bin = Join-Path $kits[0].FullName 'x64'
$makeappx = Join-Path $bin 'makeappx.exe'
$signtool = Join-Path $bin 'signtool.exe'
if (-not (Test-Path $makeappx)) { throw "makeappx not found: $makeappx" }
if (-not (Test-Path $signtool)) { throw "signtool not found: $signtool" }
Write-Output ('Using SDK bin: ' + $bin)

# ============================================================
# 2. 自簽 code-signing 證書 + 安裝到 TrustedRoot + TrustedPeople
# ============================================================
$existing = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -eq $publisherCN }
if ($existing) {
    Write-Output ('Reusing existing cert: ' + $existing.Thumbprint)
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $publisherCN } | Select-Object -First 1
    if (-not $cert) {
        # 證書在 LocalMachine 但不在 CurrentUser，重新生成
        $cert = New-SelfSignedCertificate -Type CodeSigningCert `
            -Subject $publisherCN `
            -KeyAlgorithm RSA -KeyLength 2048 `
            -NotAfter (Get-Date).AddYears(5) `
            -CertStoreLocation 'Cert:\CurrentUser\My'
    }
} else {
    Write-Output 'Creating new self-signed code signing cert...'
    $cert = New-SelfSignedCertificate -Type CodeSigningCert `
        -Subject $publisherCN `
        -KeyAlgorithm RSA -KeyLength 2048 `
        -NotAfter (Get-Date).AddYears(5) `
        -CertStoreLocation 'Cert:\CurrentUser\My'

    # Export PFX (含私鑰，用於 signtool)
    $pwd = ConvertTo-SecureString -String $pfxPwdText -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null

    # Export CER (公鑰) 安裝到 TrustedRoot + TrustedPeople（MSIX sideload 強制要求）
    Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
    Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
    Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
}
Write-Output ('Cert thumbprint: ' + $cert.Thumbprint)

# 確保 PFX 存在（之前 cert 已存在但 pfx 被刪的情境）
if (-not (Test-Path $pfxPath)) {
    $pwd = ConvertTo-SecureString -String $pfxPwdText -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
}

# ============================================================
# 3. MSIX 內容目錄 + 編譯 hello.exe
# ============================================================
if (Test-Path $pkgDir) { Remove-Item $pkgDir -Recurse -Force }
New-Item -ItemType Directory -Path $assets -Force | Out-Null

# .NET csc 編譯 WinForm hello.exe
$srcPath = Join-Path $pkgDir 'hello.cs'
@'
using System.Windows.Forms;
public class Program {
  [System.STAThread]
  public static void Main() {
    MessageBox.Show("Hello from MDM HostedInstall! v1.0", "Aspira MDM Demo");
  }
}
'@ | Out-File -Encoding utf8 -FilePath $srcPath

$csc = (Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64' -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'csc.exe') } | Select-Object -Last 1).FullName + '\csc.exe'
Write-Output ('Using csc: ' + $csc)
$exePath = Join-Path $pkgDir 'hello.exe'
& $csc /nologo /target:winexe /out:$exePath /reference:System.Windows.Forms.dll $srcPath | Out-Null
if (-not (Test-Path $exePath)) { throw 'hello.exe compile failed' }

# ============================================================
# 4. AppxManifest.xml
# ============================================================
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="AspiraMDM.Demo" Version="1.0.0.0" Publisher="$publisherCN" ProcessorArchitecture="x64"/>
  <Properties>
    <DisplayName>Aspira MDM Demo</DisplayName>
    <PublisherDisplayName>Aspira</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us"/>
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0"/>
  </Dependencies>
  <Applications>
    <Application Id="App" Executable="hello.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Aspira MDM Demo" Description="MDM HostedInstall test" BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png"/>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
  </Capabilities>
</Package>
"@
$manifest | Out-File -Encoding utf8 -FilePath (Join-Path $pkgDir 'AppxManifest.xml')

# ============================================================
# 5. 生成最簡單 PNG icons（純色塊）
# ============================================================
Add-Type -AssemblyName System.Drawing
function New-LogoPng([string]$path, [int]$size, [string]$colorName) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromName($colorName))
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
New-LogoPng (Join-Path $assets 'StoreLogo.png') 50 'DodgerBlue'
New-LogoPng (Join-Path $assets 'Square150x150Logo.png') 150 'DodgerBlue'
New-LogoPng (Join-Path $assets 'Square44x44Logo.png') 44 'DodgerBlue'

# ============================================================
# 6. makeappx pack
# ============================================================
if (Test-Path $msixPath) { Remove-Item $msixPath -Force }
& $makeappx pack /d $pkgDir /p $msixPath /o | Out-Null
if (-not (Test-Path $msixPath)) { throw 'makeappx pack failed' }

# ============================================================
# 7. signtool sign
# ============================================================
& $signtool sign /fd SHA256 /a /f $pfxPath /p $pfxPwdText $msixPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed: $LASTEXITCODE" }

# ============================================================
# 8. 結果
# ============================================================
$hash = (Get-FileHash $msixPath -Algorithm SHA256).Hash
$size = (Get-Item $msixPath).Length
Write-Output '======== RESULT ========'
Write-Output ("MSIX_PATH: $msixPath")
Write-Output ("MSIX_SHA256: $hash")
Write-Output ("MSIX_SIZE: $size")
Write-Output ("CERT_THUMBPRINT: " + $cert.Thumbprint)
Write-Output ('PFN: AspiraMDM.Demo_' + ($cert.Thumbprint.Substring(0,8).ToLower()))
Write-Output 'NOTE: Real PFN computed by Windows from Identity Name + Publisher hash; use Get-AppxPackage after install for exact value.'
