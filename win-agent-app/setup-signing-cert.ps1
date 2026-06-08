<#
.SYNOPSIS
  One-time setup: create a self-signed CodeSigning cert and trust it locally
  so signed .msi files install without UAC complaints during dev / QA.

  PROD use: replace this with an OV CodeSigning cert from Sectigo / SSL.com
  (decision [[msi-code-signing-decision]]). Do NOT use this self-signed cert
  for binaries that ship to real student devices.

.PARAMETER Subject
  Cert subject CN. Default "CoGrow Dev Code Signing".

.PARAMETER YearsValid
  Validity period in years. Default 3.

.OUTPUTS
  Prints the thumbprint to pass into sign.ps1.
#>
[CmdletBinding()]
param(
    [string]$Subject = "CoGrow Dev Code Signing",
    [int]$YearsValid = 3
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

# Reuse existing cert if one with this subject already exists.
$existing = Get-ChildItem Cert:\LocalMachine\My |
    Where-Object { $_.Subject -eq "CN=$Subject" -and $_.HasPrivateKey -and $_.EnhancedKeyUsageList.FriendlyName -contains "Code Signing" } |
    Select-Object -First 1

if ($existing) {
    Write-Host "Existing cert found, reusing it."
    $cert = $existing
} else {
    Write-Host "Creating new self-signed CodeSigning cert..."
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=$Subject" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -CertStoreLocation Cert:\LocalMachine\My `
        -NotAfter (Get-Date).AddYears($YearsValid)
}

Write-Host ""
Write-Host "Subject     : $($cert.Subject)"
Write-Host "Thumbprint  : $($cert.Thumbprint)"
Write-Host "NotAfter    : $($cert.NotAfter)"

# Export public key and re-import into Trusted Root + Trusted Publisher so
# Windows accepts binaries signed with this cert during install.
$cerPath = Join-Path $PSScriptRoot "build\dev-signing.cer"
New-Item -ItemType Directory -Path (Split-Path $cerPath) -Force | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
Write-Host "Exported public cert : $cerPath"

foreach ($store in @("Root", "TrustedPublisher")) {
    $storeRef = New-Object System.Security.Cryptography.X509Certificates.X509Store(
        $store, "LocalMachine")
    $storeRef.Open("ReadWrite")
    $already = $storeRef.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if ($already) {
        Write-Host "Cert already trusted in Cert:\LocalMachine\$store"
    } else {
        $storeRef.Add($cert)
        Write-Host "Imported into Cert:\LocalMachine\$store"
    }
    $storeRef.Close()
}

Write-Host ""
Write-Host "==== DONE ===="
Write-Host "Use this thumbprint with sign.ps1:"
Write-Host "  pwsh -File sign.ps1 -CertThumbprint $($cert.Thumbprint)"
