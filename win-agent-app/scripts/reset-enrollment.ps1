#Requires -Version 5.1
<#
.SYNOPSIS
  徹底清除 CoGrow MDM enroll 狀態，回到「乾淨設備、可重新雙擊 PPKG」的狀態。

.DESCRIPTION
  救火腳本。當 enrollment 卡住（裝過 agent 但卸不掉、PPKG 重裝被 Windows dedup
  跳過 enrollment workflow、Settings UI 看不到企業/學校資源等）執行此腳本，
  把設備上跟我方 MDM 相關的殘留全部硬拆，**不走 OMA-DM Unenroll**——
  此時假設後端已經連不上、或對接團隊根本不想等遠端。

  清除範圍（與 agent 內 PpkgRemovalWatcher 的「軟拆」對比）：
    1. CoGrow Agent service + MSI + Program Files
    2. CoGrow Agent state registry（含 SelfUninstallTriggered 持久標誌）
    3. 已安裝 PPKG：Uninstall-ProvisioningPackage + 刪 .ppkg + AssetCache
    4. PPKG dedup 殘留（EnterpriseResourceManager / PolicyManager / Provisioning
       下 8 處按 PackageID 索引的痕跡 + knobs + OOBEPackage）
    5. DMClient enrollment registry（HKLM\SOFTWARE\Microsoft\Enrollments\{GUID}）
    6. EnterpriseMgmt scheduled tasks（\Microsoft\Windows\EnterpriseMgmt\{GUID}\*）
    7. PolicyManager AdmxInstalled / AdmxDefault / current 下按 enrollment GUID 索引
    8. DM device cert（LocalMachine\My，Subject=enrollment GUID）

.PARAMETER EnrollmentFilter
  enrollment 識別關鍵字（substring，case-insensitive，逗號分隔，匹配
  DiscoveryServiceFullURL / ProviderID / UPN 三個字段）。預設值含我方自建 MDM
  enrollment 的固定標誌：`/EnrollmentServer/Discovery`（自建 MDM 路徑後綴）+
  `school.local`（generic PPKG 寫的 UPN domain）+ `aspirapes` + `cogrow`。避免
  誤拆機器上其他合法 MDM（如 Intune）。明確只有我方 MDM 時可傳 '*' 清全部。

.PARAMETER PpkgFilter
  PPKG 名稱過濾關鍵字（substring，case-insensitive，逗號分隔）。預設只清
  PackageName 含 'cogrow' 的 PPKG，避免誤拆 OEM 預載的 PPKG（如
  Intel.Power.Settings.Processor）。傳 '*' 清全部。

.PARAMETER DryRun
  只列出將要刪除的對象，不實際執行。

.EXAMPLE
  .\reset-enrollment.ps1
  .\reset-enrollment.ps1 -DryRun
  .\reset-enrollment.ps1 -EnrollmentFilter '*' -PpkgFilter '*'

.NOTES
  必須以系統管理員權限執行。執行完建議重新開機後再雙擊新的 PPKG enroll。
#>

[CmdletBinding()]
param(
  [string] $EnrollmentFilter = '/EnrollmentServer/Discovery,school.local,aspirapes,cogrow',
  [string] $PpkgFilter = 'cogrow',
  [switch] $DryRun
)

function Test-NameMatch {
  param([string]$Name, [string]$FilterCsv)
  $filters = $FilterCsv.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  foreach ($f in $filters) {
    if ($f -eq '*') { return $true }
    if ($Name -like "*$f*") { return $true }
  }
  return $false
}

