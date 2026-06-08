# 危險路徑 Checklist（W4 task 17 — 2026-05-28 dummy 跑通）

> 本次 session 用 dummy device 全跑了 server-side 危險路徑；task 57 真機 0 影響。
> 真機端的「設備真執行」驗證留下次（接 [[w4-task17-dummy-run]] 流程）。

## 前置（env 變量校正）

```bash
# Mac 端
export API_BASE="http://localhost:3000"      # 或 ngrok URL
export ADMIN_API_TOKEN="..."                 # ← 從 .env（注意是 ADMIN_API_TOKEN，不是 ADMIN_TOKEN）
export TENANT="9ad164db-fcd3-409d-9793-ed67dec601b2"   # demo tenant（task 57 真機也在此 tenant）
```

## 建 dummy

```bash
deno run -A --env-file=.env scripts/dummy-device.ts create \
  --tenant "$TENANT" --platform windows --name "DUMMY-WIN-DANGEROUS"

# 從輸出取：
export DUMMY_ID="..."     # internal UUID
export DUMMY_UDID="DUMMY-WIN-..."

# 結束清理
deno run -A --env-file=.env scripts/dummy-device.ts clear --tenant "$TENANT"
# 連動 FK cascade 清掉 mdm_commands 全部該 dummy 命令
```

## 17 條真實路徑（本次 dummy 全跑表）

| # | 行為 | 真實 endpoint | Body | dummy 結果 | 真機核心 |
|---|---|---|---|---|---|
| 1 | GET device | `GET /api/v1/tenants/{tid}/devices/{did}` | – | ✅ 200 + jamfError:device_not_synced | 核 Jamf detail |
| 2 | GET commands | `GET /api/v1/tenants/{tid}/devices/{did}/commands` | – | ✅ 200 paginated | – |
| 3 | LOCK | `POST .../devices/{did}/commands` | `{"command":"LOCK"}` | ✅ 200 — **Win 端走 Reboot CSP**（csp.ts:35 文檔化，無真鎖屏 CSP）| 真機真重啟 ⚠️ |
| 4 | WIPE | `POST .../devices/{did}/commands` | `{"command":"WIPE"}` | ✅ 200 — RemoteWipe doWipe | **嚴禁對 task 57 跑** |
| 5 | REBOOT | `POST .../devices/{did}/commands` | `{"command":"REBOOT"}` | ✅ 200 — 同 LOCK | 真機真重啟 |
| 6 | Windows Lock 自建路徑 | – | – | ⏭️ **端點不存在**（設計意圖：Win 沒真 Lock CSP；W1-9 Agent App 走 user32!LockWorkStation） | – |
| 7 | Windows Wipe 自建路徑 | `POST /api/mdm/win/devices/{udid}/wipe` | `{"action":"doWipe"}` | ✅ 200 + commandUuid | – |
| 8 | Windows Reboot 自建路徑 | `POST /api/mdm/win/devices/{udid}/reboot` | – | ✅ 200 + commandUuid | – |
| 9 | Manual push | `POST /api/mdm/win/devices/{udid}/push` | – | ✅ 409 — dummy 無 channelUri，防護生效 | – |
| 10 | Bulk command | – | – | ⏭️ **端點不存在**（只有 `/win/devices/install/bulk` 是 MSIX 安裝 bulk）| – |
| 11 | Transfer | `POST /api/v1/admin/tenants/{tid}/devices/{did}/transfer` | `{"targetDeviceGroupId":"<uuid>"}` | ✅ 200 — wipe 工作流觸發，落 mdm_commands | 真機真 wipe + 重 enroll |
| 12 | DELETE 解纳管 | `DELETE /api/v1/tenants/{tid}/devices/{did}` | – | 本 session 跳過（透過 dummy-device.ts clear 走 FK cascade 等價） | 真機解纳管後再 enroll 行為 |
| 13 | OMA-DM ack→webhook 全鏈 | `PUT /api/mdm/win/manage/{windowsDeviceId}` | SyncML Status 200 | ⏳ **留下次**（需構造 `scripts/syncml-ack-sample.xml`）| 真機 OMA-DM session 拉命令 |
| 14a | Create blocked-sites preset | `POST /api/v1/admin/tenants/{tid}/profile-presets/blocked-sites` | `{"displayName":"...","hosts":[...],"status":"active"}` | ✅ 201 — profile + csp payload 落表 | – |
| 14b | Assign profile | `POST /api/v1/admin/tenants/{tid}/profiles/{pid}/assign` | `{"scope":"device","deviceId":"<DUMMY_ID>"}` | ✅ 201 — assignment status=pending | – |
| 15 | DELETE assignment | `DELETE .../profiles/{pid}/assignments/{aid}` | – | ✅ 204 | – |
| 16 | Compliance evaluate | `POST .../devices/{did}/compliance/evaluate` | `{"policy":{...}}` | ✅ 200 — compliant:true | – |
| 17 | Install-agent | `POST .../devices/{did}/install-agent` | `{"appId":"<APP_UUID>","apiEndpoint":"https://..."}` | ✅ 202 — agentToken + 3 commandIds（Add/Exec/StatusQuery）| 真機真裝 .msi + agent 上報 ⚠️ |

