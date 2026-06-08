# A+B 雙層觸發機制

> 📌 **本文自 `docs/archived/windows-mdm-trigger-mechanism.md` 遷入**——WNS push（A）+ polling（B）雙層觸發原理與租戶無關，**完全適用生產**。幫助理解「為何遠端命令有時秒級、有時分鐘級」。push（A 路徑）的自建前置見 [push-infrastructure-setup.md](push-infrastructure-setup.md)。

> 為何排了命令 device 不立刻執行？理解此文後就清楚。

## 核心問題

OMA-DM 是 **device 主動 poll** 協議，server 不能主動推送命令。命令只能在 `mdm_commands` 表排隊，等 device 下次 poll 時拉走執行。

預設 polling 間隔 8 小時，太久。本案實作雙層觸發：

| 層 | 機制 | 延遲 | 可靠性 |
|---|---|---|---|
| **A**（push） | server 通過 WNS 發 raw notification → OS 喚醒 device → DMClient 立刻發 OMA-DM session | **6-9 秒** | 依賴 WNS、device 在線、push-capable MSIX 正確安裝 |
| **B**（polling） | device 按設定間隔自動發 OMA-DM session | 5-15 分鐘 | 不依賴外部，device 在線即可 |

## A+B 協作

```
[user POST /apps/install]
        ↓
[server enqueueWindowsCommand]
        ↓
        ├─ 寫 mdm_commands 表
        ├─ console.log "命令已排入"
        └─ fire-and-forget triggerWnsPush(udid)（不 await）
                  ↓
                  └─ device 有 wns_channel_uri？
                          ├─ 有 → WNS API send raw → device ~10s 觸發 1201
                          └─ 沒 → 靜默跳過，B polling 兜底
```

**A 失敗時 B 自動兜底**：device 仍按 polling 間隔 poll，命令最遲在下個 cycle 拉走。
**A 與 B 不互斥**：device 始終 polling 同時也接 push。

## 配置兩層生產推薦

```bash
# 1. 設置 polling（B 路徑）
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/poll-config \
  -d '{"intervalFirst":5,"countFirst":8,"intervalRest":15}'

# 2. 設置 push（A 路徑前置：必須先裝 push-capable MSIX）
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/push-config -d '{}'
# 等 device 上報 ChannelURI 入庫後，A 路徑就生效

# 3. 之後排任何命令都自動雙層觸發
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/refresh
# server log: "命令已排入: ... type=AppInventoryConfig"
# server log: "WNS push 已發 (received)"
# device:    ~10s 後 1201
```

---

## A 路徑：WNS push 詳解

### 前置條件

1. **`.env` WNS 凭据**：`WNS_PACKAGE_SID` + `WNS_CLIENT_SECRET` + `WNS_PFN` 三件套（見 [wns-account-setup.md](wns-account-setup.md)）
2. **push-capable MSIX 已裝**：PFN 必須 == `WNS_PFN`，含 `IBackgroundTask` 實現 + manifest 三件套（見 [msix-signing.md](msix-signing.md) 第 3 節）
3. **DMClient Push/PFN 已 Replace**：device 收 push 後 DMClient 才認得這個 channel
4. **device 已上報 ChannelURI**：`mdm_devices.wns_channel_uri` 非空

任一條件缺失 → A 失效 → 自動退化到 B。

### 完整鏈路 5 段

```
[server enqueueWindowsCommand]
   ↓
[WnsClient OAuth] → access_token (cache 12h)
   ↓
POST <channelUri> + X-WNS-Type: wns/raw + bearer + 4-byte body
   ↓
[Microsoft WNS broker] (https://*.notify.windows.com/...)
   ↓
[Win10 OS WNS service] 收 push → 路由給 PFN 對應的 push handler
   ↓
[DMClient 服務] 監聽 OS push 事件 → 發 OMA-DM session 到 manage URL
```

任一段出錯都回退到 B。

### 真機延遲實測

| Push # | T0 | Device 1201 | 延遲 |
|---|---|---|---|
| #1 | 15:01:55 | 15:02:02 | 7 秒 |
| #2 | 15:03:44 | 15:03:50 | 6 秒 |
| #3（自動） | 15:24:50 | 15:24:59 | 9 秒 |

