# LAPS 密碼託管 + 使用者密碼重設指南

> **適用對象**：台灣團隊後端工程師 + 學校 IT 管理員。
> **前提**：設備已納管且 Agent App 已安裝（Agent 版本 **v1.4.0.23+** 才有主動 confirm 通道；老版本走 daily report 兜底，同步延遲最長 24h）。

---

## 1. 概述

**兩類語意共用同一 LAPS 通道**（ADMX policy + registry mailbox + Agent LapsWatcher）：

| 類型 | 觸發 | 目標帳號 | 場景 |
|------|------|---------|------|
| **admin 自動輪換**（LAPS 本義） | Agent checkin 觸發 / 手動 API | tenant config `admin_account_name`（預設 `ITAdmin`） | 防 PPKG 明文管理員密碼洩漏 |
| **admin 手動輪換** | `POST /laps-rotate` | 同上 | IT 想立即換密 |
| **student 密碼重設**（新） | `POST /user-password/reset` | 管理員指定（e.g. `student`） | 學生忘密 / 新學期重設 |

**密碼特性**（`mode=random` 時）：
- 長度 8 字元
- 大小寫字母 + 數字各至少一個（純字母數字，無特殊符號，避免相容性 / 輸入問題）
- 密碼學安全隨機（`crypto.randomBytes`）
- 加密存 DB（AES-256-GCM，需設 `DATA_ENCRYPTION_KEY`）

---

## 2. Admin 帳號設定（重要）

**修訂 2026-07-03**：LAPS 目標帳號**改成從 tenant 配置讀**（原寫死 `Administrator` 已修）。

`self_mdm_configs.admin_account_name` VARCHAR(64) NOT NULL DEFAULT **'ITAdmin'** —— 對齊 PPKG 常見預配的日常 admin 帳號（Win11 內建 Administrator 預設禁用）。

若 PPKG 建的 admin 帳號名不同，用 `PATCH /admin/tenants/{tid}/mdm-config` 改：

```bash
curl -X PATCH /api/v1/admin/tenants/{tid}/mdm-config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"adminAccountName":"SchoolAdmin"}'
```

---

## 3. Admin 自動流程

設備透過 PPKG 納管後，LAPS 密碼輪換全自動：

```
PPKG 納管 → install-agent 自動排入 LAPS 輪換命令（目標帳號從 config 讀）
  → 設備消化命令 → ADMX 策略落地到 Registry
  → Agent LapsWatcher 2 秒內偵測 → 執行 net user 改密
  → 清除 Registry 明文 → 寫確認檔 + 主動 POST /agent/checkin 秒級 confirm（v1.4.0.23+）
  → backend mdm_windows_laps.status = 'confirmed'
```

---

## 4. Admin 密碼查詢

學校 IT 需要登入某台設備的管理員帳號時：

```bash
curl GET /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/laps-password \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

回應：

```json
{
  "ok": true,
  "data": {
    "password": "pUo(01:RtT(dvG_5dz>$",
    "adminAccount": "ITAdmin",
    "rotatedAt": "2026-07-03T10:27:38.904Z",
    "rotationId": "6bab816c-ce22-4bc6-9bf9-510296ade605",
    "status": "confirmed",
    "accountType": "admin",
    "requireChangeOnFirstLogon": false
  }
}
```

> ⚠️ 每次查詢寫 audit log `device.laps_password_viewed`。

---

## 5. Admin 手動輪換

```bash
curl -X POST /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/laps-rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"adminAccount": "ITAdmin"}'
```

- `adminAccount` 可選，省略時從 tenant config 讀 `admin_account_name`
- 新密碼自動生成，設備需在線

---

## 6. 學生密碼重設（新）

管理員指定學生帳號 + 密碼（明碼或隨機生成），Agent 執行 `net user`；可選強制首登改密。

### 端點

```bash
POST /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/user-password/reset
```

### Body

```json
{
  "targetAccount": "student",
  "mode": "explicit",           // 或 "random"
  "password": "NewStudent2026!", // mode=explicit 必填
  "requireChangeOnFirstLogon": true,
  "accountType": "student"       // 可選，預設 "student"
}
```

| 欄位 | 說明 |
|------|------|
| `targetAccount` | 目標本機帳號名；regex `^[a-zA-Z0-9._-]{1,20}$` 防 net user 參數注入 |
| `mode` | `explicit` = 用 body.password；`random` = 系統隨機 8 字元（純字母數字） |
| `password` | mode=explicit 必填，4-127 字元 |
| `requireChangeOnFirstLogon` | true = Agent 改密後額外跑 `net user <acct> /logonpasswordchg:yes` 強制帳號下次登入必須改密 |
| `accountType` | `admin` / `student` / `other`，預設 `student` |

### 回應（一次性明碼）

```json
{
  "ok": true,
  "data": {
    "rotationId": "eed41a09-f720-45d7-b98d-812cf7c567f2",
    "commandUuid": "091a2011-bd7a-494b-aa77-4b41f1a4043e",
    "password": "NewStudent2026!"
  }
}
```

> ⚠️ 明碼**只此 API 回傳一次**；後續透過 GET 查詢會寫 audit log。

### 查詢學生密碼

```bash
curl GET /api/v1/admin/tenants/{tid}/devices/{did}/user-password/student \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

