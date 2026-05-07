# Windows MDM 管理 API 參考

> 完整 API 端點清單。前綴均為 `/api/mdm/win`（除 enrollment 協議端點外）。
> 所有非協議端點接受 JSON body + 回傳 JSON。

## 全表

| Method | Path | 用途 | 觸發延遲 |
|---|---|---|---|
| GET | `/api/mdm/win/devices` | 列出所有 enrolled Windows 設備 | 即時 |
| GET | `/api/mdm/win/devices/:udid` | 取設備詳情 | 即時 |
| GET | `/api/mdm/win/devices/:udid/commands` | 命令歷史 | 即時 |
| GET | `/api/mdm/win/devices/:udid/apps` | 應用清單 | 即時 |
| POST | `/api/mdm/win/devices/:udid/apps/install` | 安裝 MSIX（部署） | A: ~10s / B: ≤5min |
| POST | `/api/mdm/win/devices/:udid/apps/update` | 升級 MSIX | A: ~10s / B: ≤5min |
| DELETE | `/api/mdm/win/devices/:udid/apps/:pfn` | 卸載 MSIX | A: ~10s / B: ≤5min |
| POST | `/api/mdm/win/devices/:udid/apps/refresh` | 刷新應用清單 | A: ~10s / B: ≤5min |
| POST | `/api/mdm/win/devices/:udid/apps/update-scan` | 掃描所有可升級應用 | A: ~10s / B: ≤5min |
| POST | `/api/mdm/win/devices/install/bulk` | 批量派送 MSIX | A: ~10s / B: ≤5min |
| POST | `/api/mdm/win/devices/:udid/wipe` | 遠程清除 | A: ~10s / B: ≤5min |
| POST | `/api/mdm/win/devices/:udid/poll-config` | 設置 polling 間隔 | A: ~10s / B: ≤5min |
| POST | `/api/mdm/win/devices/:udid/push-config` | 設置 WNS push PFN | A: ~10s / B: ≤5min |
| POST | `/api/mdm/win/devices/:udid/push` | 立即發 WNS push | 立即 |
| POST/PUT | `/api/mdm/win/manage/:deviceId` | OMA-DM 管理通道（device 用） | — |
| GET/POST | `/EnrollmentServer/Discovery.svc` | MS-MDE2 Discovery（device 用） | — |
| POST | `/EnrollmentServer/Policy.svc` | MS-MDE2 Policy（device 用） | — |
| POST | `/EnrollmentServer/Enrollment.svc` | MS-MDE2 Enrollment（device 用） | — |

> **觸發延遲說明**：A 路徑 = WNS push 自動觸發（device 已配 push channel + enqueueWindowsCommand 自動帶 push）；B 路徑 = polling 兜底（最壞情況等到下次 polling cycle）。詳見 [windows-mdm-trigger-mechanism.md](./windows-mdm-trigger-mechanism.md)。

---

## 設備查詢

### `GET /api/mdm/win/devices` — 列表

```bash
curl http://localhost:3000/api/mdm/win/devices
```

回傳：
```json
{
  "devices": [
    {
      "udid": "windows-cdc0b2d5-9c2c-4004-8a9a-b507f9711c23",
      "deviceId": "cdc0b2d5-9c2c-4004-8a9a-b507f9711c23",
      "deviceName": null,
      "model": "Surface Go 3",
      "osVersion": null,
      "enrollmentStatus": "enrolled",
      "lastSeenAt": "2026-05-07T07:00:00.000Z",
      "wnsChannelUri": "https://wns2-sg2p.notify.windows.com/?token=...",
      "wnsChannelExpiry": null,
      "enrolledAt": "2026-05-06T10:16:19.864Z"
    }
  ]
}
```

### `GET /api/mdm/win/devices/:udid` — 詳情

同上單條結果。404 表 udid 不存在或非 windows 設備。