$ErrorActionPreference = 'Continue'
$script:Actions = New-Object System.Collections.Generic.List[string]
$script:Errors  = New-Object System.Collections.Generic.List[string]

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step([string]$msg)   { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Do([string]$msg)     { Write-Host "    $msg" -ForegroundColor Gray; $script:Actions.Add($msg) }
function Write-Warn2([string]$msg)  { Write-Host "    [warn] $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg)    { Write-Host "    [err]  $msg" -ForegroundColor Red;    $script:Errors.Add($msg)  }

function Invoke-Action {
  param([string]$Label, [scriptblock]$Action)
  Write-Do $Label
  if ($DryRun) { return }
  try { & $Action } catch { Write-Err "$Label : $($_.Exception.Message)" }
}

if (-not (Test-Admin)) {
  Write-Host "需以系統管理員身分執行（右鍵 PowerShell → 以系統管理員身分執行）" -ForegroundColor Red
  exit 1
}

if ($DryRun) { Write-Host "[DryRun] 只列出將要操作的對象，不會實際執行" -ForegroundColor Yellow }

# ── 1. 停 + 卸 CoGrow Agent ────────────────────────────────────────────────
Write-Step "1/8 停止並卸載 CoGrow Agent"

$agentService = Get-Service -Name 'CoGrowMDMAgent' -ErrorAction SilentlyContinue
if ($agentService) {
  Invoke-Action "停止 service: CoGrowMDMAgent (狀態=$($agentService.Status))" {
    Stop-Service -Name 'CoGrowMDMAgent' -Force -ErrorAction Stop
  }
} else {
  Write-Do "service CoGrowMDMAgent 不存在，跳過"
}

# 找 ProductCode 卸 MSI（不依賴 Win32_Product，太慢且會觸發 reconfigure）
$uninstallRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$agentProductCodes = foreach ($root in $uninstallRoots) {
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.DisplayName -like 'CoGrow*' -or $p.Publisher -like '*CoGrow*') {
      [PSCustomObject]@{ Name = $p.DisplayName; Code = $_.PSChildName }
    }
  }
}
if ($agentProductCodes) {
  foreach ($pc in $agentProductCodes) {
    Invoke-Action "msiexec /x $($pc.Code) /qn /norestart  ($($pc.Name))" {
      $proc = Start-Process msiexec.exe -ArgumentList "/x $($pc.Code) /qn /norestart" -Wait -PassThru -NoNewWindow
      if ($proc.ExitCode -notin 0,1605,3010) { throw "msiexec 返回 $($proc.ExitCode)" }
    }
  }
} else {
  Write-Do "未找到 CoGrow MSI 註冊，跳過"
}

# 兜底刪 service（卸載後通常已消失）
Invoke-Action "兜底 sc.exe delete CoGrowMDMAgent" {
  & sc.exe delete CoGrowMDMAgent 2>$null | Out-Null
}

# 兜底刪安裝目錄
foreach ($p in @('C:\Program Files\CoGrow', 'C:\Program Files (x86)\CoGrow', 'C:\ProgramData\CoGrow')) {
  if (Test-Path $p) {
    Invoke-Action "刪除目錄 $p" { Remove-Item $p -Recurse -Force -ErrorAction Stop }
  }
}

# ── 2. CoGrow Agent state registry ────────────────────────────────────────
Write-Step "2/8 清除 CoGrow Agent registry（含 SelfUninstallTriggered）"
foreach ($p in @(
  'HKLM:\SOFTWARE\CoGrow',
  'HKLM:\SOFTWARE\WOW6432Node\CoGrow'
)) {
  if (Test-Path $p) {
    Invoke-Action "刪除 $p" { Remove-Item $p -Recurse -Force -ErrorAction Stop }
  }
}

