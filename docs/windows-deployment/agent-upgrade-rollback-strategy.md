# Agent 升級與回滾策略

> **適用對象**：台灣團隊後端工程師。
> **前提**：設備已納管且初始 Agent App 已安裝。

---

## 1. 概述

Agent 升級透過 MDM 重新觸發 `install-agent` 流程完成。WiX MajorUpgrade 配置確保自動卸舊裝新，服務自動重啟。

**核心原則**：壞 build 上量 = 災難。Agent 是唯一的本地執行體（LAPS 改密、BitLocker 加密、鎖屏、使用時長），一旦全量推送有缺陷的版本，需逐台人工介入修復。

---

## 2. 升級流程

### 2.1 構建新版 MSI

```powershell
# 在構建機上
pwsh -File build.ps1 -Version 1.4.1.0
```

> 版本號規則：`{major}.{minor}.{patch}.{build}`。MSI MajorUpgrade 比較前三段（1.4.1），build 段不影響升級判斷。

### 2.2 上傳新版

```bash
curl -X POST /api/v1/admin/tenants/{tenantId}/apps \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@CoGrowMDMAgent-1.4.1.0.msi" \
  -F "platform=windows" \
  -F "kind=msi" \
  -F "version=1.4.1.0" \
  -F "bundleId={176848CB-7917-4829-B158-F18F7585B7DA}" \
  -F "displayName=CoGrow MDM Agent"
```

> `bundleId` 必須與 WiX `Product.wxs` 的 `UpgradeCode` GUID 一致（不是 ProductCode）。ProductCode 每版自動生成。

### 2.3 觸發設備升級

```bash
curl -X POST /api/v1/admin/tenants/{tenantId}/devices/{deviceId}/install-agent \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"appId": "{新版 appId}"}'
```

install-agent 會：
1. 生成新 Agent Token
2. 透過 EDA-CSP 下發新版 MSI（Add + Exec）
3. Windows 的 MajorUpgrade 自動卸載舊版、安裝新版
4. 服務自動重啟（WiX `ServiceControl` 配置的 Stop/Start 優雅處理）

---

## 3. 灰度策略

### 3.1 分階段推送

| 階段 | 範圍 | 觀察期 | 通過條件 |
|------|------|--------|----------|
| 1. 金絲雀 | 1-2 台測試設備 | 24 小時 | 服務啟動正常 + 上報恢復 + LAPS/BitLocker 運作 |
| 2. 小批量 | 5-10% 設備 | 48 小時 | 無異常重啟 + 功能指標正常 |
| 3. 全量 | 剩餘設備 | — | 二階段指標穩定 |

### 3.2 操作方式

目前灰度透過**手動指定設備 ID** 觸發 install-agent：

```bash
# 階段 1：金絲雀
curl -X POST .../devices/{canary-device-id}/install-agent ...

# 確認正常後，階段 2：小批量
for id in $BATCH_DEVICE_IDS; do
  curl -X POST .../devices/$id/install-agent ...
done

# 階段 3：全量
# 對所有剩餘設備觸發
```

> 後續可開發 Admin API 的批量升級端點（帶百分比 / 設備群組參數），替代手動循環。

### 3.3 健康驗證指標

升級後觀察以下指標確認健康：

| 指標 | 正常值 | 異常信號 |
|------|--------|----------|
| Agent 服務狀態 | `Running` | `Stopped` / 反覆 restart |
| Agent report 上報 | 按排程正常到達 | 上報中斷 |
| Agent 版本號 | 與推送的新版一致 | 仍是舊版（安裝失敗） |
| LAPS rotation 確認 | `status=confirmed` | 長時間 `pending` |
| BitLocker 狀態 | 加密進行中 / 已完成 | 未啟動 |
| Event Log | 無 Error 級事件 | 有異常堆疊 / crash |

```bash
# 查詢設備 Agent 版本
curl GET .../devices/{deviceId}/reports/latest \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 看回應中 appVersion 欄位
```

---

## 4. 回滾

### 4.1 回滾觸發條件

- Agent 服務啟動後 crash 循環（Event Log 出現連續 Error + FailureActions restart）
- 上報中斷超過 2 個排程週期
- 關鍵功能失效（LAPS 改密失敗、鎖屏失效）

### 4.2 回滾操作

重新觸發 install-agent，指定舊版 MSI 的 `appId`：

```bash
# 找到上一個穩定版本的 appId
curl GET .../admin/tenants/{tenantId}/apps?platform=windows&kind=msi \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 回滾到舊版
curl -X POST .../devices/{deviceId}/install-agent \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"appId": "{舊版-appId}"}'
```

WiX MajorUpgrade **支持降級**（`AllowDowngrades="yes"` 或 ProductCode 不同），新版 MSI 安裝時會卸載當前版本。

### 4.3 批量回滾

如果需要對整批設備回滾：

```bash
# 取得所有已升級到問題版本的設備
# 從最近的 reports 篩選 appVersion = 問題版本號
# 逐一觸發 install-agent 指向舊版
```

---

## 5. 注意事項

### 5.1 Agent 自我保護與升級的關係

Agent 的自我保護機制（FailureActions restart）**不會阻擋合法 MSI 升級**：

- WiX `ServiceControl` 先 Stop 服務 → 安裝/替換文件 → Start 服務
- 這是正常的服務停止（非 crash），FailureActions 不觸發
- **但** `Stop-Process -Force` 會被判為 crash → 觸發 restart → 文件被鎖

> ⚠️ 絕對不要用 `Stop-Process` 手動停 Agent 再替換文件。只走 MSI 升級路徑。

### 5.2 配置保留

WiX 配置使用 `RegistrySearch` 回填機制：升級時自動從 `HKLM\SOFTWARE\Policies\CoGrowMDM\Agent` 讀回現有的 DEVICE_ID / AGENT_TOKEN / API_ENDPOINT / TENANT_ID，不會丟失設備綁定。

### 5.3 版本號一致性

Agent 的 `AssemblyInformationalVersion` 必須與 MSI `ProductVersion` 一致（build.ps1 的 `-p:Version` 參數確保）。不一致會導致後端健康驗證的版本比對失敗。
