# Windows MDM 端到端 Demo 演示腳本

> 提供給對接團隊（台灣後端）做產品演示用的標準流程腳本。
> 真機端到端驗證日期：**2026-06-26**（Win11 24H2 Pro / Lenovo IdeaPad 700 PF5XSMN1）。

## 0. 對接團隊一次性同步（首次拿到此版本必看）

從 main 拉到本次 commits 後，**必做下列三步**才能跑 demo。後端代碼 + Agent MSI + 既有設備升級**缺一不可**。

### 0.1 後端代碼

```bash
git pull origin main      # 拿 8 個新 commit（5 root cause fix + 新 endpoint + adapter 換）
deno task dev              # 或 production：重啟 systemd unit
```

新拉的關鍵 commit：
- `fix(http)` — `@hono/node-server` 取代 `Deno.serve`（繞 HEAD Content-Length=0 bug）
- `fix(eda-csp)` × 2 — MSI download response 補 Last-Modified+ETag + buildMsiUninstall 改 Delete verb
- `fix(unenroll)` — PPKG dedup 8 處清 + watcher 跨 ADMX cleanup 撐 + agent 重 enroll 不誤自卸
- `fix(agent)` — checkin 走 token-first 避免孤兒 row
- `feat(app-deploy)` — 新增 `/apps/{appId}/{install,uninstall}` 端點

### 0.2 Agent MSI v1.4.0.8 — **必須自行 build + 上傳到自己的 backend**

Agent MSI 是 build 產物（~76MB），**不入 git**。每個團隊在自己的 build machine 上 build + 上傳到自己的 `apps` 表（不同 backend 的 `apps` 表不共享）。

```powershell
# 在 build machine（需 .NET 8 SDK + WiX 5 dotnet tool；首次參考 build-machine-setup.md）
cd C:\path\to\jamf_explore
git pull   # 拿 SelfUninstallWatcher.cs / PpkgRemovalWatcher.cs 的 fix
pwsh -File win-agent-app\build.ps1 -Version 1.4.0.8
# 產出 win-agent-app\build\msi\CoGrowMDMAgent.msi (~76MB)
```

上傳到後端：

```bash
# 從 MSI 提取真實 ProductCode（必要——bundleId 必須 = MSI 內 ProductCode 否則 EDA-CSP 拒）
msiinfo export CoGrowMDMAgent.msi Property | grep ProductCode
# 例：ProductCode  {176848CB-7917-4829-B158-F18F7585B7DA}

# 上傳到 admin API
curl -X POST "$BACKEND/api/v1/admin/tenants/$TID/apps" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F 'displayName=CoGrow MDM Agent' \
  -F 'version=1.4.0.8' \
  -F 'bundleId={176848CB-7917-4829-B158-F18F7585B7DA}' \
  -F 'kind=msi' \
  -F 'file=@win-agent-app/build/msi/CoGrowMDMAgent.msi'
# 記下回傳的 id 作為 $NEW_APP_ID
```

**自動下發鏈會選最新 row**（按 `createdAt DESC`），所以新 enrollment 會自動派 1.4.0.8，**不用手動指定 appId**。

> ⚠️ **build machine 必須是 Windows**（dotnet 跨平台但 WiX 跑 native Windows libraries）。詳見 [build-machine-setup.md](./build-machine-setup.md)。

### 0.3 既有 1.4.0.7（或更舊版本）設備批量升級

新 Agent fix 一個關鍵 bug：**舊 v1.4.0.7 設備持有持久 `HKLM\Software\CoGrow\Agent\State\SelfUninstallTriggered` registry trigger（unenroll 鏈寫的），下次重新 enroll + 自動裝 v1.4.0.8 後新 agent 啟動立刻自卸**——必須先在 v1.4.0.7 階段升到 v1.4.0.8（v1.4.0.8 在 spawn `msiexec /x` 前會清掉這個 trigger）。