# ── 3+4. PPKG + dedup 殘留 ─────────────────────────────────────────────────
Write-Step "3/8 卸載 PPKG + 刪 .ppkg / AssetCache（依 PpkgFilter='$PpkgFilter' 過濾）"
$allPackages = @(Get-ProvisioningPackage -AllInstalledPackages -ErrorAction SilentlyContinue)
$packages = @()
foreach ($pkg in $allPackages) {
  if (Test-NameMatch -Name $pkg.PackageName -FilterCsv $PpkgFilter) {
    $packages += $pkg
  } else {
    Write-Warn2 "保留 PPKG（未命中 PpkgFilter '$PpkgFilter'）: $($pkg.PackageName)"
  }
}
if (-not $packages -or $packages.Count -eq 0) {
  Write-Do "無命中的 PPKG"
}
foreach ($pkg in $packages) {
  $pid_ = $pkg.PackageId.ToString().Trim('{','}').ToLower()
  $bid  = "{$pid_}"
  Invoke-Action "Uninstall-ProvisioningPackage $($pkg.PackageName) ($pid_)" {
    Uninstall-ProvisioningPackage -PackageId $pkg.PackageId -ErrorAction SilentlyContinue
  }
  $stagePath = Join-Path 'C:\ProgramData\Microsoft\Provisioning' ($pkg.PackageName + '.ppkg')
  if (Test-Path $stagePath) {
    Invoke-Action "刪 stage .ppkg: $stagePath" { Remove-Item $stagePath -Force -ErrorAction Stop }
  }
  if ($pkg.PackagePath -and (Test-Path $pkg.PackagePath)) {
    Invoke-Action "刪 source .ppkg: $($pkg.PackagePath)" { Remove-Item $pkg.PackagePath -Force -ErrorAction Stop }
  }

  Write-Step "4/8 抹 PPKG dedup 殘留 ($pid_)"
  $dedupPaths = @(
    "HKLM:\SOFTWARE\Microsoft\EnterpriseResourceManager\Tracked\$pid_",
    "HKLM:\SOFTWARE\Microsoft\PolicyManager\Providers\$pid_",
    "HKLM:\SOFTWARE\Microsoft\Provisioning\PackageInfo\$bid",
    "HKLM:\SOFTWARE\Microsoft\Provisioning\Results\$bid",
    "HKLM:\SOFTWARE\Microsoft\Provisioning\CommandResults\DeviceContext\$bid",
    "HKLM:\SOFTWARE\Microsoft\Multivariant\Status\CachedCRCs\RunTime\$bid"
  )
  foreach ($p in $dedupPaths) {
    if (Test-Path $p) {
      Invoke-Action "刪 $p" { Remove-Item $p -Recurse -Force -ErrorAction Stop }
    }
  }

  $knobsKey = 'HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device\knobs'
  if (Test-Path $knobsKey) {
    $knob = Get-ItemProperty $knobsKey -ErrorAction SilentlyContinue
    if ($knob) {
      $knob.PSObject.Properties | Where-Object { $_.Value -eq $pid_ } | ForEach-Object {
        $name = $_.Name
        Invoke-Action "刪 knobs!$name (值=$pid_)" {
          Remove-ItemProperty $knobsKey -Name $name -ErrorAction Stop
        }
      }
    }
  }

  $oobeKey = 'HKLM:\SOFTWARE\Microsoft\Provisioning\OOBEPackage'
  if (Test-Path $oobeKey) {
    $oobe = Get-ItemProperty $oobeKey -ErrorAction SilentlyContinue
    if ($oobe -and ($oobe.PackageId -match $pid_)) {
      Invoke-Action "刪 OOBEPackage!PackageId (=$pid_)" {
        Remove-ItemProperty $oobeKey -Name 'PackageId' -ErrorAction Stop
      }
    }
  }
}
if (Test-Path 'C:\ProgramData\Microsoft\Provisioning\AssetCache') {
  Invoke-Action "刪 AssetCache" {
    Remove-Item 'C:\ProgramData\Microsoft\Provisioning\AssetCache' -Recurse -Force -ErrorAction Stop
  }
}

# ── 5. DMClient enrollment registry ─────────────────────────────────────
Write-Step "5/8 清除 DMClient Enrollments registry"
$filters = $EnrollmentFilter.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$enrollRoot = 'HKLM:\SOFTWARE\Microsoft\Enrollments'
$enrollIds = @()
if (Test-Path $enrollRoot) {
  Get-ChildItem $enrollRoot -ErrorAction SilentlyContinue | ForEach-Object {
    $guid = $_.PSChildName
    if ($guid -notmatch '^[0-9A-F\-]{30,}$') { return }  # 跳過 Context / Status 等子節點
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    $url = "$($props.DiscoveryServiceFullURL) $($props.ProviderID) $($props.UPN)"
    $match = $false
    foreach ($f in $filters) {
      if ($f -eq '*') { $match = $true; break }
      if ($url -like "*$f*") { $match = $true; break }
    }
    if ($match) {
      $enrollIds += $guid
      Write-Do "命中 enrollment: $guid  URL=$($props.DiscoveryServiceFullURL)  Provider=$($props.ProviderID)"
    } else {
      Write-Warn2 "保留 enrollment（未命中 filter '$EnrollmentFilter'）: $guid  URL=$($props.DiscoveryServiceFullURL)"
    }
  }
}
if ($enrollIds.Count -eq 0) {
  Write-Do "無命中的 enrollment"
}

