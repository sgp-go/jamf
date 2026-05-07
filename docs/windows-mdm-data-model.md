# Windows MDM 數據模型

> SQLite 表結構 + 字段含義 + 命令狀態機。`data/agent_reports.db`。

## 表清單

| 表 | 用途 |
|---|---|
| `mdm_devices` | 設備註冊狀態、PFN/ChannelURI、session state（Apple + Windows 共用，platform 字段區分） |
| `mdm_commands` | 命令隊列 + 狀態機（Apple + Windows 共用） |
| `mdm_certificates` | enrollment 時簽發的設備證書 |
| `mdm_windows_apps` | Windows 設備的應用清單（inventory query 結果） |

## `mdm_devices`

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | INTEGER PK | |
| `udid` | TEXT UNIQUE | 設備唯一 ID。Windows: `windows-<DeviceID>`；Apple: 設備 UDID |
| `serial_number` | TEXT | 序號（Apple 必有；Windows 可空） |
| `device_name` | TEXT | 設備名 |
| `model` | TEXT | 型號（如 `Surface Go 3`） |
| `os_version` | TEXT | OS 版本 |
| `enrollment_status` | TEXT | `enrolled` / `unenrolled` |
| `last_seen_at` | TEXT | 最近一次 OMA-DM session 時間 |
| `enrolled_at` | TEXT | enrollment 完成時間 |
| **Windows 專用** |
| `platform` | TEXT | `'apple'`（默認）/ `'windows'` |
| `windows_device_id` | TEXT | Win10 端 GUID（manage URL path 中的 deviceId） |
| `windows_hardware_id` | TEXT | hardware ID |
| `wns_channel_uri` | TEXT | 設備上報的 WNS push URL（`https://wns2-*.notify.windows.com/?token=...`）；**A 路徑必需** |
| `wns_channel_expiry` | INTEGER | channel 過期時間戳（保留欄位，當前未填） |
| `management_session_state` | TEXT (JSON) | OMA-DM session 狀態（lastSessionId / lastServerMsgId / inFlight 對映表） |

### `management_session_state` JSON 結構

```json
{
  "lastSessionId": "29",
  "lastServerMsgId": 38,
  "inFlight": {
    "2": "command-uuid-1",
    "3": "command-uuid-2"
  }
}
```

`inFlight` 是 server CmdID → command_uuid 的對映：每次 server 發 cmdId=N 的命令時記下，device 後續回 Status MsgRef=N 時用此查找 mdm_commands 命中。session 切換（sessionId 變化）時清空。

## `mdm_commands`

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | INTEGER PK | |
| `command_uuid` | TEXT | 業務唯一 ID（API 返回給 caller） |
| `device_udid` | TEXT | 對應 mdm_devices.udid |
| `command_type` | TEXT | 業務分類（見下方 enum） |
| `request_payload` | TEXT | Apple plist；Windows 為空（Windows 用 csp_path/syncml_*） |
| `response_payload` | TEXT | 設備回的 ACK 數據（如 `{"cmd":"Replace","data":"200"}`） |
| `status` | TEXT | 命令狀態（見下方狀態機） |
| `error_chain` | TEXT | 錯誤鏈 |
| `queued_at` | TEXT | 排入時間 |
| `sent_at` | TEXT | 發給 device 時間（device 第一次拉到後回填） |
| `responded_at` | TEXT | device ACK 時間 |
| **Windows 專用** |
| `platform` | TEXT | `'apple'` / `'windows'` |
| `csp_path` | TEXT | OMA-DM CSP LocURI（`./Vendor/MSFT/...`） |
| `syncml_verb` | TEXT | Add / Replace / Exec / Get / Delete |
| `syncml_data` | TEXT | XML body（Replace/Add/Exec 用） |
| `syncml_format` | TEXT | xml / chr / int / bool / b64 / node |
| `session_msg_id` | TEXT | 保留欄位 |

### 命令狀態機

```
       enqueueWindowsCommand
              ↓
         status='queued'
              ↓
       device 第一次 poll 拉到
              ↓
         status='sent' + sent_at=now
              ↓
       device 回 Status
              ↓
       ├── data 200-299 / 0 → status='acknowledged' + responded_at=now
       └── data 其他          → status='error' + responded_at=now
```

| status | 說明 | API 行為 |
|---|---|---|
| `queued` | 已排隊，device 還沒拉 | `getNextQueuedWindowsCommand` 取此狀態的命令發給 device |
| `sent` | 已發給 device，等 ACK | 不重發，等 ACK 或人工干預 |
| `acknowledged` | device 成功執行 | 終態 |
| `error` | device 拒絕或執行失敗 | 終態，看 `response_payload` 中的 status code |

### 重發某條命令

```sql
UPDATE mdm_commands
SET status='queued', sent_at=NULL, responded_at=NULL, response_payload=NULL
WHERE command_uuid='<uuid>';
```

下次 device poll 會重新拉到。

### `command_type` 常見值