```sql
-- 找出所有跑舊版的 Windows 設備
SELECT id, udid, agent_app_id, last_seen_at
FROM mdm_devices
WHERE platform='windows'
  AND enrollment_status='enrolled'
  AND agent_app_id != '<NEW_APP_ID>'  -- 上一步上傳得到的 v1.4.0.8 row id
ORDER BY last_seen_at DESC;
```

對每台跑：

```bash
curl -X POST "$BACKEND/api/v1/admin/tenants/$TID/devices/$DEVICE_ID/install-agent" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F 'appId=<NEW_APP_ID>' \
  -F 'apiEndpoint=https://your-prod-domain/api/v1'
```

WiX MajorUpgrade 自動卸舊裝新，service 優雅停啟（自我保護不擋 MajorUpgrade）。生產建議 ≥ 5 台灰度後再全量。

### 0.4 `app_download_base_url` 必須 HTTPS

```sql
-- 必須是 HTTPS！Win11 24H2 EDA-CSP LocalSystem context 對 HTTP scheme 不友善
-- 0x80072EF3 WINHTTP_INCORRECT_HANDLE_STATE 就是這個（2026-06-26 真機踩到）
SELECT public_base_url, app_download_base_url FROM self_mdm_configs WHERE is_active=true;
```

期望：兩個欄位都是 `https://<your-prod-domain>`（生產正式域名，反代到 backend）。

> ngrok 只在我方本地 demo 用——對接方應接到正式服務器（Let's Encrypt / 商業 cert + nginx 反代到 Deno 進程）。生產不上 ngrok。

### 0.5 PPKG 不用重 build

PPKG 內容沒改（PackageID / DiscoveryUrl / WiFi / 內嵌帳號 一樣），既有 USB 上的 `.ppkg` 還能用。如改 device_group code / publicBaseUrl / enrollment UPN 才需重 build。

---

## 1. 演示前準備（30 分鐘）

### 1.1 後端服務

```bash
# 確認 backend 進程 + 公網入口可達
systemctl status deno-backend          # 或自定義 service 名
curl -sS -o /dev/null -w "%{http_code}\n" https://<your-prod-domain>/openapi.json  # 期望 200
```

> 我方本地 demo 用 ngrok 暴露 localhost:3000，**對接方應接到正式服務器**（公網域名 + Let's Encrypt / 商業 cert + nginx/Caddy 反代到 Deno 進程）。生產不上 ngrok。

### 1.2 backend 配置確認

```sql
-- self_mdm_configs.app_download_base_url 必須是 HTTPS
-- Win11 24H2 EDA-CSP LocalSystem context 對 HTTP scheme 不友善（WinHTTP handle 進入
-- incorrect_handle_state 0x80072EF3），HTTPS 是硬性要求不是建議。
SELECT public_base_url, app_download_base_url FROM self_mdm_configs WHERE is_active=true;
```

期望：兩個欄位都是 `https://<your-prod-domain>`（同一個或不同域名都行，但都必須 HTTPS）。

### 1.3 設備要求

- **Win11 Pro / Education / Enterprise**（Home 不支援 EDA-CSP，整批 SyncML 命令返 406）
- 設備乾淨狀態（從未 enroll 過或已徹底 cleanup）
- 可從公網存取 backend 域名（無防火牆攔截）

### 1.4 演示物料

- 一份預配包（`.ppkg`）內含 demo tenant / device_group / enrollment UPN
- 一份 Agent MSI 上傳到 backend（`apps` 表 row 已有，按 `createdAt DESC` 自動選 latest）
- 一份**體積小**的測試 MSI 演示 install/uninstall（推薦 7-Zip x64 1.98MB）

---

## 2. 演示流程（10-15 分鐘走完）

### Step 1：Enrollment（雙擊 PPKG，~3 分鐘）

1. 設備開機（OOBE 或已登入皆可）
2. 插 U 盤 → 雙擊 `e2e-enroll-wifi.ppkg`（或直接桌面雙擊）
3. UAC 同意 → 「Trust this package」→ Apply

