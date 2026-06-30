# Windows winget App 派發

> 透過 winget（Windows Package Manager）派發應用到設備，**不上傳二進制**——由設備端 Agent 跑 `winget install` 從公共 / 私有源拉取安裝。與既有 [EDA-CSP MSI 派發](agent-app-build-and-deploy.md) 並存不衝突，兩條獨立路徑各自管不同類型的軟體。

## 一、適用場景

| 軟體類型 | 走哪條派發 | 範例 |
|---|---|---|
| **公共軟體**（winget 公共源 8000+ 包） | **winget 派發** | VS Code、Chrome、Zoom、Office、Notepad++、7-Zip |
| **自家 MSI**（教學軟體 / OEM 工具） | EDA-CSP MSI 派發 | 我方上傳到 `apps` 表的 .msi 包 |
| **CoGrow MDM Agent 本身** | EDA-CSP MSI 派發 | `/apps/agent` 上架的 Agent MSI |

winget 派發的最大價值是**零維護**：不必上傳二進制、不必管 MSI 簽名、不必處理 BITS 下載、自動由 winget 處理 silent install。

## 二、整體鏈路

```
[Admin POST /winget-install]
        ↓
[backend 寫 mdm_commands(commandType=winget_install, syncmlVerb=null)]
[backend 寫 app_assignments(scope=device, status=pending)]
[backend triggerWnsPush(deviceId)]
        ↓
[Microsoft WNS → dmwappushsvc → Windows OMA-DM session 啟動]
        ↓
[EventLog: Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Operational
 EventID=265 「MDM 會話：已觸發 OMA-DM 會話」fire]
        ↓
[Agent OmaDmEventLogWatcher 監聽到 265 → 喚醒 WingetWatcher]
        ↓
[WingetWatcher POST /agent/checkin 拉取]
        ↓
[checkin response: { actions: [ { type: "winget_install", data: { commandId, wingetId, source, ... } } ] }]
        ↓
[WingetWatcher spawn winget.exe install --id X --silent --scope machine --accept-source-agreements --accept-package-agreements --disable-interactivity [--source X]]
        ↓
[winget 下載 + 跑 silent installer]
        ↓
[Agent POST /agent/winget-result { commandId, exitCode, status, installedVersion, stdoutTail }]
        ↓
[backend mdm_commands.status = acknowledged / error]
[backend app_assignments.status = installed / failed]
[webhook command.completed fired]
```

**秒級觸發**：派發到 winget 開始執行 ~30 秒（受 WNS push 延遲影響）。

## 三、Admin API

### 上架 winget App（不上傳二進制）

```http
POST /api/v1/admin/tenants/{tenantId}/apps/winget
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "wingetId": "Microsoft.VisualStudioCode",
  "displayName": "Visual Studio Code",
  "category": "office",
  "licenseCount": 100,
  "wingetSource": "winget"          // 選填，預設 "winget" 公共源
}
```

回 201 含 `id`（appId）。

**約束**：
- 同 tenant 同 `wingetId` 唯一（409 重複）
- `wingetSource` 預設 `winget`（公共源）；可選 `msstore` 或 `cogrow-{tenantSlug}`（未來私有 REST source）
- `displayName` 必填——**uninstall fallback 用到**（見下節）

### 派發 winget install

```http
POST /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/apps/{appId}/winget-install
Authorization: Bearer <admin_token>
Content-Type: application/json

{}
```

回 202 含 `commandIds`。`triggerWnsPush` 同步觸發 WNS push。

### 派發 winget uninstall

```http
POST /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/apps/{appId}/winget-uninstall
Authorization: Bearer <admin_token>
```

⚠️ **uninstall 不保證成功**（見「已知 winget 限制」一節）。

### Agent 回報結果

由 Agent 側自動回報，admin 不需呼叫；後端會收到 `command.completed` webhook 含 exitCode/status/installedVersion。

## 四、Agent 端實作（在 Win-Agent v1.4.0.13+）

兩個 Hosted Service 配合：

