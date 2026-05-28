# Build PPKG from customization XML using ICD.exe.
# Pure ASCII comments.

$ErrorActionPreference = "Stop"

$workDir = "C:\Tools\ppkg-build"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$icd = "C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Imaging and Configuration Designer\x86\ICD.exe"
$xmlPath = "C:\Users\Administrator\ppkg-minimal.xml"
$ppkgPath = Join-Path $workDir "ppkg-minimal.ppkg"

if (Test-Path $ppkgPath) { Remove-Item $ppkgPath -Force }

Write-Host "=== Build PPKG ==="
Write-Host "ICD:       $icd"
Write-Host "Input XML: $xmlPath"
Write-Host "Output:    $ppkgPath"
Write-Host ""

$start = Get-Date
# ICD CLI boolean parsing is finicky - omit Encrypted/Overwrite (defaults work).
# Pre-delete output above means Overwrite is moot.
& $icd /Build-ProvisioningPackage /CustomizationXML:$xmlPath /PackagePath:$ppkgPath
$exit = $LASTEXITCODE
$elapsed = (Get-Date) - $start
Write-Host ""
Write-Host "ICD exit code: $exit (elapsed: $([int]$elapsed.TotalSeconds)s)"

Write-Host ""
Write-Host "=== Verify output ==="
if (Test-Path $ppkgPath) {
    $f = Get-Item $ppkgPath
    Write-Host "PPKG built: $($f.FullName)"
    Write-Host "Size: $($f.Length) bytes"
    Write-Host ""
    Write-Host "=== File magic (first 8 bytes hex; CAB starts with MSCF=4D 53 43 46) ==="
    $bytes = [System.IO.File]::ReadAllBytes($ppkgPath) | Select-Object -First 8
    Write-Host ($bytes | ForEach-Object { $_.ToString("X2") }) -Separator " "
} else {
    Write-Host "PPKG NOT FOUND - build failed"
    exit 1
}
