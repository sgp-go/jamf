# Windows MDM 故障排除手冊

> 本案開發過程踩過的 12 個坑 + 排查工具。新接手遇問題優先查此頁。

## 排查三件神器

```bash
# 1. ngrok inspector REST API（看 device ↔ server SyncML 明文）
curl -s "http://localhost:4040/api/requests/http?limit=20"

# 2. Server response 是 gzip + chunked，必須解壓才看得到
curl -s "http://localhost:4040/api/requests/http?limit=10" | python3 -c "
import sys, json, base64, gzip
d=json.load(sys.stdin)
for r in d.get('requests', []):
    raw=base64.b64decode(r['response']['raw'])
    sep=raw.find(b'\\r\\n\\r\\n'); body=raw[sep+4:]
    out=bytearray(); i=0
    while i<len(body):
        nl=body.find(b'\\r\\n',i)
        if nl<0: break
        try: sz=int(body[i:nl],16)
        except: break
        if sz==0: break
        i=nl+2; out+=body[i:i+sz]; i+=sz+2
    if b'gzip' in raw[:200].lower(): out=gzip.decompress(bytes(out))
    print(out.decode('utf-8', errors='replace')[:2000])"

# 3. SQL 看命令狀態變化
sqlite3 data/agent_reports.db "
  SELECT command_uuid, command_type, status, response_payload, datetime(responded_at)
  FROM mdm_commands
  WHERE device_udid LIKE 'windows-%'
  ORDER BY queued_at DESC LIMIT 10
"
```

## Win10 端事件日誌

`Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Admin` 含 OMA-DM 失敗詳情（CSP 路徑、操作類型、錯誤碼）：

```powershell
Get-WinEvent -LogName 'Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Admin' -MaxEvents 20 |
  Where-Object { $_.TimeCreated -gt (Get-Date).AddMinutes(-15) } |
  Format-List TimeCreated, Id, LevelDisplayName, Message
```

`Microsoft-Windows-PushNotification-Platform/Operational` 含 WNS push 接收細節（含 ErrorHResult）：

```powershell
Get-WinEvent -LogName 'Microsoft-Windows-PushNotification-Platform/Operational' -MaxEvents 30 |
  Where-Object { $_.TimeCreated -gt (Get-Date).AddMinutes(-15) }
```

---

## OMA-DM 命令循環類

### Bug：device 對 SyncHdr 永遠回 Data=500，所有命令永遠拿不到 ACK

**抓包證據**：
```xml
<Status MsgRef=37 Cmd=SyncHdr Data=500>
```
server response 中 `<MsgID>38</MsgID>` 跨 session 累加到大數（如 37、38、39...）。

**根因**：server MsgID 是 per-session 的（OMA-DM 1.2.1 §6.3）。跨 session 累加 device 視為非法。

**修法**：`command.ts` 中 `newServerMsgId = parseInt(parsed.header.msgId, 10) || 1`（鏡像 device 的 MsgID）。已修復（commit `b0b1b57`）。

### Bug：cmdId 推算錯位導致 ACK 對不上

**症狀**：device 回 status 但 `mdm_commands.responded_at` 沒回寫。

**根因**：原實作硬寫 `inFlight["2"] = uuid`，依賴 buildSyncML 順序分配，加 status 或多命令時偏移。

**修法**：`buildSyncML` 返回 `{xml, commandCmdIds}` 元數據，調用方用真實 cmdId 寫 inFlight（commit `8b1bb8a`）。

### Bug：session 切換沒清舊 inFlight，新 session 命令誤認 ACK

**症狀**：device 回某 cmdRef 但對到了上輪 session 的命令。

**修法**：sessionId 變化時 `state.inFlight = {}`（commit `b0b1b57`）。

---

## Inventory / 應用清單類

### Bug：AppInventoryQuery Get 路徑 device 回 400

**抓包**：
```
Get LocURI: ./User/Vendor/MSFT/EnterpriseModernAppManagement/AppInventoryResults?Filter=Output=Inventory
device: <Cmd>Get</Cmd><Data>400</Data>
```

**根因**：路徑漏中間段 `AppManagement/`（spec 真實路徑），且 `?Filter=...` query string 寫法不在 spec。

**修法**（commit `5e7dd66`）：兩段式 — 先 `Replace ./AppManagement/AppInventoryQuery` 寫 `<Inventory ... />` XML 設條件，再 `Get ./AppManagement/AppInventoryResults` 拿結果。

### Bug：Replace AppInventoryQuery device 回 405

**抓包**：server 實發的 Replace meta：
```xml
<Meta><Format xmlns="syncml:metinf">chr</Format></Meta>
```

**根因**：spec 要求 Format=xml，但 `command.ts` 從 DB 隊列還原命令時硬寫 chr（DB 沒存 format 列）。