| 值 | 對應 API |
|---|---|
| `MsixInstallAdd` | `/apps/install` 第一段（Add PFN entity） |
| `MsixInstall` | `/apps/install` 第二段（Exec HostedInstall） |
| `MsixUpdateAdd` | `/apps/update` 第一段 |
| `MsixUpdate` | `/apps/update` 第二段（Exec + ForceUpdateToAnyVersion） |
| `MsixUninstall` | `DELETE /apps/:pfn` |
| `UpdateScan` | `/apps/update-scan` |
| `AppInventoryConfig` | `/apps/refresh` 第一段（Replace 設條件） |
| `AppInventoryFetch` | `/apps/refresh` 第二段（Get Results） |
| `RemoteWipe` | `/wipe` |
| `PollConfig-0` ~ `-4` | `/poll-config` 五條 Replace 命令 |
| `PushSetPfn` | `/push-config` 第一段 |
| `PushGetChannelUri` | `/push-config` 第二段 |

### 「為何同一 API 排兩條命令」

許多 EnterpriseModernAppManagement / DMClient 操作必須兩段式：
- **install**：先 Add 創建節點，再 Exec
- **update**：同 install（PFN 節點 install 後被清）
- **inventory refresh**：先 Replace 設條件，再 Get
- **push-config**：先 Replace PFN，再 Get ChannelURI

`MAX_COMMANDS_PER_RESPONSE=5`（在 `command.ts`）保證一個 SyncML response 同輪下發多條，device 順序執行。

## `mdm_windows_apps`

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | INTEGER PK | |
| `device_udid` | TEXT | mdm_devices.udid |
| `package_family_name` | TEXT | PFN |
| `display_name` | TEXT | Identity Name |
| `version` | TEXT | 版本字串（如 `2019.19071.12548.0`） |
| `install_state` | TEXT | 安裝/狀態碼，**語義依 inventory 模式而定**：<br>- `Output=PackageNames\|RequiresReinstall` 模式：InstallState（0=NotInstalled / 1=Installing / 2=Installed / 3=Failed）<br>- `Output=PackageDetails` 模式（默認）：PackageStatus（0=OK，其他=錯誤碼） |
| `updated_at` | TEXT | 最近一次 inventory 入庫時間 |

upsert by `(device_udid, package_family_name)`。

### 同 PFN 多版本/多用戶情況

inventory query 可能對同 PFN 返回多條（不同 ProcessorArchitecture / Users SID）。當前實作 upsert 後**只保留最後一條**。生產若需保全部明細，schema 加 `package_full_name` 列做唯一鍵。

## `mdm_certificates`

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | INTEGER PK | |
| `device_udid` | TEXT | |
| `cert_pem` | TEXT | enrollment 時簽發的設備 cert PEM |
| `expires_at` | TEXT | 過期時間 |
| `issued_at` | TEXT | 簽發時間 |

每次 enrollment 寫一條。重 enrollment 會新增條目（不覆蓋）。

## Schema migration 規則

`src/db/sqlite.ts:initSchema` 在每次 `getDb()` 調用時跑：
- `CREATE TABLE IF NOT EXISTS` 是建表
- `ALTER TABLE ADD COLUMN` 是加欄位（每條包 try/catch，重複跑不報錯）

新加欄位的方式：
1. 在 `initSchema` 的 `alters` 數組加一行 `"ALTER TABLE xxx ADD COLUMN yyy TYPE"`
2. 部署後第一次起服自動 migrate
3. 永遠 idempotent，可重複跑

**禁止 DROP / RENAME / 修改欄位類型**（SQLite 不支持，且無法回滾）。如果非要改，新建表 + 遷移數據。

## SQLite WAL 與並發

```sql
PRAGMA journal_mode=WAL;
```

WAL 模式允許讀寫並發（讀不阻塞寫）。但 SQLite 本質單寫，不適合多 server 實例。生產規模 > 1 萬台或多實例需切 PostgreSQL（schema 簡單易遷）。

## 高頻查詢

```sql
-- 找未 ACK 的命令（>30min 警報）
SELECT * FROM mdm_commands
WHERE status='sent' AND responded_at IS NULL
  AND sent_at < datetime('now', '-30 minutes');

-- 找某 PFN 在所有設備的安裝狀態
SELECT device_udid, version, install_state
FROM mdm_windows_apps
WHERE package_family_name='AspiraMDM.Demo_cmnaf4m6btwng';

-- 命令成功率
SELECT command_type,
       COUNT(*) AS total,
       SUM(CASE WHEN status='acknowledged' THEN 1 ELSE 0 END) AS ok,
       SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS err
FROM mdm_commands
WHERE platform='windows'
GROUP BY command_type;

-- 設備是否在線（最近 polling 時間）
SELECT udid, datetime(last_seen_at), wns_channel_uri IS NOT NULL AS has_push
FROM mdm_devices
WHERE platform='windows'
ORDER BY last_seen_at DESC;
```