- **OmaDmEventLogWatcher**：訂閱 EventLog `Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Operational` Event ID **265**，fire 時呼叫 `WingetWatcher.RequestPoll()`
- **WingetWatcher**：BackgroundService，trigger=Channel（被 EventLogWatcher 觸發）+ fallback poll 180s（兜底）。spawn winget.exe，分類 exit code，POST result

### winget.exe 路徑解析

winget 是 per-user MSIX 安裝到 `%LOCALAPPDATA%\Microsoft\WindowsApps\`，**Agent 跑 LocalSystem service 沒 user profile，PATH 找不到 winget.exe**。`ResolveWingetExe()` 啟動時優先試 PATH → fallback glob `C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__*\winget.exe`（system-wide x64 binary，按字典序取最新版）。

### winget 命令參數

**Install**：
```
winget install --id <wingetId> --exact --silent
  --disable-interactivity
  --accept-source-agreements
  --scope machine
  --accept-package-agreements
  [--source <source>]
```

**Uninstall（先試 `--id`）**：
```
winget uninstall --id <wingetId> --exact --silent
  --disable-interactivity
  --accept-source-agreements
```

**Uninstall fallback（`--id` 失敗 0x8A150011/0x8A150014 時自動觸發）**：
```
winget uninstall --name "<displayName>" --silent
  --disable-interactivity
  --accept-source-agreements
  --source winget
```

`--disable-interactivity` 必須帶——LocalSystem context 跑 winget 即使帶 `--accept-source-agreements`，msstore source 仍會 prompt 「源要求在使用前查看以下协议」並阻塞等輸入（已知 winget-cli 行為），不帶 disable-interactivity 會卡 15 min 直到 watcher kill。

## 五、已知 winget 限制（重要 ⚠️）

### 1. uninstall 對某些包**根本找不到**

實測 7-Zip：

```
$ winget list --id 7zip.7zip
找不到与输入条件匹配的已安装程序包
```

但 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` 裡明明有 `7-Zip 26.01 (x64)`。

**根因**：winget 的 ARP 反向映射（從 ARP DisplayName → winget-pkgs ID）對 EXE/InnoSetup installer 不可靠。當 manifest 的 installer 是 .exe（如 7-Zip）而非 .msi，winget 裝完後**自己也認不出來這個包是它裝的**，list / uninstall --id 全部 fail。

社區共識：**winget uninstall 不可靠**，許多 MDM 廠商直接 fallback 到 ARP UninstallString 跑 msiexec/原生 uninstaller。

### 2. 我們做了什麼

- **fallback `--name "displayName"` + `--source winget`**：很多包靠 displayName 模糊匹配能撞上 ARP，能挽救一部分
- **限定 `--source winget`** 避免觸發 msstore source 出 `0x8A150039 Invalid data returned by rest source`

### 3. 我們做不到什麼

- 即使 fallback `--name`，winget tracking DB 不認的包仍 uninstall fail
- 對 EXE/InnoSetup-only manifest 的包（如 7-Zip）**無解**——這是 winget 自家 bug

### 4. 真機驗證對比（PF5XSMN1 2026-06-30）

| 場景 | 結果 |
|---|---|
| **同 Agent 版本 install + uninstall 短時間連跑** | ✅ winget --id 直接成功（1.4s） |
| **Agent 跨版本（多次 MSI 升級）後 uninstall** | ❌ winget 全部 fail（list/uninstall NO_PACKAGES_FOUND），需走 ARP fallback |
| **手動 ITAdmin context 跑 winget list/uninstall** | ❌ NO_PACKAGES_FOUND（winget tracking DB 是 per-profile，跨 user 看不到） |

**為什麼跨版本會破**：