**觀察點**（後端 deno log）：
```
[Win MDM] Discovery (tenant=demo group=demo-group): email=enrollment@school.local
[Win MDM] Enrolled deviceId=<UUID> udid=windows-<UUID>
[Win MDM] 已自動排入 install-agent + LAPS udid=... cmds=10
[Win MDM] 已自動排入 push 配置 udid=... cmds=11
```

**自動派發 21 條命令**：防脫離 2 + 信任根 cert 2 + Push MSIX 2 + SetPoll 5 + AppInventory 2 + ADMX install 5 + MSI install Add+Exec + msi_status_query + LAPS + BitLocker

### Step 2：Agent App 自動安裝（~1 分鐘）

設備收 install-agent 命令後 EDA-CSP 自動：
1. BITS over HTTPS 下載 Agent MSI（79MB ~30-60 秒）
2. `msiexec /i` 安裝（service 自動啟動）
3. Agent 讀 Registry 取得 `agent_token + api_endpoint` 後 startup checkin

**驗證**：
```bash
# backend 看 checkin
curl -sS "http://localhost:3000/api/v1/admin/tenants/{tid}/devices/{did}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .data.enrollmentStatus  # "enrolled"

# 設備端（SSH 或 PowerShell）
Get-Service CoGrowMDMAgent | Format-Table Name,Status,StartType  # Running Automatic
Test-Path "C:\Program Files\CoGrow\MDM Agent\CoGrowMDMAgent.exe"  # True
```

### Step 3：服務端鎖屏（秒級）

```bash
curl -sS -X POST "http://localhost:3000/api/v1/tenants/{tid}/devices/{did}/commands" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "LOCK",
    "lostModeMessage": "設備被鎖定 — 演示中",
    "lostModePhone": "+886 0800-000-000",
    "lostModeFootnote": "請聯繫管理員"
  }'
```

**預期**：< 5 秒設備出現全屏鎖定窗（不能 Alt+F4 / Ctrl+Alt+Del 跳出）。

**機制**：backend 排 ADMX-backed Policy CSP `Replace` 命令寫 Registry → WNS push 喚醒設備秒級拉取 → Agent `LockWatcher` 2 秒 tick 偵測 Registry `Enabled=1` → 啟動 `CoGrowMDMAgent.LockUI.exe` 全屏窗（跨 session 顯示到 console session）。

### Step 4：服務端解鎖

```bash
curl -sS -X POST "http://localhost:3000/api/v1/tenants/{tid}/devices/{did}/commands" \
  -H "Content-Type: application/json" \
  -d '{"command": "DISABLE_LOST_MODE"}'
```

**預期**：< 5 秒鎖定窗消失，恢復桌面。

### Step 5：服務端下發 App 安裝（演示用 7-Zip）

**前置：上傳 MSI**（演示前一次性做好，不在演示流程中跑）：
```bash
# 從 https://www.7-zip.org/ 下載 7-Zip x64 MSI（~2MB）

# 上傳
curl -sS -X POST "http://localhost:3000/api/v1/admin/tenants/{tid}/apps" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F 'displayName=7-Zip' \
  -F 'version=24.09.00.0' \
  -F 'bundleId={23170F69-40C1-2702-2409-000001000000}' \
  -F 'kind=msi' \
  -F 'file=@7z2409-x64.msi'
# 記下 returned id 作為 $APP_ID
```

**演示時派發 install**：
```bash
curl -sS -X POST "http://localhost:3000/api/v1/admin/tenants/{tid}/devices/{did}/apps/$APP_ID/install" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**預期**：~15-30 秒設備 `C:\Program Files\7-Zip\7zG.exe` 出現（取決於設備網速 + EDA-CSP retry tick）。

**機制**：backend 排 `msi_install Add+Exec+msi_status_query` → fire-and-forget WNS push → 設備拉命令 → EDA-CSP 走 BITS download + `msiexec /i` → catalog commit + Uninstall registry write。

### Step 6：服務端下發 App 卸載

```bash
curl -sS -X POST "http://localhost:3000/api/v1/admin/tenants/{tid}/devices/{did}/apps/$APP_ID/uninstall" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**預期**：~2-5 分鐘設備 `C:\Program Files\7-Zip` 整個目錄消失（EDA-CSP `Delete` verb 內部 schedule + 設備 OMA-DM 拉取 + msiexec /x finalize）。

