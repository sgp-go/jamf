# iOS APNs 推送憑證管理

> APNs（Apple Push Notification service）是 iOS MDM 喚醒設備收命令的唯一通道（等價於
> Windows 的 WNS）。**iOS Agent App 本身的「上報」不依賴 APNs**（App 主動 HTTPS POST）；
> APNs 只用於 MDM 命令推送（鎖定 / Lost Mode / 派 App 等）。

## 1. 兩條路徑，憑證歸屬不同

| 路徑 | 狀態 | APNs 憑證歸屬 | 管理位置 |
|---|---|---|---|
| **Jamf 整合（當前主路徑）** | ✅ 生產 | **Jamf 的 MDM Push Certificate** | Jamf Pro 後台 |
| **自建 MDM（遷移 / 未來）** | 過渡能力 | **我方 APNs 憑證** | `/api/mdm/certs/apns/*` |

當前 iOS 設備經 Jamf 納管（`jamf-instances` + `sync-devices`），命令經後端路由到 Jamf 下發，
**APNs 由 Jamf 持有與管理**，台灣後端與我方一般不直接碰 iOS APNs 憑證。

## 2. Jamf 路徑（當前）

### 申請 / 續期
Jamf Pro 的 MDM Push Certificate 由 **Apple Push Certificates Portal**（identity.apple.com）簽發：

```
Jamf Pro → Settings → Global → Push Certificates
  → Renew / Upload（透過 Apple Push Certificates Portal CSR 流程）
```

### 關鍵運維紀律
- **有效期 1 年**，到期 MDM 全面失聯（無法下命令）。
- **必須用「Renew」續用同一憑證**——切勿在 Apple Portal 新建（新建會換 topic → 所有設備需重新納管，災難）。
- 續期綁定的 **Apple ID 必須是機構帳號**（非個人，避免人員離職丟失）。
- 設到期前 30-60 天的提醒。

> 此項由 Jamf 擁有者（我方 ops / 客戶 Jamf 管理員）負責，台灣後端只需知道：
> iOS 命令突然全部 queued 不下發 → 先查 Jamf Push Certificate 是否過期。

## 3. 自建 MDM 路徑（遷移 / 未來才用）

若未來把 iOS 從 Jamf 遷到自建 MDM（`/api/mdm`），APNs 憑證改由我方持有，端點：

| 端點 | 用途 |
|---|---|
| `GET /api/mdm/certs/vendor/csr` | 生成 Vendor CSR（供 Apple Developer 後台）|
| `POST /api/mdm/certs/vendor` | 上傳 Vendor Certificate |
| `GET /api/mdm/certs/apns/csr` | 生成 APNS CSR |
| `POST /api/mdm/certs/apns/sign` | 用 Vendor Cert 簽署 APNS CSR |
| `POST /api/mdm/certs/apns` | 上傳 APNS 推播憑證（自動提取 topic）|
| `GET /api/mdm/certs/status` | 查憑證狀態（APNS / CA / DEP）|

### 多租戶隔離
自建 MDM 下，APNs topic 全租戶共用一張機構憑證即可（topic 綁的是 push 身份，非租戶）；
租戶隔離靠 DB 的 `tenant_id` + enrollment 路由（`/t/{slug}/EnrollmentServer/*`），不需 per-tenant APNs。

## 4. 排錯速查

| 現象 | 可能原因 | 處置 |
|---|---|---|
| iOS 命令全 queued、設備不執行 | Jamf APNs 憑證過期 | Jamf 後台 Renew |
| 續期後設備全失聯 | 在 Apple Portal 誤新建（換了 topic）| 只能用舊憑證 Renew；已換則設備需重納管 |
| 自建 MDM 推送無回應 | APNs topic 不符 / 憑證未上傳 | `GET /api/mdm/certs/status` 查狀態 |

> 對台灣後端：iOS 命令下發異常時，**先區分當前是 Jamf 路徑（查 Jamf 憑證）還是自建 MDM 路徑**，
> 兩者排查入口不同。
