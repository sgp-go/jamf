$ErrorActionPreference = 'Stop'

# v2 MSIX：同 PFN，version 2.0.0.0；hello.exe 弹不同 message
$tmp        = 'C:\Temp'
$pkgDir     = Join-Path $tmp 'msix-pkg-v2'
$assets     = Join-Path $pkgDir 'Assets'
$msixPath   = Join-Path $tmp 'AspiraMdmDemo-2.0.msix'
$pfxPath    = Join-Path $tmp 'msix-cert.pfx'
$pfxPwdText = 'test1234'
$publisherCN = 'CN=Aspira-MDM-Test, O=Aspira, C=TW'

# SDK 工具
$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory | Where-Object { $_.Name -match '^10\.' } | Sort-Object Name -Descending
$bin = Join-Path $kits[0].FullName 'x64'
$makeappx = Join-Path $bin 'makeappx.exe'
$signtool = Join-Path $bin 'signtool.exe'

# 重置 v2 工作目录
if (Test-Path $pkgDir) { Remove-Item $pkgDir -Recurse -Force }
New-Item -ItemType Directory -Path $assets -Force | Out-Null

# 编译 v2 hello.exe
$srcPath = Join-Path $pkgDir 'hello.cs'
@'
using System.Windows.Forms;
public class Program {
  [System.STAThread]
  public static void Main() {
    MessageBox.Show("Hello from MDM HostedInstall! v2.0 (UPDATED)", "Aspira MDM Demo");
  }
}
'@ | Out-File -Encoding utf8 -FilePath $srcPath

$csc = (Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64' -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'csc.exe') } | Select-Object -Last 1).FullName + '\csc.exe'
$exePath = Join-Path $pkgDir 'hello.exe'
& $csc /nologo /target:winexe /out:$exePath /reference:System.Windows.Forms.dll $srcPath | Out-Null
if (-not (Test-Path $exePath)) { throw 'hello.exe v2 compile failed' }

# AppxManifest.xml — Identity Name 同 v1，Version 改 2.0.0.0
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="AspiraMDM.Demo" Version="2.0.0.0" Publisher="$publisherCN" ProcessorArchitecture="x64"/>
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
      <uap:VisualElements DisplayName="Aspira MDM Demo" Description="MDM HostedInstall test v2" BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png"/>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
  </Capabilities>
</Package>
"@
$manifest | Out-File -Encoding utf8 -FilePath (Join-Path $pkgDir 'AppxManifest.xml')

# 资源 (v2 用绿色区分)
Add-Type -AssemblyName System.Drawing
function New-LogoPng([string]$path, [int]$size, [string]$colorName) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromName($colorName))
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
New-LogoPng (Join-Path $assets 'StoreLogo.png') 50 'ForestGreen'
New-LogoPng (Join-Path $assets 'Square150x150Logo.png') 150 'ForestGreen'
New-LogoPng (Join-Path $assets 'Square44x44Logo.png') 44 'ForestGreen'

# Pack + Sign
if (Test-Path $msixPath) { Remove-Item $msixPath -Force }
& $makeappx pack /d $pkgDir /p $msixPath /o | Out-Null
& $signtool sign /fd SHA256 /a /f $pfxPath /p $pfxPwdText $msixPath | Out-Null

$hash = (Get-FileHash $msixPath -Algorithm SHA256).Hash
Write-Output '======== RESULT v2 ========'
Write-Output ("MSIX_PATH: $msixPath")
Write-Output ("MSIX_SHA256: $hash")
Write-Output ("MSIX_SIZE: " + (Get-Item $msixPath).Length)