**機制**：backend 排 `Delete /MSI/{ProductID}` SyncML 命令 → EDA-CSP 觸發 `msiexec /x {ProductID} /quiet` → 文件全清 + catalog 清。

> ⚠️ **uninstall 比 install 慢的設計原因**：EDA-CSP 對 uninstall enforcement 有額外 retry tick（不像 install 有明確終態 ack），這是 Microsoft 行為，非 backend 問題。

### Step 7：服務端重啟（可選，最後演示）

```bash
curl -sS -X POST "http://localhost:3000/api/v1/tenants/{tid}/devices/{did}/commands" \
  -H "Content-Type: application/json" \
  -d '{"command": "REBOOT"}'
```

**預期**：設備顯示「2 分鐘後自動重啟」Microsoft 系統通知 → 2 分鐘倒數 → 設備重啟 → 開機自動恢復納管狀態。

> ⚠️ 2 分鐘倒數是 Microsoft RebootNow CSP 強制行為，無法跳過。

---

## 3. Demo 時序總覽

| 步驟 | 動作 | 預期時間 |
|---|---|---|
| 1 | PPKG enrollment | 3 分鐘（含套用 + 自動派 21 命令） |
| 2 | Agent 自動安裝 | 1-2 分鐘 |
| 3 | LOCK | < 5 秒 |
| 4 | UNLOCK | < 5 秒 |
| 5 | 7-Zip install | 15-30 秒 |
| 6 | 7-Zip uninstall | 2-5 分鐘 |
| 7 | REBOOT | 2 分鐘倒數 |
| **總** | | **約 10-15 分鐘** |

---

## 4. 演示前 checklist

- [ ] backend 進程在跑（`systemctl status deno-backend` 或對應 service）
- [ ] 公網入口 200（`curl https://<your-prod-domain>/openapi.json`）
- [ ] HTTPS cert 有效（`openssl s_client -connect <domain>:443 -servername <domain> </dev/null | openssl x509 -dates`）
- [ ] `app_download_base_url` 是 HTTPS（見 § 1.2）
- [ ] `apps` 表有 Agent MSI 最新版本（按 `createdAt DESC` 自動選）
- [ ] 7-Zip MSI 已上傳並記下 `appId`
- [ ] 演示設備乾淨（無殘留 enrollment / agent / PPKG dedup cache）
- [ ] 演示設備網絡可上 backend 公網域名（無防火牆攔截）
- [ ] WNS push 服務正常（`POST /api/mdm/win/devices/{udid}/push` 返 `received`）

---

## 5. 演示中常見問題

### Q1：設備收到 LOCK 但沒鎖屏

**檢查**：
1. Agent service 是否 Running（`Get-Service CoGrowMDMAgent`）
2. ADMX Policy CSP 是否裝好（`HKLM\SOFTWARE\Microsoft\PolicyManager\providers\<enrollment-id>\default\Device\CoGrowMDM~Policy~Lock` 是否存在）
3. Registry `HKLM\Software\CoGrow\Agent\Lock\Enabled=1` 是否被寫入

**排查**：SSH `Get-WinEvent -ProviderName CoGrowMDMAgent -MaxEvents 10` 看 LockWatcher 是否觸發。

### Q2：Install App 命令派發後設備沒反應

**檢查**：
1. WNS push 是否成功（`POST /push` 端點返 `received`）
2. 設備 OMA-DM 是否在 poll（backend log 看 `POST /api/mdm/win/manage/{udid}` 是否進來）
3. EDA-CSP 是否成功 schedule（設備 Event Log `Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Admin` 1905 事件）

