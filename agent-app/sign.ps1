<#
.SYNOPSIS
  Sign a .exe or .msi with an RFC 3161 timestamp, then verify the signature.

.PARAMETER FilePath
  Path to the .exe or .msi to sign. If omitted, defaults to
  build\msi\CoGrowMDMAgent.msi (the output of build.ps1).

.PARAMETER CertThumbprint
  SHA-1 thumbprint of the code-signing cert in Cert:\LocalMachine\My (we use
  /sm). Get it from setup-signing-cert.ps1 (dev) or your OV cert (prod).

.PARAMETER TimestampUrl
  RFC 3161 timestamp server. Tries each in order until one succeeds.

.PARAMETER SkipVerify
  Skip the post-sign `signtool verify /pa` check.

.EXAMPLE
  pwsh -File sign.ps1 -CertThumbprint A1B2C3... -FilePath build\msi\CoGrowMDMAgent.msi
#>
[CmdletBinding()]
param(
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string]$CertThumbprint,

    [string[]]$TimestampUrl = @(
        "http://timestamp.sectigo.com",
        "http://timestamp.digicert.com",
        "http://rfc3161timestamp.globalsign.com/advanced"
    ),

    [switch]$SkipVerify
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

if (-not $FilePath) {
    $FilePath = Join-Path $PSScriptRoot "build\msi\CoGrowMDMAgent.msi"
}

if (-not (Test-Path $FilePath)) {
    throw "File not found at $FilePath."
}

Write-Host "==== Signing $FilePath ===="
Write-Host "Cert thumbprint: $CertThumbprint"

$signed = $false
foreach ($url in $TimestampUrl) {
    Write-Host "Trying timestamp server: $url"
    & signtool sign `
        /sm `
        /sha1 $CertThumbprint `
        /tr $url `
        /td sha256 `
        /fd sha256 `
        $FilePath
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Signed + timestamped via $url"
        $signed = $true
        break
    }
    Write-Host "  failed (exit $LASTEXITCODE), trying next..."
}

if (-not $signed) {
    throw "All timestamp servers failed."
}

if (-not $SkipVerify) {
    Write-Host ""
    Write-Host "==== Verify ===="
    & signtool verify /pa /v $FilePath
    if ($LASTEXITCODE -ne 0) {
        throw "signtool verify failed ($LASTEXITCODE)"
    }
}

$item = Get-Item $FilePath
$hash = (Get-FileHash $FilePath -Algorithm SHA256).Hash.ToLower()
Write-Host ""
Write-Host "File   : $($item.FullName)"
Write-Host "Size   : $([math]::Round($item.Length/1MB, 2)) MB"
Write-Host "SHA256 : $hash"
