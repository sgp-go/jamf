# Windows MDM 端到端 Demo 演示腳本

> 提供給對接團隊（台灣後端）做產品演示用的標準流程腳本。
> 真機端到端驗證日期：**2026-06-26**（Win11 24H2 Pro / Lenovo IdeaPad 700 PF5XSMN1）。

## 1. 演示前準備（30 分鐘）

### 1.1 後端服務

```bash
# 確認 deno + ngrok 都在跑
ps aux | grep -E "(deno|ngrok)" | grep -v grep
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/openapi.json   # 期望 200
curl -sS -o /dev/null -w "%{http_code}\n" https://<your-ngrok-url>/openapi.json # 期望 200
```

**❗ ngrok free 月度 1GB 限額**：每次 MSI 全量下載吃 79MB；演示前確認 ngrok dashboard 餘量充足。生產建議 paid ngrok / Cloudflare Tunnel。

### 1.2 backend 配置確認

```sql
-- self_mdm_configs.app_download_base_url 必須是 HTTPS（EDA-CSP LocalSystem 對 HTTP 不友善）
SELECT public_base_url, app_download_base_url FROM self_mdm_configs WHERE is_active=true;
```

期望：兩者都是 `https://<ngrok-or-cloudflare-tunnel>`。

### 1.3 設備要求

- **Win11 Pro / Education / Enterprise**（Home 不支援 EDA-CSP，整批 SyncML 命令返 406）
- 設備乾淨狀態（從未 enroll 過或已徹底 cleanup）
- 同網段 LAN 連通（如果走 LAN HTTP fallback）

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

- [ ] backend deno 進程在跑（`ps aux | grep deno`）
- [ ] ngrok tunnel 200（`curl ngrok-url/openapi.json`）
- [ ] ngrok bandwidth 餘量 > 200MB（dashboard）
- [ ] `app_download_base_url` 配置為 HTTPS
- [ ] `apps` 表有 Agent MSI 最新版本（按 `createdAt DESC` 自動選）
- [ ] 7-Zip MSI 已上傳並記下 `appId`
- [ ] 演示設備乾淨（無殘留 enrollment / agent / PPKG dedup cache）
- [ ] 演示設備 Network = Private（`Set-NetConnectionProfile -NetworkCategory Private`）
- [ ] 演示設備網絡可上 ngrok URL（無公司網路防火牆攔截）
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

### Q4：ngrok 突發返 403 ERR_NGROK_725

**ngrok free 月度 1GB 流量耗盡**。立即升級 paid（$8/月起），或等下月 1 號 reset。Demo 前必須確認餘量。

### Q5：設備重啟後 SSH 連不上

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
