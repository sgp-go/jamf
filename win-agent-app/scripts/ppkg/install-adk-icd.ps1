# Install Windows ADK ICD (Imaging and Configuration Designer) feature only.
# Pure ASCII comments to avoid PS 5.1 GBK decode issues.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # speed up Invoke-WebRequest

$workDir = "C:\Tools\adk-install"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

# Latest ADK for Windows 11 (works for Win10 PPKG too)
$installerUrl = "https://go.microsoft.com/fwlink/?linkid=2289980"
$installerPath = Join-Path $workDir "adksetup.exe"
$logPath = Join-Path $workDir "install.log"

Write-Host "=== Step 1: Download adksetup.exe ==="
if (Test-Path $installerPath) {
    Write-Host "Already downloaded:" (Get-Item $installerPath).Length "bytes"
} else {
    # BITS needs interactive user session - fails with 0x800704DD over SSH.
    # Invoke-WebRequest works headless; $ProgressPreference=SilentlyContinue
    # is mandatory in PS 5.1 (progress bar makes IWR ~10x slower).
    Write-Host "Downloading from $installerUrl via Invoke-WebRequest..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing -ErrorAction Stop
    Write-Host "Downloaded:" (Get-Item $installerPath).Length "bytes"
}

Write-Host ""
Write-Host "=== Step 2: Silent install ICD feature ==="
Write-Host "(this downloads ~500MB-1GB of ICD bits in background)"
$installerArgs = "/quiet /features OptionId.ImagingAndConfigurationDesigner /norestart /ceip off /log `"$logPath`""
Write-Host "Args: $installerArgs"
$start = Get-Date
$proc = Start-Process -FilePath $installerPath -ArgumentList $installerArgs -PassThru -Wait
$elapsed = (Get-Date) - $start
Write-Host "Installer exit code: $($proc.ExitCode) (elapsed: $([int]$elapsed.TotalSeconds)s)"

Write-Host ""
Write-Host "=== Step 3: Verify ICD.exe present ==="
$icd = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10" -Recurse -Filter "ICD.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($icd) {
    Write-Host "SUCCESS: ICD.exe FOUND at $($icd.FullName)"
} else {
    Write-Host "FAILED: ICD.exe NOT FOUND"
    Write-Host "Last 40 lines of install log:"
    if (Test-Path $logPath) {
        Get-Content $logPath -Tail 40
    } else {
        Write-Host "(install log missing at $logPath)"
    }
    exit 1
}

Write-Host ""
Write-Host "=== Step 4: KitsRoot10 marker ==="
$adk = Get-ItemProperty -Path "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots" -ErrorAction SilentlyContinue
if ($adk -and $adk.KitsRoot10) {
    Write-Host "KitsRoot10:" $adk.KitsRoot10
}