回應同 §4 結構。**跨 admin/student/other 通用**，`targetAccount` 直接放 URL path。

---

## 7. 同步延遲 & 兜底

### 症狀（v1.4.0.22 或更早）
- API 呼叫回 200，命令 acked
- 設備上 `net user` 已改密（SSH 新密碼登入成功）
- **但 `mdm_windows_laps.status` 卡在 `pending`**
- `GET /laps-password` / `/user-password/{account}` 返回 **404 `user_password_not_found`**（只回 confirmed）
- 最長延遲 24h（daily report slot）

### Root cause
Agent 側 `LapsWatcher` 改密後只寫本地 `laps-confirmation.json`，靠 `DeviceReporter` 下次 **daily report slot** 上報 → backend confirm。

### 修復（v1.4.0.23+ 三級兜底）

| 路徑 | 觸發 | 延遲 |
|------|------|------|
| **主路徑** | 改密成功後 fire-and-forget POST `/agent/checkin` | 秒級 |
| **兜底 A** | 寫 registry `ConfirmedRotationId` → 下次 Agent restart `StartupCheckinService` 讀取上報 | Agent 重啟時 |
| **兜底 B** | 保留 `laps-confirmation.json` → daily report cycle | 最長 24h |

主路徑失敗（網路斷）也不影響本地改密，兜底路徑會補確認。

### Workaround（老 Agent）

如果 Agent 是 v1.4.0.22 或更早，還沒升級：

```sql
-- 找出待 confirm 的 row
SELECT rotation_id FROM mdm_windows_laps
WHERE device_id='<did>' AND status='pending'
ORDER BY created_at DESC LIMIT 1;

-- 手動 confirm
UPDATE mdm_windows_laps
SET status='confirmed', confirmed_at=NOW()
WHERE rotation_id='<latest_rotation_id>';
```

---

## 8. 設備移除時的密碼處理

呼叫 `POST /api/mdm/win/devices/{udid}/unenroll` 移除 MDM 時，會自動：
1. 將設備最新 LAPS row 對應帳號的密碼重置為 `123456`（方便 IT 後續重新操作）
2. 清除 LAPS 策略

---

## 9. 安全須知

| 環節 | 說明 |
|------|------|
| DB 加密 | 密碼以 AES-256-GCM 加密存儲（`v1:` 前綴），需設 `DATA_ENCRYPTION_KEY`。未設則明文（僅 dev 可接受） |
| Registry 暫態明文 | ADMX 策略落地時密碼以 REG_SZ 短暫存在於 `HKLM\Software\CoGrow\Agent\Laps\NewPassword`。Agent 2s poll 讀取後立即清除。只有 SYSTEM/Admin 可讀 |
| Audit log | 查詢 / 手動輪換 / 學生重設都記入 `audit_logs` |
| Rotation ID | 每次 UUID 唯一，Agent 確認時回傳，防止重放 |
| targetAccount 白名單 | Agent 側 `net user` 參數走 backend regex `^[a-zA-Z0-9._-]{1,20}$` 校驗，防注入 |
| requireChange 限制 | 帳號設「必須改密」後，Windows OpenSSH 對 password login **拒絕**（安全策略）；學生要走 GUI 登入被迫首登改密。這是 Windows 行為不是 bug |
