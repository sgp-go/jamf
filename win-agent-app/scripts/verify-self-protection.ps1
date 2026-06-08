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
$SvcCfgKey   = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
$ArpKey      = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"

# SC_ACTION_TYPE constants from winsvc.h (SC_ACTION_RESTART = 1)
$SC_ACTION_RESTART = 1

$failures = @()

# ------------------------------------------------------------------
# 1. Service Recovery — read FailureActions REG_BINARY directly.
#
#    Avoids sc.exe whose output is localized (zh-CN renders RESTART as
#    chongxinqidong) and additionally corrupted when PowerShell decodes
#    GBK console bytes. The registry blob is binary, locale-free.
#
#    REG_BINARY layout of FailureActions (Windows SERVICE_FAILURE_ACTIONS
#    on-disk serialization):
#      [ 0..3 ]  DWORD  dwResetPeriod (seconds)
#      [ 4..7 ]  DWORD  offset of lpRebootMsg (0 if NULL)
#      [ 8..11]  DWORD  offset of lpCommand   (0 if NULL)
#      [12..15]  DWORD  cActions
#      [16..19]  DWORD  offset of SC_ACTION[] (usually 20 = inline)
#      [20..  ]  SC_ACTION[] { DWORD Type; DWORD Delay; }  -- cActions entries
# ------------------------------------------------------------------
Write-Host "[1/3] Checking Service Recovery for $ServiceName ..."
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    $failures += "Service $ServiceName not installed. Run msiexec /i CoGrowMDMAgent.msi first."
} else {
    $fa = (Get-ItemProperty $SvcCfgKey -ErrorAction SilentlyContinue).FailureActions
    if (-not $fa -or $fa.Length -lt 20) {
        $failures += "Service Recovery missing: FailureActions REG_BINARY not configured at $SvcCfgKey (got $($fa.Length) bytes)"
    } else {
        $resetPeriod = [BitConverter]::ToUInt32($fa, 0)
        $cActions    = [BitConverter]::ToUInt32($fa, 12)
        $actionsOff  = [BitConverter]::ToUInt32($fa, 16)
        Write-Host ("  ResetPeriod = {0} sec ({1} days)" -f $resetPeriod, [math]::Round($resetPeriod / 86400.0, 2))
        Write-Host ("  cActions    = $cActions  (offset=$actionsOff)")

        $restartCount = 0
        for ($i = 0; $i -lt $cActions; $i++) {
            $off = $actionsOff + $i * 8
            if ($off + 8 -gt $fa.Length) { break }
            $type  = [BitConverter]::ToUInt32($fa, $off)
            $delay = [BitConverter]::ToUInt32($fa, $off + 4)
            $name  = if ($type -eq $SC_ACTION_RESTART) { "RESTART" } else { "type=$type" }
            Write-Host ("  action[$i]   $name delay=${delay}ms")
            if ($type -eq $SC_ACTION_RESTART) { $restartCount++ }
        }

        if ($restartCount -lt 3) {
            $failures += "Service Recovery missing: expected 3x SC_ACTION_RESTART (Type=1), found $restartCount"
        } else {
            Write-Host "  PASS: $restartCount RESTART actions configured."
        }
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