## checklist 原版錯誤清單（供之前看過版本的人對照）

- ❌ `/command` 單數 → ✅ `/commands` 複數
- ❌ body `{commandType: "DeviceLock"}` → ✅ body `{command: "LOCK"}`（enum 大寫 + 跨平台中性名）
- ❌ Apple-only enum 名 `DeviceLock/EraseDevice/Restart` → ✅ 跨平台中性 `LOCK/WIPE/REBOOT` 或 Jamf 原生大寫 `DEVICE_LOCK/ERASE_DEVICE/RESTART_DEVICE`
- ❌ `/api/mdm/devices/{udid}/` → ✅ `/api/mdm/win/devices/{udid}/`（多 `/win/`）
- ❌ `/api/mdm/commands/bulk` 不存在 → ✅ 只有 MSIX 安裝 bulk `/api/mdm/win/devices/install/bulk`
- ❌ `ADMIN_TOKEN` → ✅ `ADMIN_API_TOKEN`

## 重要設計 finding（dummy 跑暴露 / 文檔化）

### LOCK on Windows = Reboot（silent fallback）

```
跨平台 POST .../commands {"command":"LOCK"}
  → Apple: Jamf DEVICE_LOCK API（真鎖屏 + Lost Mode message）
  → Windows: ./Device/Vendor/MSFT/Reboot/RebootNow ⚠️
```

`csp.ts:35-53` 已文檔化原因（Win10/11 Pro 無真正立即鎖屏 CSP；W1-9 Agent App 走
user32!LockWorkStation 才是真鎖屏方案）。**對 API 調用方而言這是個語義陷阱** — 期望
鎖屏實際重啟。OpenAPI 文檔可在 LOCK 描述加 `Windows: degrades to Reboot` 警告。

### dummy 防護分布

- ✅ **無 wnsChannelUri 阻擋 push**：`/api/mdm/win/devices/{udid}/push` 直接 409
- ✅ **APNS/WNS push 失敗不阻 enqueue**：mdm_commands enqueue 端不依賴 push 成功，所以 dummy
  可以 enqueue 但永不 sent
- ✅ **FK cascade 自動清**：DELETE dummy device 連帶清 mdm_commands / profile_assignments
- ✅ **dummy-device.ts clear 拒非 dummy**：`enrollmentType="dummy"` 才允許 CLI 刪

## 留給下次 session

1. **#13 構造 syncml-ack-sample.xml + webhook 全鏈驗證**（獨立小 task；不在「危險路徑」語義內，更像 webhook 集成測試）
2. **真機端 #3 #4 #5 #11 #17**：要 task 57 之外的真機或業主明確授權
3. **OpenAPI 文檔加 LOCK on Windows = Reboot 警告**（一行改動，可選）
