# Intune 共存部署 — Agent 自助註冊（遙測 only）

> **適用對象**：台灣團隊後端工程師 + 學校 IT。
> **場景**：存量 Windows 設備仍由 **Microsoft Intune** 納管，暫不遷移，但希望接入本平台的
> **使用時長 / 設備資訊 / 已裝軟體** 等遙測數據。
> **前提**：MDM 後端已部署（公網 HTTPS）、tenant 已建立並完成 `mdm-config` 初始化、Agent MSI
> 已構建（見 [agent-app-build-and-deploy.md](agent-app-build-and-deploy.md)）。

---

## 0. 先讀：能力邊界

| 能力 | Intune 共存（本文） | 自建 MDM 納管 |
|------|:---:|:---:|
| 使用時長 / 設備資訊 / 已裝軟體 / 電量 / 網路 上報 | ✅ | ✅ |
| 遠端鎖定 / wipe / 重啟 | ❌（歸 Intune） | ✅ |
| LAPS 密碼託管 / BitLocker | ❌（歸 Intune） | ✅ |
| CSP 策略（WiFi/VPN/防火牆/Kiosk/網站黑名單…） | ❌（歸 Intune） | ✅ |

**原因**：一台 Windows 的 OMA-DM 納管通道只能歸一個 MDM。設備歸 Intune，本平台就無法對它下
SyncML/CSP 命令，只能收 Agent 主動上報的遙測（HTTP + Bearer，與納管通道無關）。

**要拿全套管理能力**：須脫離 Intune、走自建 PPKG/OMA-DM 納管（見
[device-provisioning-guide.md](device-provisioning-guide.md)）。本方案是**共存 / 過渡**手段。

流程圖與時序見 [business-flows/23-intune-coexistence-agent-enroll.md](../business-flows/23-intune-coexistence-agent-enroll.md)。

---

## 1. 生成 tenant 級共享註冊密鑰

自助註冊靠一個 **tenant 級共享密鑰**（非 per-device token）授權。先為目標 tenant 生成：

```bash
curl -X POST /api/v1/admin/tenants/{tid}/agent-enrollment-secret \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# → 200
# {
#   "ok": true,
#   "data": {
#     "enrollmentSecret": "f6a5ff3e95ea88c9992717430138076bdfab39fcd4c06570",
#     "issuedAt": "2026-07-13T09:24:19.680Z"
#   }
# }
```

> ⚠️ **`enrollmentSecret` 僅此 API 回傳一次**，DB 只存 SHA-256，無法復原。當場保存，填入下一步的
> Intune 安裝命令行。丟失就重新生成（會使舊密鑰失效）。

**輪換 / 撤銷**：

```bash
# 輪換（生成新密鑰，舊密鑰立即失效；已簽發的 per-device token 不受影響）
curl -X POST /api/v1/admin/tenants/{tid}/agent-enrollment-secret -H "Authorization: Bearer $ADMIN_TOKEN"

# 撤銷（關閉自助註冊，後續 /agent/enroll 一律 403）
curl -X DELETE /api/v1/admin/tenants/{tid}/agent-enrollment-secret -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## 2. 為 Intune 打包 Agent MSI

用與自建 MDM **同一份** MSI（全租戶通用），差別只在安裝命令行帶的屬性。

### 安裝命令行

```
msiexec /i CoGrowMDMAgent.msi /qn /norestart ^
  API_ENDPOINT=https://<你的後端 host>/api/v1 ^
  TENANT_ID=<目標 tenant 的 UUID> ^
  ENROLLMENT_SECRET=<步驟 1 拿到的密鑰>