**修法**（commit `edb80fa`）：`mdm_commands` 加 `syncml_format` 列；`buildAppInventoryConfig` 顯式設 `format: "xml"`，持久化下去。

### Bug：inventory 回來但 install_state 全空

**抓包** device 真實返回 `<Package PackageStatus="0" ...>`（不是 `InstallState`）。

**根因**：`Output=PackageDetails` 模式下 device 用 `<Package>` 元素 + `PackageStatus` 屬性；`Output=PackageNames|RequiresReinstall` 模式下才用 `<App>` + `InstallState`。

**修法**（commit `b34621b`）：`inventory.ts` parser 加 `PackageStatus` fallback。

---

## MSIX 安裝類（HostedInstall）

### Bug：直接 Exec HostedInstall device 回 404

**根因**：spec 要求兩段式 — 先 `Add ./AppInstallation/{PFN}` 創建 entity 節點，再 `Exec .../HostedInstall`。

**修法**（commit `4f87670`）：加 `buildMsixInstallAddNode`，`/apps/install` 路由一次 enqueue Add+Exec 兩條命令。

### Bug：install 完成後 update 又 404

**根因**：device install 完 PFN 節點被清，update 再 Exec HostedInstall 同樣找不到節點。

**修法**（commit `2c4733b`）：update 路由也走 Add+Exec 兩段式重新創建 entity。

### Bug：Add 200 + Exec 500「Appx 部署清單 無效」

**Win10 事件**：
```
Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Admin
EventId=404 操作類型: Execute, CSP URI: .../HostedInstall, 錯誤: Appx 部署清單 無效
```

**根因**：HostedInstall Data XML schema 錯。我們之前用：
```xml
<HostedInstallAction>
  <Source ContentURI="..."/>
  <Hash>...</Hash>
</HostedInstallAction>
```

實際 spec XSD：
```xml
<Application PackageUri="..." DeploymentOptions="N">
  <Dependencies>...</Dependencies>
</Application>
```

無 `<Hash>`（HTTPS 信任 MSIX 自簽）。`DeploymentOptions` 是 unsigned byte 位掩碼 attribute。

**修法**（commit `4f87670`）：重寫 `buildMsixInstall`。

### `DeploymentOptions` 位掩碼值

Microsoft 沒公開位含義，社區/Intune 抓包逆向：

| 位 | 對應 |
|---|---|
| 0x01 | ForceApplicationShutdown |
| 0x02 | DevelopmentMode |
| 0x04 | InstallAllResources |
| 0x08 | ForceTargetApplicationShutdown |
| 0x40 | ForceUpdateToAnyVersion |
| 0x80 | DeferRegistration |

`buildMsixUpdate()` 自動帶 0x40。

### MSIX 簽名失敗 / 證書不被信任

device 拉了 .msix 但安裝失敗：
- 檢查 `.msix` cert subject 是否與 manifest `<Identity Publisher="..."/>` 完全相同
- 檢查 cert 是否裝在 device 的 `LocalMachine\TrustedRoot` + `LocalMachine\TrustedPeople`
- Win10 Event Viewer → `Microsoft-Windows-AppXDeploymentServer/Operational` 看具體錯誤碼

詳見 [windows-mdm-msix-signing.md](./windows-mdm-msix-signing.md)。

---

## WNS Push 類

### Bug：push 200 received 但 device 不觸發

**Win10 PushNotification-Platform 日誌**：
```
EventId=1010 收到 raw notification ... 错误: NULL，资料不可用 count=0
ack 0x80070057 (E_INVALIDARG)
```

**根因**：push body 為空，OS 視為無效資料丟棄。

**修法**（commit `98cbb16`）：`WnsClient.sendRaw` 默認 body = 4-byte `"mdm\n"`。

### Bug：push body 對了仍不觸發（manifest-only MSIX）

**根因**：push-capable MSIX 必須含 `IBackgroundTask` 實現的 DLL + manifest 三件套：
```xml
<!-- Application 內 -->
<Extensions>
  <Extension Category="windows.backgroundTasks" EntryPoint="Foo.PushHandler">
    <BackgroundTasks>
      <Task Type="pushNotification" />
    </BackgroundTasks>
  </Extension>
</Extensions>

<!-- Package 頂層 -->
<Extensions>
  <Extension Category="windows.activatableClass.inProcessServer">
    <InProcessServer>
      <Path>CogrowMDMPush.dll</Path>
      <ActivatableClass ActivatableClassId="Foo.PushHandler" ThreadingModel="both" />
    </InProcessServer>
  </Extension>
</Extensions>

<!-- Capabilities -->
<DeviceCapability Name="systemPushNotification"/>
```

