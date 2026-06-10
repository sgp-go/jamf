# 加密金鑰管理 SOP — `DATA_ENCRYPTION_KEY`

> **受眾**：CoGrow MDM 後端運維 / 資安負責人
> **適用版本**：2026-06-10 起（`app/lib/secrets.ts` AES-256-GCM 方案）
> **嚴重度**：🔴 P0。此金鑰遺失 = 多項機密**永久不可恢復**，且部分會導致已納管設備被鎖死。請在生產上線前完成本文所有 checklist。

---

## 1. 這把金鑰保護什麼

後端所有 `*_enc` 欄位（DB 中以 `v1:` 前綴儲存的密文）都由 `DATA_ENCRYPTION_KEY` 加解密。涵蓋：

| 機密 | 欄位 | 遺失金鑰的後果 |
|---|---|---|
| **自建 MDM CA 根私鑰** | `mdm_config.caKeyPemEnc` | 🔴 **最致命**。CA 私鑰不可恢復 → 無法再簽發/續期設備憑證；已簽發的設備憑證鏈失去信任根，重建 = 全體設備重新 enrollment |
| **APNS 推播私鑰** | `mdm_config.apnsKeyPemEnc` | 自建 MDM 推播通道斷，需重新申請 APNS 憑證 |
| **Vendor 私鑰** | `mdm_config.vendorKeyPemEnc` | 無法再簽 APNS CSR |
| **LAPS 管理員密碼** | `laps_*.passwordEnc` | 設備本機管理員密碼取不回 → 失去本機管理權 |
| **BitLocker Recovery Key** | `bitlocker_*.recoveryPasswordEnc` | 🔴 硬碟解不開 → 設備資料可能永久鎖死 |
| **Jamf OAuth secret** | `jamf_instances.clientSecretEnc` | Jamf 整合斷，需在 Jamf 重新生成憑據（可恢復） |
| **Webhook 簽名 secret** | `webhook_endpoints.secret`（欄位名非 `*_enc`，內容加密） | webhook 推送驗簽密鑰失效，`rotate-secret` 重發即可（可恢復） |
| **ASM/DEP token secret** | `asm_instances.consumerSecretEnc` / `accessSecretEnc` | ABM/ASM 同步斷，需重新上傳 DEP token（可恢復） |

> **判斷原則**：上表「可恢復」項是去上游（Jamf / Apple）重新生成憑據；**CA 私鑰、BitLocker Recovery Key 是不可恢復的** —— 它們只存在我方 DB，金鑰一丟就沒了。所以 `DATA_ENCRYPTION_KEY` 的備份等級 = **與 CA 私鑰、設備資料同級的最高機密**。

---

## 2. 技術規格（與 `app/lib/secrets.ts` 一致）

- **演算法**：AES-256-GCM（authenticated encryption，防篡改）
- **金鑰**：base64 編碼的 **32 bytes（256-bit）**，存於環境變數 `DATA_ENCRYPTION_KEY`
- **密文格式**：`v1:` + base64( `iv[12]` ‖ `authTag[16]` ‖ `ciphertext` )
- **向後相容**：`decryptSecret` 只對 `v1:` 前綴解密；無前綴一律當 legacy 明文原樣返回。既有明文行在**下次寫入時**自動升級為密文（不主動掃表升級）。
- **未設金鑰行為**：`encryptSecret` 走明文 passthrough（僅印一次 warn）。**生產環境視為配置事故** —— 機密會明文落 DB。

> ⚠️ **關鍵約束：密文不含 key-id**。`v1:` 是格式版本，不是金鑰版本。系統**無法多把金鑰並存**，因此輪換金鑰**必須對全表密文 decrypt(舊) → encrypt(新) 重寫**（見 §6），不能「新數據用新 key、舊數據用舊 key」。

---

## 3. 生成

```bash
# 32 bytes 隨機 → base64（與 secrets.ts getKey() 的 KEY_LEN=32 對齊）
openssl rand -base64 32
# 範例輸出（勿直接使用）：3Qk9... (44 字元 base64，解碼後恰 32 bytes)
```

驗證長度正確（解碼後必須 32 bytes，否則後端啟動即拋錯）：