```

- **只帶三個屬性**：`API_ENDPOINT` / `TENANT_ID` / `ENROLLMENT_SECRET`。
- **不帶** `DEVICE_ID` / `AGENT_TOKEN` —— 留給 Agent 首啟自註冊換取。
- 同一條命令行派給該 tenant 下所有設備（共享密鑰非 per-device）。
- `API_ENDPOINT` 必須是**公網 HTTPS + `/api/v1` 後綴**（Windows 拒絕自簽 TLS；缺後綴會上報 404）。

### Intune 上架方式（二選一）

| 方式 | 命令行注入屬性 | 檢測規則 | 建議 |
|------|:---:|------|:---:|
| **Win32 app**（`.intunewin`） | 自訂 install 命令行（上方整條） | 自訂（ProductCode 或檔案存在） | ⭐ 更靈活 |
| **LOB MSI app** | 「命令列引數」欄填屬性（`API_ENDPOINT=.. TENANT_ID=.. ENROLLMENT_SECRET=..`） | 自動用 MSI ProductCode | 簡單場景可用 |

> ℹ️ **檢測規則注意**：Agent MSI 設 `ARPSYSTEMCOMPONENT=1`（從「新增/移除程式」隱藏，防學生
> 卸載），但 **ProductCode 仍在 Windows Installer 資料庫**，Intune 以 ProductCode 檢測安裝狀態
> 照常有效。Win32 app 若用「檔案存在」檢測更穩妥（如 `C:\Program Files\CoGrow\MDM Agent\CoGrowMDMAgent.exe`）。

打包步驟（Win32）：用 `IntuneWinAppUtil.exe` 把 `CoGrowMDMAgent.msi` 包成 `.intunewin`，上傳
Intune，安裝命令填上方整條，卸載命令 `msiexec /x {ProductCode} /qn`，檢測規則按上表。

---

## 3. 設備端自動流程（無需人工）

Intune 派發安裝後，Agent 首次啟動即自註冊，無需到設備操作：

1. MSI 把 `api_endpoint` / `tenant_id` / `enrollment_secret` 寫入 `HKLM\SOFTWARE\Policies\CoGrowMDM\Agent`。
2. Agent Service 啟動 → 讀 registry → 無 token 但有密鑰 → `POST /agent/enroll`（帶本機序號 + 密鑰）。
3. 後端建 `windows / agent_only / selfMdmManaged=false` 設備 + 簽 token → 回傳。
4. Agent 寫回 `device_id` + `agent_token`，**刪除** `enrollment_secret`。
5. 之後 checkin / reports / usage 全走 Bearer token，遙測正常上報。

---

## 4. 驗證清單

部署後確認（後端側可查 DB 或 Agent 上報端點）：

- [ ] 設備 registry 出現 `device_id` + `agent_token`，`enrollment_secret` 已被清空。
- [ ] 後端出現該設備：`platform=windows` / `enrollment_type=agent_only` / `self_mdm_managed=false` / `agent_token_hash` 非空。
- [ ] `agent_reports` 有該設備上報記錄（OS 版本等）。
- [ ] `device_usage_stats` 有該設備使用時長（`total_minutes` / `pickup` / `time_stats`）。

查詢範例（Agent 上報查詢端點，無需鑑權）：

```bash
curl GET /api/v1/tenants/{tid}/agent/devices/{serialNumber}/reports/latest
curl GET /api/v1/tenants/{tid}/agent/devices/{serialNumber}/usage
```

> **真機驗證（2026-07-13）**：Win10 22H2 真機（序號 `0B3436R230133F`）以本流程 Intune-mode 安裝
> Agent 1.4.0.99，自註冊換 token、清密鑰、上報 6 筆 reports + 11 筆 usage 全綠；WiX 構建 0 警告
> 0 錯誤。詳見 brain `[[intune-coexistence-self-enroll]]`。

---

## 5. 故障排除

| 症狀 | 可能原因 | 處理 |
|------|----------|------|
| `/agent/enroll` 回 403 `agent_enroll_disabled` | 該 tenant 未生成密鑰 / 已撤銷 | 重跑步驟 1 生成密鑰 |
| `/agent/enroll` 回 401 `enrollment_secret_invalid` | MSI 命令行密鑰與後端不符（已輪換？） | 用最新密鑰重新打包派發 |
| registry 有密鑰但 token 一直沒出現 | 開機時網路未就緒 / `API_ENDPOINT` 錯 | 查 `API_ENDPOINT` 是否公網 HTTPS + `/api/v1`；`AgentEnrollmentService` 每 30s 重試，網路恢復即成功 |
| 設備完全沒上報 | MSI 未帶三屬性 / registry 鍵缺失 | 確認 Intune 安裝命令行注入了 `API_ENDPOINT`+`TENANT_ID`+`ENROLLMENT_SECRET` |
| 升級後 token 丟失 | — | 不會發生：MSI `RegistrySearch` 會從現有 registry 回填 token（Intune 升級命令行不帶 token 時） |

---

## 6. 與自建 `install-agent` 的關係

- 兩者**上報鑑權完全一致**（平台無關 Bearer + hash）。
- 差異只在 token 怎麼到設備：`install-agent` 逐台 EDA-CSP 注入（設備歸本平台）；本流程 Agent
  自助換取（設備歸 Intune）。
- 一台設備**二選一**：要嘛歸 Intune 走本流程（僅遙測），要嘛脫 Intune 走自建納管（全管理）。
- 對照表見 [business-flows/23](../business-flows/23-intune-coexistence-agent-enroll.md#3-兩種模式對照)。
