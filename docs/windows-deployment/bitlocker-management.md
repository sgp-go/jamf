# BitLocker 磁碟加密管理指南

> **適用對象**：台灣團隊後端工程師 + 學校 IT 管理員。
> **前提**：設備已納管且 Agent App 1.4.0+ 已安裝。

---

## 1. 概述

BitLocker 解決的問題：

學生可透過 USB 開機重灌系統，繞過所有 MDM 策略（包括防手動註銷、Agent 自保護等）。BitLocker 全碟加密後，即使拆碟或 USB 開機，資料與系統都受密鑰保護，配合 BIOS 啟動鎖形成完整防脫離閉環。

**解決方案**：設備納管後，自動靜默啟用 BitLocker 全碟加密（XTS-AES 256），Recovery Key 由 Agent 捕獲後上報後端，IT 按設備查詢。

---

## 2. 自動流程

設備透過 PPKG 納管後，BitLocker 加密**全自動**，無需手動觸發：

```
PPKG 納管 → install-agent 自動排入 BitLocker ADMX + Enable 命令
  → 設備消化命令 → ADMX 策略落地到 Registry 信箱
  → Agent BitLockerWatcher 5 秒內偵測 Pending=1
  → 執行 Enable-BitLocker -TpmProtector -SkipHardwareTest
  → 新增 RecoveryPasswordProtector → 捕獲 Recovery Password
  → 寫確認檔 → 下次 Agent 上報帶 encryption_id + recovery_password
```

**加密特性**：
- 演算法：XTS-AES 256（最強等級）
- 保護器：TPM + Recovery Password（48 位數字，8 組 6 位）
- 每台設備 Recovery Password 獨立
- 加密過程在背景執行，不影響使用者操作
- 無彈窗、無使用者確認（完全靜默）

---

## 3. 設備前提條件

| 條件 | 說明 |
|------|------|
| TPM 晶片 | 必須，且狀態為 Ready / Enabled / Activated。用 `Get-Tpm` 確認。 |
| Windows 版本 | Windows 10/11 Pro、Enterprise 或 Education（Home 版不支援 BitLocker）。 |
| Agent 版本 | 1.4.0+（含 BitLockerWatcher）。 |

> ⚠️ 不需要 Azure AD Join。本方案使用 Agent 本地執行，繞過了 Windows CSP 靜默加密對 AAD 的依賴。

---

## 4. 技術架構

### 為何不直接使用 BitLocker CSP？

Windows MDM 的 `./Device/Vendor/MSFT/BitLocker/RequireDeviceEncryption` CSP 在非 AAD 設備上無法靜默加密——Win10 會彈出確認框要求使用者手動同意。教育場景不能依賴學生點確認。

### ADMX 信箱模式

改用與 LAPS 一致的 Agent 執行模式：

```
後端                        設備
┌───────────┐              ┌─────────────────────────┐
│ ADMX CSP  │──OMA-DM────→│ Registry 信箱            │
│ Replace   │              │ HKLM\Software\CoGrow\   │
│           │              │   Agent\BitLocker\       │
│           │              │   Pending=1              │
│           │              │   EncryptionId=UUID      │
│           │              │   EncryptionMethod=...   │
└───────────┘              └──────────┬──────────────┘
                                      │ 5s 輪詢
                                      ▼
                           ┌─────────────────────────┐
                           │ BitLockerWatcher         │
                           │ Enable-BitLocker         │
                           │ -TpmProtector            │
                           │ -SkipHardwareTest        │
                           │ + RecoveryPassword       │
                           └──────────┬──────────────┘
                                      │
                                      ▼
                           ┌─────────────────────────┐
                           │ 確認檔                    │
                           │ bitlocker-confirmation   │
                           │   .json                  │
                           │ encryption_id            │
                           │ recovery_password        │
                           └──────────┬──────────────┘
                                      │ Agent report
                                      ▼
                           ┌───────────┐
                           │ 後端存儲   │
                           └───────────┘
```

### Registry 信箱路徑

