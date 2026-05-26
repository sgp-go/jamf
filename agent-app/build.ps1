<#
.SYNOPSIS
  Builds CoGrowMDMAgent.msi end-to-end: dotnet publish → wix build.

.PARAMETER Configuration
  Release (default) or Debug.

.PARAMETER Version
  Product version written into the .msi (e.g. 1.0.0.0).

.PARAMETER SelfContained
  Default $true. Produces a single-file .exe that includes the .NET 8 runtime,
  so target devices don't need to have .NET installed.

.EXAMPLE
  pwsh -File build.ps1
  pwsh -File build.ps1 -Version 1.0.1.0
#>
[CmdletBinding()]
param(
    [ValidateSet("Release", "Debug")]
    [string]$Configuration = "Release",

    [string]$Version = "1.0.0.0",

    [bool]$SelfContained = $true
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$publishDir = Join-Path $root "build\publish"
$msiDir     = Join-Path $root "build\msi"

Write-Host ""
Write-Host "==== 1. dotnet publish CoGrowMDMAgent ($Configuration, self-contained=$SelfContained) ===="
if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }

$publishArgs = @(
    "publish",
    "$root\src\CoGrowMDMAgent\CoGrowMDMAgent.csproj",
    "-c", $Configuration,
    "-r", "win-x64",
    "--self-contained", $SelfContained.ToString().ToLower(),
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:PublishTrimmed=false",
    "-p:DebugType=embedded",
    "-o", $publishDir,
    "--nologo"
)
& dotnet @publishArgs
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }

Write-Host ""
Write-Host "--- publish output ---"
Get-ChildItem $publishDir | Select-Object Name, @{N="MB";E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize

Write-Host ""
Write-Host "==== 2. wix build CoGrowMDMAgent.msi ===="
if (Test-Path $msiDir) { Remove-Item $msiDir -Recurse -Force }
New-Item -ItemType Directory -Path $msiDir -Force | Out-Null

$wixArgs = @(
    "build",
    "$root\src\CoGrowMDMAgent.Installer\CoGrowMDMAgent.Installer.wixproj",
    "-c", $Configuration,
    "-p:PublishDir=$publishDir",
    "-p:ProductVersion=$Version",
    "-o", $msiDir,
    "--nologo"
)
& dotnet @wixArgs
if ($LASTEXITCODE -ne 0) { throw "wix build failed ($LASTEXITCODE)" }

Write-Host ""
Write-Host "==== Done ===="
$msi = Get-ChildItem "$msiDir\*.msi" | Select-Object -First 1
if (-not $msi) { throw "no .msi produced" }
$hash = (Get-FileHash $msi.FullName -Algorithm SHA256).Hash.ToLower()
Write-Host "File   : $($msi.FullName)"
Write-Host "Size   : $([math]::Round($msi.Length/1MB, 2)) MB"
Write-Host "SHA256 : $hash"