### `GET /api/mdm/win/devices/:udid/commands` — 命令歷史

回傳該設備所有 mdm_commands 記錄，含 status / responded_at / response_payload。

### `GET /api/mdm/win/devices/:udid/apps` — 應用清單

```json
{
  "apps": [
    {
      "package_family_name": "Microsoft.Windows.Photos_8wekyb3d8bbwe",
      "display_name": "Microsoft.Windows.Photos",
      "version": "2019.19071.12548.0",
      "install_state": "0",
      "updated_at": "..."
    }
  ]
}
```

> `install_state` 在 `Output=PackageDetails` 模式下實際是 `PackageStatus`（0=OK，其他=錯誤碼）。詳見 [windows-mdm-data-model.md](./windows-mdm-data-model.md)。

---

## 應用管理（4 大功能 1）

### `POST /apps/install` — 部署/派送 MSIX

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageFamilyName": "AspiraMDM.Demo_cmnaf4m6btwng",
    "contentUri": "https://your-host/app.msix",
    "isLOB": true,
    "forceApplicationShutdown": false,
    "deferRegistration": false,
    "dependencyUris": []
  }'
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `packageFamilyName` | ✅ | MSIX PFN（IdentityName_publisherHash） |
| `contentUri` | ✅ | HTTPS URL，device 拉 .msix |
| `isLOB` | 預設 true | 走 HostedInstall（自簽 LOB）；false 拋錯（StoreInstall 未支援） |
| `forceApplicationShutdown` | 預設 false | 強制關閉運行中應用以完成安裝（DeploymentOptions 0x01） |
| `deferRegistration` | 預設 false | 延遲註冊（DeploymentOptions 0x80） |
| `dependencyUris` | 預設 [] | 框架依賴 .msix HTTPS URL 列表 |

回傳：
```json
{
  "addUuid": "...",
  "execUuid": "...",
  "packageFamilyName": "...",
  "note": "Install queued (Add+Exec). Device will pick up on next poll (1-60 min)."
}
```

> Spec 要求兩段式：先 Add `./AppInstallation/{PFN}` 節點，再 Exec `HostedInstall`。直接 Exec → device 回 404。詳見 [troubleshooting](./windows-mdm-troubleshooting.md)。

**真機驗證流程**：
1. ngrok URL 必須對 device 可達
2. .msix 必須由 device 已信任的 cert 鏈簽名
3. 拉 + 安裝後，inventory query 反查 PFN 出現即成功

### `POST /apps/update` — 升級 MSIX

入參同 install。自動帶 `forceUpdateToAnyVersion=true`（DeploymentOptions 0x40），允許覆蓋升級甚至降版。

> 與 install 一樣需 Add+Exec 兩段。device install 完成後 PFN 節點會被清，update 也要 Add 重新創建 entity。

### `POST /apps/update-scan` — 掃描所有可升級

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/update-scan
```

無 body，無入參。device 端 DMClient 對所有 LOB 應用做更新檢查。

### `DELETE /api/mdm/win/devices/:udid/apps/:pfn` — 卸載

```bash
curl -X DELETE http://localhost:3000/api/mdm/win/devices/$UDID/apps/AspiraMDM.Demo_cmnaf4m6btwng
```

### `POST /apps/refresh` — 重新拉應用清單

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/refresh
```

兩段式（Replace AppInventoryQuery 設條件 + Get AppInventoryResults）。device 回的應用清單寫入 `mdm_windows_apps`。

### `POST /devices/install/bulk` — 批量派送（4 大功能 2）

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/install/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "deviceUdids": ["windows-...1", "windows-...2"],
    "packageFamilyName": "AspiraMDM.Demo_cmnaf4m6btwng",
    "contentUri": "https://your-host/app.msix"
  }'