```
HKLM\Software\CoGrow\Agent\BitLocker
  Pending          (DWORD)   — 1=待執行, 0=已完成
  EncryptionId     (REG_SZ)  — 唯一 ID（UUID，防重放）
  EncryptionMethod (REG_SZ)  — 加密演算法（XtsAes256）
```

### 確認檔路徑

```
C:\ProgramData\CoGrow\MDM Agent\bitlocker-confirmation.json
```

格式：

```json
{
  "encryption_id": "e0994126-b09b-404f-8198-5a4fccc6b25e",
  "recovery_password": "034386-466246-412808-216832-325061-463441-321299-112893",
  "confirmed_at": "2026-06-08T08:34:31Z",
  "success": true,
  "error": null
}
```

---

## 5. 查詢加密狀態

### 5.1 透過 Agent 上報

Agent 定期上報的 `extraData.windows.bitlocker` 包含：

| 欄位 | 說明 |
|------|------|
| `protection_status` | `Off` / `On` / `Unknown` |
| `volume_status` | `FullyDecrypted` / `EncryptionInProgress` / `FullyEncrypted` / `DecryptionInProgress` |
| `encryption_percentage` | 0-100 |
| `encryption_method` | `None` / `XTS-AES-256` / `XTS-AES-128` 等 |
| `key_protector_types` | `["TPM", "NumericalPassword"]` |
| `encryption_id` | 本次加密的唯一 ID（一次性，上報後刪除確認檔） |
| `recovery_password` | Recovery Password（一次性，上報後刪除確認檔） |

### 5.2 SSH 手動查詢

```powershell
# 加密狀態
Get-BitLockerVolume -MountPoint C: | Format-List

# TPM 狀態
Get-Tpm

# 詳細狀態
manage-bde -status C:
```

---

## 6. Recovery Key 使用場景

| 場景 | 操作 |
|------|------|
| TPM 故障 / 更換主機板 | 開機時輸入 48 位 Recovery Password |
| BIOS 更新導致 TPM 重置 | 同上 |
| 磁碟移到另一台設備 | 同上 |
| IT 需要從 USB 開機維護 | 先在 BitLocker 恢復畫面輸入 Recovery Password |

> ⚠️ Recovery Key 是解鎖加密碟的唯一後路。丟失 Recovery Key + TPM 異常 = 資料不可恢復。後端必須安全存儲。

---

## 7. 安全須知

| 環節 | 說明 |
|------|------|
| Recovery Password 傳輸 | Agent 確認檔以本地檔案存，上報時走 HTTPS + Agent Token。 |
| 後端存儲 | 建議與 LAPS 相同，以 AES-256-GCM 加密存 DB（`DATA_ENCRYPTION_KEY`）。 |
| Registry 暫態 | ADMX 信箱的 Pending/EncryptionId/EncryptionMethod 不含敏感資料（密碼由 Agent 本地生成，不經 Registry）。 |
| Audit | Recovery Key 查詢應記入 `audit_logs`。 |
| 加密過程 | 背景執行，不影響設備使用。464GB SSD 全碟加密約需 1-2 小時。 |

---

## 8. 故障排除

| 症狀 | 原因 | 解法 |
|------|------|------|
| Agent 已裝但未開始加密 | Agent 版本 < 1.4.0（無 BitLockerWatcher） | 透過 MDM 重新 install-agent 下發新版 |
| Pending=1 持續不變 | Agent 服務未正常運行 | `Get-Service CoGrowMDMAgent` 確認；查 Event Log |
| Enable-BitLocker 失敗 | 設備無 TPM 或 TPM 未就緒 | 執行 `Get-Tpm` 確認；部分機型需 BIOS 啟用 TPM |
| 加密後 Protection Off | 正常：加密進行中 Protection 是 Off，完成後自動變 On | 等加密完成（查 `EncryptionPercentage`） |
| Windows Home 版設備 | Home 不支援 BitLocker | 升級為 Pro/Education，或排除在加密策略外 |
