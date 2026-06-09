# iOS Managed App Configuration 鍵契約

> iOS Agent App 啟動時讀取 MDM 下發的 Managed App Configuration（標準字典
> `com.apple.configuration.managed`）取得連線與鑑權配置。本文是該配置的**權威契約**，
> 對齊 `ios-agent-app/AgentApp/Sources/Services/ReportService.swift`。

## 1. 鍵契約

App 從 `UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed")` 讀取
以下鍵（**全部為字串型別**）。取不到時 fallback 到本機 UserDefaults（僅供開發測試）。

| 鍵 | 型別 | 必填 | 範例 | 說明 |
|---|---|---|---|---|
| `serverURL` | string | ✅ | `https://api.cogrow.com` | API 基礎 host。App 自行拼出 `{serverURL}/api/v1/tenants/{tenantId}/agent/...`。**不含**尾斜線、不含 `/api/v1`。|
| `tenantId` | string (UUID) | ✅ | `6f9c2b8a-...` | 租戶 UUID。缺失 → App 拋 `missingTenant`，**不上報**。|
| `serialNumber` | string | ✅ | `F2L1234567` | 設備序號。iOS App **讀不到硬體序號**，必須由 MDM 注入；後端用 `(tenantId, serialNumber)` 唯一鎖定設備。|
| `agentToken` | string (hex 64) | ✅ | `a1b2c3...`（64 字元）| 上報鑑權 token。由 `agent-token` 端點簽發（見 §3）。簽發後缺此鍵 → 後端 **401**。|
| `deviceId` | string (UUID) | ⬜ | `9d4c2b8a-...` | 可選。預設用 `identifierForVendor`。後端設備標識以 `serialNumber` 為準，`deviceId` 僅作上報附帶欄位。|

> ⚠️ **鍵名大小寫敏感**，使用 camelCase（`serverURL` 而非 `server_url`）。這是 App 端寫死的鍵名。

## 2. Jamf Pro 注入方式

在 Jamf Pro → 該 App 的 **App Configuration**（Mobile Device Apps → CoGrow Agent →
Scope/App Configuration）填入 XML plist：

```xml
<dict>
    <key>serverURL</key>
    <string>https://api.cogrow.com</string>
    <key>tenantId</key>
    <string>6f9c2b8a-3e4d-4f5b-9c1a-7d8e9f0a1b2c</string>
    <key>serialNumber</key>
    <string>$SERIALNUMBER</string>
    <key>agentToken</key>
    <string>__PER_DEVICE_TOKEN__</string>
    <key>deviceId</key>
    <string>$UDID</string>
</dict>
```

**逐鍵說明**：
- `serverURL` / `tenantId`：**整個 tenant 常數**，所有設備共用同一份 App Configuration 即可。
- `serialNumber`：用 Jamf 內建變數 **`$SERIALNUMBER`**，Jamf 自動以各設備真實序號替換。
- `deviceId`：可用 `$UDID`（或省略，App 退回 Vendor UUID）。
- `agentToken`：**唯一的「每台不同」秘密值**，Jamf 沒有對應的內建變數（這是我方簽發的秘密，
  非 Jamf 設備屬性）。處理方式見下。

### agentToken 的每台注入（關鍵操作點）

因 `agentToken` 每台唯一，無法用單一共用 App Configuration 覆蓋全部設備。兩種落地：

1. **每台 / 每組 App Configuration（推薦）**：你方系統為每台設備呼叫 `agent-token` 取得 token
   後，透過 Jamf Pro API 對該設備（或單台 scope 的 app config）寫入帶該 token 的 App Configuration。
2. **Jamf 擴充屬性（EA）變數**：把 token 寫進該設備的 Jamf EA，App Configuration 用
   `$EXTENSIONATTRIBUTE_<id>` 引用。適合已有 EA 同步管線的場景。