對比 polling：device 上次 poll 14:57:08 + 5 min = 15:02:08（被 push 提前了 ~3 分鐘）。

### 失敗模式

| 症狀 | 根因 | 修法 |
|---|---|---|
| `WnsClient` 拋 `WnsAuthError` | OAuth 拒（PackageSID 缺 `ms-app://` 前綴） | 檢查 `.env WNS_PACKAGE_SID` |
| WNS API 回 200 received 但 device 不觸發 | body 為空 device 拒收 0x80070057 | 必須非空 body（默認已修） |
| WNS API 回 200 received 但 device 不觸發 | push-capable MSIX manifest 不全（缺 backgroundTasks 或 inProcessServer 聲明） | 用 `docs/scripts/build-push-msix-v2.ps1` 重生成 |
| WNS API 回 410 | channel expired | server 自動清空 `wns_channel_uri`，重跑 `/push-config` |
| WNS API 回 401 | token 過期 | 自動 refresh + retry once，無需介入 |

---

## B 路徑：polling 詳解

### DMClient Poll 節點

路徑：`./Vendor/MSFT/DMClient/Provider/MS DM Server/Poll/<param>`

| 參數 | 默認 | 推薦 | 說明 |
|---|---|---|---|
| `IntervalForFirstSetOfRetries` | 15 min | **5 min** | 前段密集 retry 間隔 |
| `NumberOfFirstRetries` | 8 | 8 | 密集 retry 次數 |
| `IntervalForRemainingScheduledRetries` | 480 min（8h）| **15 min** | 後段穩態間隔 |
| `NumberOfRemainingScheduledRetries` | 0 | 0 | 0 = 無限循環 |
| `PollOnLogin` | false | **true** | 用戶登入時立即 poll |

### 配置生效時機

API 排隊後 **下一輪 device poll** 拉到並套用，立刻按新配置 reset 到密集 retry 階段。即配 5 min 間隔，下次 poll 後就 5 min 一個 cycle。

### 設備離線

device 離線時 polling 自然失敗。重新上線後 DMClient 立即觸發一次 poll（PollOnLogin=true 場景），或在下個間隔 cycle 內觸發。

---

## 為什麼不只用 A 或只用 B？

**只用 A 的問題**：
- 客戶網路阻擋 `*.notify.windows.com` → push 全失效（政企內網常見）
- WNS 凭据過期忘了輪替 → push 全失效
- push-capable MSIX 註冊出問題 → push 全失效

**只用 B 的問題**：
- 緊急 wipe / 即時鎖屏不能等 5 分鐘
- 1000 台設備同時 polling 對 server 是脈衝壓力，需要 B 間隔較大

**A+B 結合**：A 提供秒級響應，B 兜底 + 提供「devices alive」健康訊號（即便 A 全失效，也能在分鐘級確認設備狀態）。

---

## 命令排隊行為一覽

| 觸發 | A push | B polling |
|---|---|---|
| `enqueueWindowsCommand` 任何命令 | ✅ 自動 fire-and-forget | ✅ 始終 |
| `PushSetPfn` / `PushGetChannelUri` 內部命令 | ❌ 跳過（避免雞生蛋） | ✅ |
| `PollConfig-*` 內部命令 | ❌ 跳過 | ✅ |
| 手動 `POST /push` | 立即發 | — |

---

## 與 iOS / macOS APNs 對比

iOS / macOS Jamf 用 APNs（Apple 自家推送）— 邏輯類似但實現不同：
- APNs 凭据是 .p12 cert（Apple Developer 後台簽發）
- WNS 凭据是 OAuth client_credentials（Microsoft Partner Center 提供）
- APNs 一個 cert 對應一個 topic（PFN-equivalent）；WNS 一個 PackageSID 對應一個 PFN
- 兩者均需 device 上有對應的 receiver app 才能路由

實作角度：本案 `src/wns/client.ts` ↔ `src/mdm/apns-client.ts`，職責對等。