- winget 是 per-user MSIX，tracking DB 在 `%LOCALAPPDATA%\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\`
- LocalSystem service 跑 winget 時 LocalAppData 落到 `C:\Windows\System32\config\systemprofile\AppData\Local\...`
- Agent MSI 升級 / service crash-restart 不影響 SYSTEM profile **應該**穩定
- 但實測 1.4.0.11 → 1.4.0.14 多次升級 + service restart 後 winget tracking DB 對 `7zip.7zip` 反向映射**真的丟了**
- 社區 [winget-cli #3458](https://github.com/microsoft/winget-cli/issues/3458) 「Winget metadata in corrupted state」是相同症狀，跨 user/SYSTEM context 切換尤其嚴重

**為什麼一定要 ARP fallback**：

不能假設「winget 永遠認得自己裝的包」。真機驗證證實**同 SYSTEM profile 都可能跨次失憶**。三層 fallback 鏈是必須的：

```
Layer 1: winget uninstall --id <wingetId>           ← winget tracking 認時直接成功
Layer 2: winget uninstall --name "<displayName>" --source winget   ← 通過 manifest 反查
Layer 3: ARP UninstallString （讀 HKLM Uninstall）   ← winget 完全認不出時的兜底
```

### 5. ARP fallback 細節

Agent 1.4.0.15+ 在 winget 兩層 fallback 都 fail 後讀 HKLM Registry 找 ARP entry，按優先級執行：

1. **QuietUninstallString**（廠商手填的 silent 命令，最穩）
   - 例：7-Zip 26.01 → `"C:\Program Files\7-Zip\Uninstall.exe" /S`
2. **MsiExec 模式** UninstallString → 重寫成 `msiexec /x {GUID} /qn /norestart`
   - 例：MSI 包的 UninstallString `MsiExec.exe /X{GUID}` 自動轉成 silent
3. **其他 EXE UninstallString** + 啟發式 `/S` flag（NSIS 慣例，錯了無害失敗）

匹配規則：HKLM Uninstall 子鍵的 `DisplayName` **前綴匹配**（StartsWith）`apps.displayName`。因此上架 winget App 時 `displayName` 建議用 ARP DisplayName 前綴（例：「7-Zip」匹配「7-Zip 26.01 (x64)」）。

**punt**：EXE installer silent flag 啟發式不一定對；後續可加 admin 上架時的 `uninstall_command_override` 欄位讓 admin 對已知坑包手填命令。

### 5. 建議運維策略

**對 admin**：
- 上架 winget App 時優先選 **MSI/MSIX installer 的包**（看 winget-pkgs manifest）
- EXE installer 的包視為「能裝不能卸」，重要的就別走 winget
- uninstall 失敗 → 後台 manual 處理（遠端 SSH 跑 winget uninstall / msiexec /x）

**對自動化**：
- `app_assignments.status = failed` 後 admin 收到 `command.completed` webhook
- 失敗的 uninstall 命令 `mdm_commands.status = error` + `response_payload.exitCode = 0x8A150014` 可診斷

## 六、後端 schema

### `apps` 表新增欄位（migration 0012）

```sql
ALTER TYPE "app_kind" ADD VALUE 'winget';
ALTER TABLE "apps" ADD COLUMN "winget_id" varchar(256);
ALTER TABLE "apps" ADD COLUMN "winget_source" varchar(64);
CREATE INDEX "apps_winget_id_idx" ON "apps" USING btree ("winget_id");
CREATE UNIQUE INDEX "apps_tenant_winget_id_uq" ON "apps"
  USING btree ("tenant_id","winget_id") WHERE "winget_id" IS NOT NULL;