```

回傳：
```json
{
  "total": 2,
  "queued": 1,
  "failed": 1,
  "results": [
    { "udid": "windows-...1", "addUuid": "...", "execUuid": "..." },
    { "udid": "windows-...2", "error": "device not found" }
  ]
}
```

不存在的 udid 標 error 但**不中斷整批**。

---

## 遠程清除（4 大功能 4）

### `POST /wipe` — RemoteWipe

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/wipe \
  -H "Content-Type: application/json" \
  -d '{"action":"doWipeProtected"}'
```

| `action` 值 | 含義 |
|---|---|
| `doWipe`（默認） | 一般清除 |
| `doWipeProtected` | 受保護清除（重置後重新進 OOBE） |
| `doWipePersistProvisionedData` | 保留預配資料（適合 Autopilot 重設） |

**真機驗證需可被 wipe 的虛擬機**（VirtualBox / VMware）。

---

## 觸發配置

### `POST /poll-config` — 設置 polling 間隔（B 路徑）

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/poll-config \
  -H "Content-Type: application/json" \
  -d '{
    "intervalFirst": 5,
    "countFirst": 8,
    "intervalRest": 15,
    "countRest": 0,
    "pollOnLogin": true
  }'
```

| 欄位 | 默認 | 說明 |
|---|---|---|
| `intervalFirst` | 5 | 前 N 次 retry 間隔（分鐘） |
| `countFirst` | 8 | 密集 retry 次數 |
| `intervalRest` | 15 | 之後穩態間隔（分鐘） |
| `countRest` | 0 | 0=無限 |
| `pollOnLogin` | true | 用戶登入時額外觸發 |
| `providerId` | "MS DM Server" | DMClient providerID（自建 MDM 用 magic name） |

排 5 條 Replace 命令到隊列。device 套用後即生效。

### `POST /push-config` — 設置 WNS push PFN（A 路徑前置）

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/push-config -d '{}'
```

無 body 或省略 `pfn` 時用 `.env WNS_PFN`。前置：device 上必須已裝 push-capable MSIX（PFN 完全匹配）。

排兩條：Replace `Push/PFN` + Get `Push/ChannelURI`。device 套用後 DMClient 註冊 channel，將 ChannelURI 上報，server 寫入 `mdm_devices.wns_channel_uri`。

### `POST /push` — 立即發 WNS push（手動）

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/push
```

從 DB 讀取 `wns_channel_uri` 立刻送 raw notification 到 device。返：
```json
{
  "ok": true,
  "status": 200,
  "wnsStatus": "received",
  "channelExpired": false
}
```

| 錯誤狀態 |
|---|
| 409 device 尚未上報 ChannelURI（先 push-config） |
| 410 channel expired（重跑 push-config，server 自動清舊 URI） |
| 502 WNS auth 失敗（檢查 .env WNS_* 凭据） |

> 一般情況**不用手動調 /push**。`enqueueWindowsCommand` 排隊任何命令時都會自動 fire-and-forget 觸發 push。/push 端點僅供 debug 或手動觸發 device 立刻 poll。

---

## Enrollment 協議端點（device 內部使用，外部不調）

### MS-MDE2

| Path | Verb | 用途 |
|---|---|---|
| `/EnrollmentServer/Discovery.svc` | GET | 探活 |
| `/EnrollmentServer/Discovery.svc` | POST | SOAP Discover 請求 |
| `/EnrollmentServer/Policy.svc` | POST | X.509 模板 |
| `/EnrollmentServer/Enrollment.svc` | POST | CSR 簽發 + 回 .ppkg |

### OMA-DM 管理通道

| Path | Verb | 用途 |
|---|---|---|
| `/api/mdm/win/manage/:deviceId` | POST/PUT | device 主動 poll，發 SyncML |

server 解析 SyncML、處理 client status / Results / Alert，從 `mdm_commands` 取下一筆 queued 命令回應。

詳見 [windows-mdm-enrollment-guide.md](./windows-mdm-enrollment-guide.md) 第 1-3 步。
