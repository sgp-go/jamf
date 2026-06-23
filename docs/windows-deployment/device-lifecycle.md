# 設備生命週期管理

> **適用對象**：台灣團隊後端工程師 + 學校 IT 管理員。

---

## 1. 納管（Enroll）

### 自動鏈路

設備安裝 PPKG 後，以下步驟**全自動**完成（無需手動觸發任何 API）：

| 順序 | 動作 | 說明 |
|------|------|------|
| 1 | MDM Enrollment | PPKG 觸發 discovery → enrollment，設備綁定 tenant |
| 2 | 禁手動註銷 | `AllowManualMDMUnenrollment=0`，設定裡「斷開連線」灰掉 |
| 3 | 隱藏復原頁面 | `PageVisibilityList=hide:recovery`，防學生重設此電腦 |
| 4 | Push 配置 | 信任 cert → 安裝 push MSIX → 配 WNS channel |
| 5 | ADMX 策略框架 | 一次性 ingest 4 個 ADMX（Lock / LAPS / PPKG 移除 / 自卸載） |
| 6 | Agent MSI 派發 | EDA-CSP BITS 下載 + msiexec 安裝 + 配置注入 |
| 7 | LAPS 密碼輪換 | 自動生成隨機密碼 → Agent 改密 |

**前提**：tenant 下已上傳 Agent MSI（`POST /admin/.../apps`）。未上傳則 install-agent 跳過，其餘步驟正常。

### 驗證納管成功

```bash
# 查詢設備列表
curl GET /api/v1/admin/tenants/{tid}/devices \
  -H "Authorization: Bearer $TOKEN"

# 查詢 LAPS 密碼（有結果 = Agent 已裝 + 改密完成）
curl GET /api/v1/admin/tenants/{tid}/devices/{did}/laps-password \
  -H "Authorization: Bearer $TOKEN"
```

設備端驗證：
- 「設定 → 帳戶 → 存取公司或學校資源」可見 MDM 連線
- 「斷開連線」按鈕灰掉
- 「設定 → 系統 → 復原」頁面被隱藏
- `sc query CoGrowMDMAgent` 顯示 RUNNING

---

## 2. 移除納管（Unenroll）

### API

```bash
POST /api/mdm/win/devices/{udid}/unenroll
```

無需 request body。觸發後自動按序下發 10 條命令：

| 順序 | 動作 | 說明 |
|------|------|------|
| 1 | 解鎖手動註銷 | 恢復「斷開連線」按鈕 |
| 2 | 恢復復原頁面 | 取消 PageVisibilityList 隱藏 |
| 3 | 重置管理員密碼 | 改回 `123456`（方便 IT 後續操作） |
| 4 | 移除預配套件 | Agent 執行 `Remove-ProvisioningPackage` |
| 5 | 清 LAPS 策略 | 清除 Registry 密碼殘留 |
| 6 | 清 PPKG 策略 | 清除 Registry 殘留 |
| 7 | 解鎖設備 | Lock 狀態 disabled |
| 8 | Agent 自卸載 | Agent 查 WMI 找 ProductCode → `msiexec /x` 卸載自身 |
| 9 | 卸載 Push MSIX | 移除推送應用 |
| 10 | MDM Unenroll | `DMClient/Unenroll`，設備完全脫離管控 |

設備需在線消化命令（SyncML poll 或 WNS push 觸發）。可先 push 喚醒：

```bash
POST /api/mdm/win/devices/{udid}/push
```

### 移除後的設備狀態

- MDM 連線已清除
- Agent 服務已卸載
- 管理員密碼已重置為 `123456`
- 預配套件已移除
- 設定中所有被隱藏的頁面已恢復

設備回到「乾淨」狀態，可重新套 PPKG 納管。

---

## 3. 其他操作

### 遠端鎖屏

```bash
POST /api/mdm/win/devices/{udid}/command
Body: {"command": "LOCK", "lostModeMessage": "請歸還至 IT 辦公室", "lostModePhone": "02-1234-5678"}
```

### 遠端抹機

```bash
POST /api/mdm/win/devices/{udid}/wipe
Body: {"action": "doWipe"}  # 或 "doWipeProtected" / "doWipePersistProvisionedData"
```

> ⚠️ `doWipe` / `doWipeProtected` 會清掉 PPKG，設備需重新套 PPKG 才能回到 MDM。
> `doWipePersistProvisionedData` 保留預配資料，重設後 OOBE 可能自動重新納管。

### 重啟

```bash
POST /api/mdm/win/devices/{udid}/reboot
```

---

## 4. 多租戶 Enrollment 路由

PPKG 裡的 DiscoveryUrl 兩種形態：

```
教育局通用 PPKG（設備直屬 tenant）：
https://mdm.school.edu/t/{tenant-slug}/EnrollmentServer/Discovery.svc

學校專用 PPKG（設備 enroll 自動歸學校）：
https://mdm.school.edu/t/{tenant-slug}/g/{group-code}/EnrollmentServer/Discovery.svc
```

**自動歸校的觸發機制**：
- `POST /admin/tenants/{tid}/enrollment/ppkg-config` 帶 `deviceGroupId` → 回傳的 XML DiscoveryUrl 嵌入 `/g/{code}` 段
- 設備 enrollment 時後端從 URL 解析 `{group-code}` → 查 `device_group` → 落庫 `mdm_devices.device_group_id`
- 不帶 group / group 解析失敗（被刪 / 改名 / code 不合法）：
  - **首次 enroll** → `device_group_id = null`（直屬 tenant）
  - **重 enroll 已歸組設備** → **保留原 `device_group_id`**（避免通用 PPKG 或失效 group code 把學校歸屬誤清）
  - enroll 不中斷，server log warn 提示

> ⚠️ 重 enroll 通用 PPKG **不會**把已歸校設備拉回直屬 tenant；想清空歸屬必須走「手動調整歸屬」走 PATCH。

**Management 通道不帶 slug / group**：設備 enrollment 後的 SyncML 管理通道（`/api/mdm/win/manage/{deviceId}`）不需要 tenant / group 前綴——設備已綁定到 tenant + group，後端從設備記錄查。

**手動調整歸屬**：
- 設備直屬 tenant → 想分配到學校：`PATCH /tenants/{tid}/devices/{did}` body `{"deviceGroupId": "<學校 UUID>"}`
- 設備換校：同上，傳新的 `deviceGroupId`
- 設備從學校回到直屬 tenant：傳 `{"deviceGroupId": null}`
- 不論手動或自動，都不用重做 PPKG / 重 enroll

**批量命令的租戶隔離**：`provision-lock-policy/bulk` 和 `provision-laps-policy/bulk` 的 `{ all: true }` 模式必須帶 `tenantId`，防止跨租戶操作：

```bash
POST /api/mdm/win/devices/provision-lock-policy/bulk
Body: {"all": true, "tenantId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
```

---

## 5. 已知限制

| 限制 | 說明 |
|------|------|
| 抹機後不會自動回歸 | 需 Windows Autopilot（Intune + Azure AD），自建 MDM 不支援 |
| 管理員可繞過一切 | 標準帳號是防脫離的根，管理員權限可移除所有 MDM 策略 |
| BITS 下載依賴帶寬 | 76MB MSI 通過公網慢，推薦 `appDownloadBaseUrl` 走局域網 |
| Agent 首次 report 延遲 | Agent 按排程上報（每天），非即時。LAPS 不依賴 report，enrollment 時直接下發。 |