```

`kind=winget` 時 `wingetId` + `wingetSource` 必填，`fileUrl/fileHash/bundleId` 留 null。

### `mdm_commands` payload 結構

```jsonc
{
  "type": "winget_install" | "winget_uninstall",
  "wingetId": "Microsoft.VisualStudioCode",
  "source": "winget",
  "scope": "machine",
  "acceptAgreements": true,
  "version": "1.95.0" | null,         // null = winget 自動最新
  "displayName": "Visual Studio Code", // uninstall fallback 用
  "appId": "<uuid>"
}
```

`mdm_commands.cspPath`、`syncmlVerb`、`syncmlData` 全 **null**——winget 不走 OMA-DM SyncML 通道。

### `/agent/checkin` response 擴展

```jsonc
{
  "deviceId": "...",
  "actions": [
    {
      "type": "winget_install",
      "priority": 80,
      "data": {
        "commandId": "<uuid>",
        "wingetId": "Microsoft.VisualStudioCode",
        "source": "winget",
        "scope": "machine",
        "acceptAgreements": true,
        "version": "1.95.0",
        "displayName": "Visual Studio Code"
      }
    }
  ]
}
```

LAPS / 其他 actions 並列出現。Agent 按 `type` 分發。

### `/agent/winget-result` response 結構

```jsonc
{
  "commandId": "<uuid>",
  "exitCode": 0,
  "status": "success" | "failed" | "already-installed" | "not-found",
  "installedVersion": "26.01",        // 從 stdout 正則抽取（盡力）
  "stdoutTail": "...",                // 末 2KB（含 winget 進度條 ANSI，調試用）
  "stderrTail": "...",
  "durationMs": 17609,
  "serialNumber": "PF5XSMN1"
}
```

## 七、踩坑記錄（PF5XSMN1 真機 2026-06-30）

| 版本 | 暴露問題 | 修復 |
|---|---|---|
| 1.4.0.10 | WingetWatcher 用 `ProcessStartInfo("winget.exe", ...)` 走 PATH，LocalSystem 找不到 | 1.4.0.11 加 `ResolveWingetExe()` glob WindowsApps |
| 1.4.0.10 | service 啟動初期 checkin SSL EOF 失敗 | 1.4.0.11 起 fallback poll 180s 自動 retry 第二次必通 |
| 1.4.0.11 | uninstall 7zip.7zip 卡 15 min winget.exe 不退出（msstore source agreement prompt 阻塞） | 1.4.0.12 args 加 `--disable-interactivity` → 1s 退出 |
| 1.4.0.12 | uninstall `--id 7zip.7zip` 立刻回 `0x8A150014 NO_PACKAGES_FOUND` | 1.4.0.13 fallback `--name "displayName"` |
| 1.4.0.13 | fallback `--name` 觸發 msstore source 返回 `0x8A150039 Invalid data returned by rest source` | 1.4.0.14 fallback 限定 `--source winget` |
| 1.4.0.14 | 7zip.7zip uninstall `--id` 跟 `--name "7-Zip" --source winget` 兩條都 fail（NO_PACKAGES_FOUND）；`winget list --query "7zip"` 也找不到——跨 Agent 版本升級後 winget tracking DB 失憶 | 1.4.0.15 加 Layer 3 ARP fallback（讀 HKLM Uninstall 跑 QuietUninstallString） |
| **1.4.0.15** | 同版本內 install+uninstall 連跑：winget --id 1.4s 直接成功；跨版本場景 ARP fallback 兜底 | ✅ 真機驗證 7-Zip 1.4s 卸完，文件 + ARP entry 全清 |

## 八、運維檢查清單

派發 winget App 前：

- [ ] App 已在 `apps` 表 `kind=winget` 上架（`POST /apps/winget`）
- [ ] 設備 `platform=windows` 已 enroll
- [ ] 設備已裝 Agent v1.4.0.11+（含 `ResolveWingetExe`）
- [ ] 設備在線（Agent 1 小時內 checkin 過）
- [ ] ngrok / publicBaseUrl 通

派發後 1-2 分鐘還沒 ack：

- [ ] 查 `mdm_commands.status`：`queued` = Agent 沒拉到；`error` = Agent 跑了但失敗
- [ ] 查設備 EventLog `Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Operational`：派發後是否 fire Event ID 265
- [ ] 查設備 Agent EventLog（Application source=CoGrowMDMAgent）：有沒有 `winget checkin HTTP failure` Warning
- [ ] 用 PowerShell 手測：`& "C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__*\winget.exe" install --id <wingetId> --silent --disable-interactivity`

## 九、相關文件

- [Agent App 構建與部署](agent-app-build-and-deploy.md)（EDA-CSP MSI 派發鏈路）
- [Push 基礎設施配置](push-infrastructure-setup.md)（WNS 設定）
- [Trigger 機制](trigger-mechanism.md)（OMA-DM session 觸發）
- [Troubleshooting](troubleshooting.md)
