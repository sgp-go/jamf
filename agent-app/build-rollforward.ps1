<#
.SYNOPSIS
  Roll-forward 回滾打包：用「已知好版本」的源碼（git ref）+ 更高版本號構建 MSI。

.DESCRIPTION
  MSI MajorUpgrade 擋 downgrade，回滾不能直接派舊版（版本號更低被拒）。本腳本把舊 ref
  的源碼 checkout 到臨時 git worktree，用更高 -Version 構建，產出「代碼回退、版本號遞增」
  的 roll-forward 包，走正常 MajorUpgrade 升級路徑回滾。
  關鍵：壞 build 崩潰的設備靠 OMA-DM 系統通道（獨立於 agent）仍收得到此回滾包。
  完整設計見 brain/projects/jamf-explore/wiki/agent-rollback-strategy.md。

.PARAMETER SourceRef
  已知好版本的 git ref（tag / commit / branch），如 agent-v1.2.0.0。

.PARAMETER Version
  Roll-forward 包的版本號（a.b.c.d）。必須 > 當前壞版本，否則 MajorUpgrade 拒絕安裝。

.PARAMETER Configuration
  Release（預設）或 Debug。

.PARAMETER CertThumbprint
  可選；傳入則對 .exe / .msi 簽名（透傳給 worktree 的 build.ps1）。

.EXAMPLE
  # 當前壞版本 1.3.1.0，回滾到 1.2.0.0 的代碼，用更高版本號 1.3.1.1 重打：
  pwsh -File build-rollforward.ps1 -SourceRef agent-v1.2.0.0 -Version 1.3.1.1 -CertThumbprint ABC123...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceRef,
    [Parameter(Mandatory = $true)][string]$Version,
    [ValidateSet("Release", "Debug")][string]$Configuration = "Release",
    [string]$CertThumbprint
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw "Version 須為 a.b.c.d 格式：$Version"
}

# repo 根 + agent-app 相對路徑（worktree 內結構相同）
$repoRoot = (& git -C $root rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw "not a git repo: $root" }
$agentRel = (Resolve-Path $root).Path.Substring((Resolve-Path $repoRoot).Path.Length).TrimStart('\', '/')

$worktree = Join-Path ([System.IO.Path]::GetTempPath()) "cogrow-rollforward-$Version"
$outDir = Join-Path $root "build\rollforward"

Write-Host "==== Roll-forward 打包 ===="
Write-Host "SourceRef : $SourceRef（已知好版本源碼）"
Write-Host "Version   : $Version（須 > 當前壞版本，否則 MajorUpgrade 拒絕）"
Write-Host "Worktree  : $worktree"

# 殘留 worktree 先清
if (Test-Path $worktree) { & git -C $repoRoot worktree remove $worktree --force 2>$null }

& git -C $repoRoot worktree add --detach $worktree $SourceRef
if ($LASTEXITCODE -ne 0) { throw "git worktree add 失敗，ref 不存在？：$SourceRef" }

try {
    $wtBuild = Join-Path $worktree "$agentRel\build.ps1"
    if (-not (Test-Path $wtBuild)) {
        throw "worktree 內無 build.ps1（該 ref 可能早於 build.ps1）：$wtBuild"
    }

    Write-Host ""
    Write-Host "==== 用舊源碼 worktree 構建（版本號 $Version）===="
    $buildParams = @{ Version = $Version; Configuration = $Configuration }
    if ($CertThumbprint) { $buildParams.CertThumbprint = $CertThumbprint }
    & $wtBuild @buildParams
    if ($LASTEXITCODE -ne 0) { throw "roll-forward build 失敗 ($LASTEXITCODE)" }

    $wtMsi = Get-ChildItem (Join-Path $worktree "$agentRel\build\msi\*.msi") | Select-Object -First 1
    if (-not $wtMsi) { throw "worktree 內未產出 .msi" }

    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    $dest = Join-Path $outDir "CoGrowMDMAgent-rollforward-$Version.msi"
    Copy-Item $wtMsi.FullName -Destination $dest -Force

    $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
    Write-Host ""
    Write-Host "==== Done（roll-forward 包）===="
    Write-Host "File    : $dest"
    Write-Host "Source  : $SourceRef"
    Write-Host "Version : $Version"
    Write-Host "SHA256  : $hash"
    Write-Host "Signed  : $(if ($CertThumbprint) { 'yes' } else { 'NO（傳 -CertThumbprint 簽名）' })"
    Write-Host ""
    Write-Host "→ 用 2b 灰度端點派此包：候選 = 當前版本 != $Version（涵蓋壞版本設備）"
}
finally {
    & git -C $repoRoot worktree remove $worktree --force 2>$null
    Write-Host "worktree 已清理"
}
