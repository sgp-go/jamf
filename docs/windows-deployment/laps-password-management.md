# LAPS 密碼託管指南

> **適用對象**：台灣團隊後端工程師 + 學校 IT 管理員。
> **前提**：設備已納管且 Agent App 已安裝。

---

## 1. 概述

LAPS（Local Administrator Password Solution）解決的問題：

PPKG 批量部署時所有設備共用同一個管理員臨時密碼。PPKG 含明文且 `.ppkg` 可解包，一旦洩漏等於全設備管理員密碼失陷、防脫離全線崩潰。

**解決方案**：設備納管後，自動將管理員密碼改為**每台獨立的隨機值**，加密存後端，IT 按設備查詢。

---

## 2. 自動流程

設備透過 PPKG 納管後，LAPS 密碼輪換**全自動**，無需手動觸發：

```
PPKG 納管 → install-agent 自動排入 LAPS 輪換命令
  → 設備消化命令 → ADMX 策略落地到 Registry
  → Agent LapsWatcher 2 秒內偵測 → 執行 net user 改密
  → 清除 Registry 明文 → 寫確認檔
  → 下次 Agent 上報帶 rotation_id 確認
```

**密碼特性**：
- 長度 20 字元
- 包含大小寫字母 + 數字 + 符號
- 每台設備獨立（密碼學安全隨機）
- 加密存 DB（AES-256-GCM，需設 `DATA_ENCRYPTION_KEY`）

---

## 3. IT 查詢密碼

學校 IT 需要登入某台設備的管理員帳號時，呼叫 API 查詢：

```bash
curl GET /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/laps-password \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

回應：

```json
{
  "ok": true,
  "data": {
    "password": "gTTW,QZGGJ8KO0;*3aX:",
    "adminAccount": "Administrator",
    "rotatedAt": "2026-06-05T07:04:12.902Z",
    "rotationId": "6f6c91aa-5c48-435e-8bbb-28756ee73bdd",
    "status": "confirmed"
  }
}
```

> ⚠️ 每次查詢都會寫 audit log（`device.laps_password_viewed`）。

---

## 4. 手動觸發輪換

需要立即更換某台設備的管理員密碼時：

```bash
curl -X POST /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/laps-rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"adminAccount": "Administrator"}'
```

- `adminAccount` 可選，省略時預設 `Administrator`
- 新密碼自動生成，設備需在線（透過 SyncML poll 或 WNS push 取得命令）

---

## 5. 設備移除時的密碼處理

呼叫 `POST /api/mdm/win/devices/{udid}/unenroll` 移除 MDM 時，會自動：
1. 將管理員密碼重置為 `123456`（方便 IT 後續重新操作）
2. 清除 LAPS 策略

---

## 6. 安全須知

| 環節 | 說明 |
|------|------|
| DB 加密 | 密碼以 AES-256-GCM 加密存儲（`v1:` 前綴），需設 `DATA_ENCRYPTION_KEY` 環境變數。未設則明文存儲（僅 dev 可接受）。 |
| Registry 暫態明文 | ADMX 策略落地時密碼以 REG_SZ 短暫存在於 `HKLM\Software\CoGrow\Agent\Laps\NewPassword`。Agent 2 秒內讀取後立即清除。只有 SYSTEM/Admin 可讀。 |
| Audit | 每次 IT 查詢密碼、手動輪換都記入 `audit_logs`。 |
| Rotation Token | 每次輪換帶唯一 `rotationId`（UUID），Agent 確認時回傳，防止重放。 |