foreach ($eid in $enrollIds) {
  foreach ($p in @(
    "$enrollRoot\$eid",
    "$enrollRoot\Context\$eid",
    "$enrollRoot\Status\$eid"
  )) {
    if (Test-Path $p) {
      Invoke-Action "刪 $p" { Remove-Item $p -Recurse -Force -ErrorAction Stop }
    }
  }
}

# ── 6. EnterpriseMgmt scheduled tasks ───────────────────────────────────
Write-Step "6/8 清除 EnterpriseMgmt scheduled tasks"
foreach ($eid in $enrollIds) {
  $taskPath = "\Microsoft\Windows\EnterpriseMgmt\$eid\"
  $tasks = Get-ScheduledTask -TaskPath $taskPath -ErrorAction SilentlyContinue
  foreach ($t in $tasks) {
    Invoke-Action "停 + 刪 task: $($t.TaskPath)$($t.TaskName)" {
      Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction Stop
    }
  }
  # 刪 task folder 本身（schtasks /Delete 才行，PowerShell 沒有 cmdlet）
  $sched = New-Object -ComObject Schedule.Service
  try {
    $sched.Connect()
    $root = $sched.GetFolder('\Microsoft\Windows\EnterpriseMgmt')
    Invoke-Action "刪 task folder: \Microsoft\Windows\EnterpriseMgmt\$eid" {
      $root.DeleteFolder($eid, 0)
    }
  } catch {
    Write-Warn2 "task folder $eid 已不存在或無法刪除：$($_.Exception.Message)"
  }
}

# ── 7. PolicyManager 殘留 ───────────────────────────────────────────────
Write-Step "7/8 清除 PolicyManager / AdmxInstalled / AdmxDefault 殘留"
foreach ($eid in $enrollIds) {
  $paths = @(
    "HKLM:\SOFTWARE\Microsoft\PolicyManager\AdmxInstalled\$eid",
    "HKLM:\SOFTWARE\Microsoft\PolicyManager\AdmxDefault\$eid",
    "HKLM:\SOFTWARE\Microsoft\PolicyManager\current\PolicyValues\$eid",
    "HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device\$eid",
    "HKLM:\SOFTWARE\Microsoft\EnterpriseResourceManager\Tracked\$eid"
  )
  foreach ($p in $paths) {
    if (Test-Path $p) {
      Invoke-Action "刪 $p" { Remove-Item $p -Recurse -Force -ErrorAction Stop }
    }
  }
}

# ── 8. DM device cert ───────────────────────────────────────────────────
Write-Step "8/8 清除 DM device certificate（LocalMachine\My，Subject=enrollment GUID）"
foreach ($eid in $enrollIds) {
  $certs = Get-ChildItem 'Cert:\LocalMachine\My' -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -match $eid -or $_.Issuer -match $eid }
  foreach ($c in $certs) {
    Invoke-Action "刪 cert: Subject=$($c.Subject) Thumbprint=$($c.Thumbprint)" {
      Remove-Item "Cert:\LocalMachine\My\$($c.Thumbprint)" -Force -ErrorAction Stop
    }
  }
}

# ── 結尾 ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
if ($DryRun) {
  Write-Host "[DryRun] 上述 $($script:Actions.Count) 個動作會在實際執行時觸發" -ForegroundColor Yellow
} else {
  Write-Host "完成。已執行 $($script:Actions.Count) 個清除動作。" -ForegroundColor Green
  if ($script:Errors.Count -gt 0) {
    Write-Host "其中 $($script:Errors.Count) 個動作報錯（見上方紅色行）。" -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "下一步：" -ForegroundColor Green
  Write-Host "  1. 重新開機（讓 EnterpriseMgmt task scheduler 和 DMClient 服務徹底放掉舊狀態）"
  Write-Host "  2. 雙擊新的 PPKG 重新 enroll"
  Write-Host ""
  Write-Host "驗證殘留是否清乾淨："
  Write-Host "  Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' | ForEach-Object {"
  Write-Host "    Get-ItemProperty `$_.PSPath -EA SilentlyContinue | Select PSChildName, UPN, DiscoveryServiceFullURL"
  Write-Host "  }"
  Write-Host "  Get-ProvisioningPackage -AllInstalledPackages"
  Write-Host "  Get-Service CoGrow* -EA SilentlyContinue"
}
Write-Host "==================================================" -ForegroundColor Cyan