**排查**：手動 trigger sync — SSH 設備跑 `Get-ScheduledTask -TaskName PushLaunch -TaskPath '\Microsoft\Windows\EnterpriseMgmt\*\' | Start-ScheduledTask`。

### Q3：BITS 下載失敗 0x80072EF3

代表 BITS WinHTTP handle 進入 incorrect_handle_state，已知 root cause：
- backend MSI download response 缺 `Last-Modified` 或 `ETag` header（已修，driver 在 `apps.ts`）
- `Content-Disposition` filename 跟 URL filename 不一致（已修）
- 走 HTTP scheme 在 EDA-CSP LocalSystem context 不可靠 → 必須 HTTPS

確認 `app_download_base_url` 是 HTTPS 且 backend 有最新 fix（apps.ts download handler 返 `Last-Modified + ETag`）。

### Q4：設備重啟後 SSH 連不上

**Network profile 自動回 Public**，OpenSSH firewall rule 預設只 Private/Domain。SSH 不通**不影響 MDM 功能**（OMA-DM 走 outbound HTTPS）。需要 SSH 就在設備上跑：
```powershell
Set-NetConnectionProfile -InterfaceAlias WLAN -NetworkCategory Private
```

---

## 6. 演示後狀態

| 項 | 狀態 |
|---|---|
| 設備 enrollment | 仍 enrolled（後續可繼續用同設備 demo）|
| Agent service | Running |
| 7-Zip | 已卸載 |
| LAPS Administrator 密碼 | 已輪換（用 admin API `/laps-password` 查當前值）|
| BitLocker | 已啟動 + Recovery Key 入 db |
| LAPS ITAdmin 密碼 | **未動，仍是 PPKG 初始值 `AdminTemp123!`**（當前 `laps.ts:20` 寫死改 Administrator）|

如需重置設備到「乾淨」狀態以便下次 demo，走 `POST /api/mdm/win/devices/{udid}/unenroll` 自動跑 9 步清理鏈（含 PPKG removal + Agent uninstall + LAPS reset + DMClient Unenroll）。

---

## 7. 相關文檔

- 整體架構：[`docs/integration-guide.md`](../integration-guide.md)
- 設備部署：[`device-provisioning-guide.md`](./device-provisioning-guide.md)
- Agent 部署：[`agent-app-build-and-deploy.md`](./agent-app-build-and-deploy.md)
- LAPS 密碼管理：[`laps-password-management.md`](./laps-password-management.md)
- BitLocker 加密：[`bitlocker-management.md`](./bitlocker-management.md)
- 設備生命週期：[`device-lifecycle.md`](./device-lifecycle.md)

## 8. 已知限制 / 未上 commit 項

以下 fix 真機 6/26 驗過，但**尚未正式 commit 到 main**（演示用 local working copy）：

- `app/routes/v1/apps.ts` — MSI download response 補 `Last-Modified + ETag + Content-Disposition filename` 一致
- `app/services/agent.ts` — `resolveAgentDevice` 加 token-first lookup + serial backfill
- `app/routes/v1/agent.ts` — 3 處 caller 傳 token
- `app/services/mdm/windows/csp.ts:458` — `buildMsiUninstall` 改 `Delete /MSI/{ProductID}` verb（不是 `Exec /Uninstall`）
- `app/services/mdm/windows/command.ts:352` — `triggerWnsPush` 標 export
- `app/services/app-deploy.ts` + `app/routes/v1/admin/app-deploy.ts` — 通用 install/uninstall 端點
- `app/routes/mount.ts` — 掛載 `appDeployAdminApp`
- `win-agent-app/src/CoGrowMDMAgent/Laps/SelfUninstallWatcher.cs` — spawn msiexec 前 `ClearTriggered()`（避免跨 enroll 殘留導致新 agent 自卸死循環；含在 agent v1.4.0.8 build）

正式 release 前需 commit 上述改動並做灰度發布（建議 ≥ 5 台跨型號 / OS 版本驗）。