```bash
echo -n "<貼上 base64 金鑰>" | base64 -d | wc -c   # 必須輸出 32
```

---

## 4. 存儲與分發

**鐵律：金鑰與 DB 備份必須分離保管。** 兩者若存在同一處（同一備份桶、同一主機、同一管理員可單獨取得），加密形同虛設 —— 一次洩漏即全解。

| 環境 | 推薦存儲 | 禁止 |
|---|---|---|
| 生產 | KMS / Secrets Manager（AWS Secrets Manager、GCP Secret Manager、HashiCorp Vault）注入到進程 env | ❌ 寫進 `.env` 並提交 git ❌ 與 `pg_dump` 備份放同一桶 ❌ 明文存 wiki / IM |
| Staging | 同生產機制，但獨立金鑰（**勿與生產共用**） | 同上 |
| Dev / test | 不設 = 明文 passthrough，可接受 | ❌ 用生產金鑰 |

- **分發**：金鑰交付走密鑰管理系統授權，不走 email / IM 明文。人工交接時用一次性密鑰分享（如 Vault 的 wrapped token）。
- **離線備援副本**：至少保留一份**離線**（紙本封存於保險箱 / 離線加密 USB），與線上 KMS 異地分離，作為 KMS 不可用時的最後防線。

---

## 5. 啟動校驗（建議補強）

`secrets.ts` 目前未設金鑰時只 warn-once、不阻止啟動。**生產環境建議在啟動腳本/部署流程加一道硬 guard**，避免「金鑰漏配 → 機密靜默明文落庫」：

```bash
# 部署前置檢查（systemd ExecStartPre / 容器 entrypoint / CI gate）
if [ -z "$DATA_ENCRYPTION_KEY" ]; then
  echo "FATAL: DATA_ENCRYPTION_KEY 未設置，生產環境拒絕啟動" >&2
  exit 1
fi
if [ "$(printf '%s' "$DATA_ENCRYPTION_KEY" | base64 -d | wc -c)" -ne 32 ]; then
  echo "FATAL: DATA_ENCRYPTION_KEY 解碼後非 32 bytes" >&2
  exit 1
fi
```

> 上線後可選的代碼側加強：在 `getKey()` 增加 `Deno.env.get("APP_ENV") === "production"` 時強制非空（本文僅記建議，未改代碼）。

---

## 6. 輪換（Rotation）

因 §2 的「密文無 key-id」約束，輪換是**一次性全表 re-encrypt**，需要短暫同時持有新舊兩把金鑰。

### 觸發時機
- 例行：建議 **12 個月**一次。
- 緊急：金鑰疑似洩漏（見 §7）。

### 流程（需停機窗口或只讀窗口）

```
1. 生成新金鑰 NEW_KEY（§3），與舊金鑰 OLD_KEY 同時在手（皆 base64 字串）。
2. 進維護窗口：暫停所有會寫加密欄位的操作
   （install-agent / laps-rotate / mdm-config / jamf-instances 寫入 / DEP token 上傳 /
    webhook-endpoints 建立 / rotate-secret）。
3. 先 dry-run 預檢（不寫庫，確認全部密文都能用 OLD_KEY 解開）：
     deno task reencrypt-secrets --old-key <OLD_KEY> --new-key <NEW_KEY>
4. 確認 dry-run 通過後，正式輪換（單事務，中途失敗整體 rollback）：
     deno task reencrypt-secrets --old-key <OLD_KEY> --new-key <NEW_KEY> --execute
   涵蓋表：jamf_instances / mdm_windows_laps / mdm_windows_bitlocker /
           self_mdm_configs / dep_tokens / webhook_endpoints（所有加密欄位，
           含 webhook_endpoints.secret——欄位名非 *_enc 但內容加密）
5. 將進程 env 的 DATA_ENCRYPTION_KEY 切為 NEW_KEY，重啟服務。
6. 抽樣驗證：GET laps-password / bitlocker-recovery 能正常解密明文。
7. 安全銷毀 OLD_KEY（KMS 標記停用 + 移除離線副本），保留審計記錄。
```

