<#
.SYNOPSIS
  Verifies CoGrow MDM Agent self-protection settings after MSI install.

.DESCRIPTION
  Run on a Win10 target after CoGrowMDMAgent.msi has been installed. Checks
  all three pillars added in W3 main-track 5b:

    1. Service Recovery: sc.exe qfailure CoGrowMDMAgent → expect 3x restart
    2. Registry ACL:     HKLM\SOFTWARE\Policies\CoGrowMDM\Agent ACL has
                         only SYSTEM/Administrators full + Users read
    3. ARP visibility:   product hidden from Settings / Apps list
                         (ARPSYSTEMCOMPONENT=1)

  Exits 0 if all three pass; 1 on any failure (suitable for CI / SCP loop).

.NOTES
  ASCII-only output (PS 5.1 default codepage; non-ASCII garbles).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ServiceName = "CoGrowMDMAgent"
$RegPath     = "HKLM:\SOFTWARE\Policies\CoGrowMDM\Agent"
$ArpKey      = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"

$failures = @()

# ------------------------------------------------------------------
# 1. Service Recovery (sc qfailure)
# ------------------------------------------------------------------
Write-Host "[1/3] Checking Service Recovery for $ServiceName ..."
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    $failures += "Service $ServiceName not installed. Run msiexec /i CoGrowMDMAgent.msi first."
} else {
    $qfailureRaw = & sc.exe qfailure $ServiceName 2>&1 | Out-String
    Write-Host $qfailureRaw

    # Expect: RESTART -- Delay = 5000 milliseconds three times
    $restartCount = ([regex]::Matches($qfailureRaw, "RESTART")).Count
    if ($restartCount -lt 3) {
        $failures += "Service Recovery missing: expected 3x RESTART, found $restartCount"
    } else {
        Write-Host "  PASS: $restartCount RESTART actions configured."
    }
}

# ------------------------------------------------------------------
# 2. Registry ACL on HKLM\SOFTWARE\Policies\CoGrowMDM\Agent
# ------------------------------------------------------------------
Write-Host ""
Write-Host "[2/3] Checking Registry ACL on $RegPath ..."
if (-not (Test-Path $RegPath)) {
    $failures += "Registry key $RegPath not found. MSI install incomplete."
} else {
    $acl = Get-Acl $RegPath
    $aclSummary = $acl.Access | ForEach-Object {
        "{0,-40} {1,-20} {2}" -f $_.IdentityReference, $_.RegistryRights, $_.AccessControlType
    } | Out-String
    Write-Host $aclSummary

    $usersAce = $acl.Access | Where-Object {
        $_.IdentityReference.Value -match "\\Users$" -or $_.IdentityReference.Value -eq "BUILTIN\Users"
    }
    if (-not $usersAce) {
        $failures += "Users ACE missing on $RegPath (PermissionEx did not apply)"
    } elseif ($usersAce.RegistryRights -band [System.Security.AccessControl.RegistryRights]::WriteKey) {
        $failures += "Users still has WriteKey on $RegPath (ACL lockdown failed)"
    } else {
        Write-Host "  PASS: Users has read-only access (no WriteKey)."
    }
}

# ------------------------------------------------------------------
# 3. ARPSYSTEMCOMPONENT hides product from Settings/Apps
# ------------------------------------------------------------------
Write-Host ""
Write-Host "[3/3] Checking ARP visibility (ARPSYSTEMCOMPONENT=1) ..."
$arpEntries = Get-ChildItem $ArpKey -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PsPath -ErrorAction SilentlyContinue
    if ($p.DisplayName -like "CoGrow MDM Agent*") { $p }
}
if (-not $arpEntries) {
    Write-Host "  PASS: No CoGrow MDM Agent entry in ARP (hidden by ARPSYSTEMCOMPONENT)."
} else {
    foreach ($entry in $arpEntries) {
        $sysComp = if ($entry.PSObject.Properties["SystemComponent"]) { $entry.SystemComponent } else { 0 }
        if ($sysComp -ne 1) {
            $failures += "ARP entry visible: SystemComponent=$sysComp (expected 1)"
        } else {
            Write-Host "  PASS: ARP entry SystemComponent=1 (hidden)."
        }
    }
}

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
Write-Host ""
Write-Host "===================================================="
if ($failures.Count -eq 0) {
    Write-Host "ALL CHECKS PASSED"
    exit 0
} else {
    Write-Host "FAILURES:"
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}