**修法**：用 [docs/scripts/build-push-msix-v2.ps1](./scripts/build-push-msix-v2.ps1) 生成（含 csc /target:winmdobj + WinMDExp 工具鏈）。

### Bug：MSIX 升級後 ChannelURI 不更新

**症狀**：v1 → v2 update 完成後 channel 還是舊的，push 路由到舊 handler 失敗。

**修法**：update 完後重發 `/push-config`，DMClient 重新註冊 channel，新 ChannelURI 入庫。

### push 對應的 device 一直 polling 5 分鐘觸發

**症狀**：發 push 後 device 6-9 秒沒響應，等到下個 polling cycle 才 1201。

**排查順序**：
1. `mdm_devices.wns_channel_uri` 是否非空？空 → 重跑 `/push-config`
2. `POST /push` 返回 `ok: true, status: 200`？401 → WNS_CLIENT_SECRET 過期；410 → channel expired，自動清空，再 push-config
3. Win10 `PushNotification-Platform/Operational` 日誌看 push 是否到達 + 錯誤碼
4. push-capable MSIX 是否真的安裝且 PFN == `WNS_PFN`？`Get-AppxPackage CoGrow.CogrowMDMPush` 確認

### channel expired (410)

server 自動清空 `mdm_devices.wns_channel_uri`。需重新跑：
```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/push-config -d '{}'
```
等 device poll 後新 ChannelURI 入庫。

---

## Polling 類

### polling 配置 ACK 200 但 device 仍 8 小時 poll

**根因**：DMClient 套用新配置後立即 reset 到密集 retry 階段（前 8 次），所以**配完最遲 5 分鐘內** 就會看到 device 自動 poll。如果 5 分鐘後還沒，檢查 `mdm_commands` 中 `PollConfig-*` 五條命令是否全部 status=acknowledged。

### device 完全離線

polling 失效（網路斷開、設備關機）。重新上線後：
- `PollOnLogin=true` 場景：用戶下次登入立即 poll
- 否則等下個 polling cycle

---

## Enrollment 類

### Discovery / Policy / Enrollment 三步任意一步 5xx

最常見三個原因：
1. 反代壓縮了 SOAP body（device client 拒絕）
2. SOAP 1.2 Content-Type 缺 `action="..."` 參數
3. DiscoverResult 元素順序錯（嚴格 client 拒絕）

詳見 [windows-mdm-enrollment-guide.md](./windows-mdm-enrollment-guide.md) 第 5 章「後端協議要點」。

### enrollment 成功但 GUI 不顯示「已連接」

GUI 顯示 race condition；後端 log 看 `Enrolled:` 即真成功。重啟 device 或重開設定面板會出現。

---

## 測試環境特有問題

### ngrok URL 變化後 device 失聯

ngrok 免費版每次重啟換 URL。enrollment 時 device 記住的 manage URL 會失效。**裝 ngrok 付費版固定子域名**或**生產用固定域名**。

### SCP from Win10 路徑寫錯

OpenSSH on Windows 用正斜杠路徑：
```bash
# ✅ 正確
scp ... AHS@192.168.50.68:/Temp/file.msix ./

# ❌ 失敗（反斜杠 escape 問題）
scp ... AHS@192.168.50.68:'C:\Temp\file.msix' ./
```

### PowerShell SSH 編碼亂碼

通過 SSH 跑 `powershell -Command "..."` 時 UTF-8 字符常亂碼。改用 `-EncodedCommand` + base64 UTF-16LE：

```bash
B64=$(python3 -c "import base64; print(base64.b64encode(open('script.ps1','r').read().encode('utf-16-le')).decode())")
ssh ... "powershell -EncodedCommand $B64"
```

---

## 開發期高頻指令

### 看設備最近 manage 請求

```bash
curl -s "http://localhost:4040/api/requests/http?limit=10" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('requests', [])[:5]:
    if '/api/mdm/win/manage/' in r.get('uri',''):
        print(r.get('start'), r.get('uri'))
"
```

### 重置某設備的 session state

```bash
sqlite3 data/agent_reports.db "
  UPDATE mdm_devices
  SET management_session_state=NULL, wns_channel_uri=NULL
  WHERE udid='windows-...'
"
```

### 清掉某設備所有命令 + 應用記錄

```bash
sqlite3 data/agent_reports.db "
  DELETE FROM mdm_commands WHERE device_udid='windows-...';
  DELETE FROM mdm_windows_apps WHERE device_udid='windows-...';
"
```

### 強制重發某條命令

```sql
UPDATE mdm_commands SET status='queued', sent_at=NULL, responded_at=NULL
WHERE command_uuid='<uuid>';
```

下次 device poll 會重新拉到。