> **腳本**：[`app/scripts/reencrypt-secrets.ts`](../app/scripts/reencrypt-secrets.ts)（`deno task reencrypt-secrets`）。顯式傳新舊兩把金鑰，**不從 env 讀**（避免靠切換 env 製造併發污染）；底層用 `secrets.ts` 的 `encryptWith` / `decryptWith`。legacy 明文行會在輪換時順帶升級為密文。**不要**放進 drizzle migration 鏈 —— 它依賴運行期金鑰，不是 schema 變更。
> **重跑保護**：腳本逐行用 OLD_KEY 解密，若某行已是 NEW_KEY 密文（誤重跑）→ GCM 認證失敗、整體中止不寫入。先跑 dry-run（步驟 3）即可暴露。
> **回滾**：步驟 5 切換前，舊密文 + OLD_KEY 仍完全可用；切換後若發現問題，把 `--old-key` / `--new-key` 對調再 `--execute` 一次即反向還原。故 OLD_KEY 在驗證通過（步驟 6）前**不可銷毀**。

---

## 7. 遺失 / 洩漏應急

### 金鑰遺失（無任何備份可取回）
- §1 表中「可恢復」項：去上游重建 —— Jamf 重生 client secret、Apple 重新申請 APNS、重新上傳 DEP token。
- **不可恢復**項（CA 私鑰、BitLocker Recovery Key、LAPS 密碼）：DB 中對應密文成為**廢數據**。
  - CA：須 `POST /api/mdm/certs/ca/regenerate` 重建 CA → **全體自建 MDM 設備重新 enrollment**。
  - BitLocker：受影響設備若同時忘記 PIN / 硬碟需恢復 → 資料無法救援，只能重裝。
  - LAPS：失去本機管理員密碼 → 下次 checkin 觸發 `laps-rotate` 重設新密碼（設備在線才行）。
- ⇒ **這就是為什麼 §4 要求離線備援副本**。遺失的代價遠高於保管成本。

### 金鑰洩漏（外洩但數據未失）
1. 立即執行 §6 緊急輪換到新金鑰。
2. 輪換後，舊金鑰即使外流也無法解新密文（前提：攻擊者未同時拿到 DB 快照）。
3. 評估 DB 是否同期外洩；若是，視同數據洩漏走資安事件流程，並輪換上游憑據（Jamf/APNS/DEP）。
4. 排查洩漏途徑，記入事件報告。

---

## 8. 審計

- **金鑰本身的存取**：由 KMS / Secrets Manager 的存取日誌記錄（誰、何時取用金鑰）。生產務必開啟 KMS 審計。
- **被保護機密的明文存取**：查詢 LAPS 密碼 / BitLocker Recovery Key 的 admin API 已自動寫 `audit_logs`（操作者 + 時間 + 目標設備），用 `GET /admin/tenants/{tid}/audit-logs` 查閱。
- 審計日誌保留期：365 天（pg_cron，見 `app/db/ops/retention-pg-cron.sql`）。

---

## 9. 上線前 Checklist

- [ ] 生產 `DATA_ENCRYPTION_KEY` 已用 `openssl rand -base64 32` 生成，驗證解碼後 32 bytes
- [ ] 金鑰存入 KMS / Secrets Manager，**不在** `.env`、git、wiki、IM
- [ ] 金鑰與 DB 備份**分離保管**（不同桶/主機/權限）
- [ ] 至少一份**離線備援副本**異地封存
- [ ] Staging 用**獨立**金鑰，未與生產共用
- [ ] 部署流程含啟動校驗（§5：未設或長度錯則拒絕啟動）
- [ ] KMS 存取審計已開啟
- [ ] 輪換 SOP 已知會運維，re-encrypt 腳本列入 backlog（首次輪換前完成）
- [ ] 應急流程（§7）已納入資安事件手冊

---

## 10. 相關文件

- 加密實作：`app/lib/secrets.ts`
- 部署與 env 清單：[`backend-deployment.md`](./backend-deployment.md)（§10 Known Risks 引用本文）
- 資料保留：`app/db/ops/retention-pg-cron.sql`
- 對接指南：[`integration-guide.md`](./integration-guide.md)