> 過渡期：尚未簽發 token 的設備相容「不帶 token 上報」（後端 `agent_token_hash=null` 時放行）。
> 但**生產環境應一律簽發 token**，否則上報可被偽造（後端只能靠 serialNumber + IP 辨識）。

## 3. Agent token 簽發流程

iOS 無 Windows 的 `install-agent` MSI 注入鏈路，token 需單獨簽發：

```
POST /api/v1/admin/tenants/{tid}/devices/{deviceId}/agent-token
Authorization: Bearer <ADMIN_API_TOKEN>

← 200 { "ok": true, "data": {
    "deviceId":  "9d4c2b8a-...",
    "agentToken":"a1b2c3...（hex 64，僅此回傳一次）",
    "issuedAt":  "2026-06-09T10:00:00.000Z"
} }
```

- **agentToken 僅此 API 回傳一次**，DB 只存 SHA-256 hash，後續無法復原明文。妥善存入你方 vault。
- 簽發後該設備 `agent_token_hash` 非 null → 之後上報強制驗 token。
- **撤銷 / 換發**：對同一設備再次呼叫即覆蓋舊 hash，**舊 token 立即失效**（token 洩漏時的處置）。
- 此端點對任何平台設備都可用（iOS 主要場景；Windows 一般由 install-agent 簽發，特殊情況也可用此撤銷換發）。

## 4. 上報行為與 payload

App 用 `serverURL` + `tenantId` 拼路徑，帶 `Authorization: Bearer <agentToken>`：

| 端點 | 觸發時機 | payload 主要欄位 |
|---|---|---|
| `POST {serverURL}/api/v1/tenants/{tid}/agent/reports` | 背景任務（~15 min）+ 前台手動 | `deviceId, serialNumber, batteryLevel, storageAvailableMb, storageTotalMb, networkType, networkSsid?, screenBrightness, osVersion, appVersion, reportedAt` |
| `POST {serverURL}/api/v1/tenants/{tid}/agent/usage` | DeviceGuardKit 統計就緒 / 背景任務 | `serialNumber, sessionId?, stats[]`；`stats[]` = `{ date, totalMinutes, pickup, maxContinuous, timeStats? }` |

- `networkType` 取值：`WiFi` / `Cellular` / `Ethernet` / `None` / `Unknown`（與 Windows Agent 對齊）。
- `networkSsid`：**預設不採集**（恆為 null）。採集 SSID 需「Access WiFi Information」entitlement +
  定位授權，屬部署層決策，未啟用；如需開啟見 §5。

## 5. SSID 採集（可選，需 entitlement）

iOS 取 WiFi SSID 須同時滿足：
1. App 開啟 **Access WiFi Information** capability（Project.swift entitlements + Apple Developer App ID）。
2. 執行期取得**定位授權**（iOS 14+ 強制；`CLLocationManager`）。
3. 改 `StatusCollector` 用 `NEHotspotNetwork.fetchCurrent` 取值。

此為部署決策（涉及隱私授權彈窗 + entitlement 簽名），預設關閉。校園場景多數只需 `networkType`
即可滿足「是否在校網」判斷，建議不開 SSID 以免增加定位授權摩擦。

## 6. 排錯

| 現象 | 原因 | 處置 |
|---|---|---|
| App 不上報、log `missingTenant` | `tenantId` 未注入或為空 | 檢查 App Configuration 是否生效、鍵名拼寫 |
| 上報 401 `agent_token_required` | 設備已簽發 token，但 config 缺 `agentToken` | 注入步驟 3 取得的 token |
| 上報 401 `agent_token_invalid` | token 與 DB hash 不符（換發過 / 複製錯）| 重新簽發並更新 config |
| `serialNumber` 顯示 unknown | `$SERIALNUMBER` 未生效 / 手動模式未填 | 確認 Jamf 變數替換、查 Settings 頁「MDM 託管組態」區 |

> App 的 Settings 頁會展示當前生效的 `com.apple.configuration.managed` 全部鍵值，可現場核對。
