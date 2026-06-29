# CoGrow MDM 對接文檔導航

> **受眾**：台灣團隊（規劃 / 對接開發 / 後端運維）→ 再轉交學校 IT 執行設備側。
> **怎麼用這份地圖**：先看「最快上手」建立全局認知，再按你的角色走對應閱讀順序。
> **Source of Truth**：API 字段級真相永遠以互動式文件 `https://<host>/docs`（OpenAPI / Scalar）為準；本目錄文檔補充設計慣例、整合流程與運維手冊。

---

## ⚡ 最快上手（所有人先讀）

1. **[`integration-guide.md`](./integration-guide.md)** — 主對接指南（必讀全文）。讀完掌握：架構三層、統一信封 / 錯誤碼、鑑權（Admin HMAC + Agent token + Webhook 驗簽）、~70 個端點、iOS / Windows 全流程、Webhook 整合、上線 checklist。
2. **OpenAPI 互動式文件 `https://<host>/docs`** — 邊讀指南邊開著查具體請求 / 回應 shape。

> 純對接開發者讀完這兩個（iOS 場景再加下方 A-3）即可開工。運維 / 設備側再按 B、C 展開。

---

## 🧭 按角色閱讀順序

### A. 對接開發者（寫程式調 API + 接 Webhook）

1. [`integration-guide.md`](./integration-guide.md) §4 鑑權 → §8 Webhook（含驗簽程式碼、冪等、重試）
2. §5 端點清單 + OpenAPI `/docs`
3. **iOS 場景必加** → [`ios-deployment/managed-app-config.md`](./ios-deployment/managed-app-config.md)（Managed App Config 5 鍵契約 + token 簽發）
4. Windows 流程已在 §7 覆蓋，調 API 即可

### B. 後端運維 / 基礎設施（部署我方服務）

1. [`backend-deployment.md`](./backend-deployment.md) — Deno 常駐（systemd / docker）+ PostgreSQL + 反向代理 HTTPS + 完整 env 清單
2. 🔴 **[`encryption-key-management.md`](./encryption-key-management.md) — P0，上線前必讀**（`DATA_ENCRYPTION_KEY` 生成 / 存儲 / 備份 / 輪換 / 應急；丟失則 LAPS 密碼 / BitLocker Recovery Key / CA·APNS 私鑰不可恢復）
3. Windows 推送自建：[`windows-deployment/build-machine-setup.md`](./windows-deployment/build-machine-setup.md) → [`push-infrastructure-setup.md`](./windows-deployment/push-infrastructure-setup.md)（細節見 [`wns-account-setup.md`](./windows-deployment/wns-account-setup.md) / [`msix-signing.md`](./windows-deployment/msix-signing.md)；重 build push MSIX 的工具腳本在 [`scripts/`](./scripts/README.md)）

### C. 設備配置 / 協調學校 IT

- **Windows**：[`device-provisioning-guide.md`](./windows-deployment/device-provisioning-guide.md) → [`agent-app-build-and-deploy.md`](./windows-deployment/agent-app-build-and-deploy.md) → [`laps-password-management.md`](./windows-deployment/laps-password-management.md) → [`bitlocker-management.md`](./windows-deployment/bitlocker-management.md) → [`device-lifecycle.md`](./windows-deployment/device-lifecycle.md) → [`agent-upgrade-rollback-strategy.md`](./windows-deployment/agent-upgrade-rollback-strategy.md)
- **iOS**：[`ios-deployment/abm-distribution.md`](./ios-deployment/abm-distribution.md) → [`apns-certificate.md`](./ios-deployment/apns-certificate.md) → [`app-rollout.md`](./ios-deployment/app-rollout.md)；若台灣團隊自行構建簽名，加讀 [`apple-developer-setup.md`](./apple-developer-setup.md) §8（憑據交接 Checklist）

### D. 理解業務流程（對接前建立全局認知）

[`business-flows/`](./business-flows/README.md) — **16 份 Mermaid 序列圖**，每份對應一個功能場景，標示 Server / Device / Agent 之間的完整通訊流程。建議順序：
1. [設備納管](./business-flows/01-device-enrollment.md) → [Webhook 事件](./business-flows/15-webhook-events.md)（理解設備怎麼進來、事件怎麼推出去）
2. [Agent 安裝與上報](./business-flows/04-agent-install-and-reporting.md) → [App 派發](./business-flows/03-app-deployment.md)（理解 App 生命週期）
3. [Profile 推送](./business-flows/06-configuration-profile.md) → [策略推送](./business-flows/07-device-policies.md)（理解兩種配置下發模式的差異）

### E. 排錯（按需查，不必通讀）

[`windows-deployment/troubleshooting.md`](./windows-deployment/troubleshooting.md)、[`trigger-mechanism.md`](./windows-deployment/trigger-mechanism.md)（命令何時秒級 / 何時分鐘級），以及 [`ios-deployment/`](./ios-deployment/README.md) 各文末故障段。

---

## 📁 完整文檔索引

### 頂層

| 文檔 | 主題 | 角色 |
|---|---|---|
| [`integration-guide.md`](./integration-guide.md) | **主對接指南**（端點 / 鑑權 / 流程 / Webhook） | 全部（核心） |
| [`backend-deployment.md`](./backend-deployment.md) | 後端生產部署 + env + 可選雙服務部署 | B |
| [`encryption-key-management.md`](./encryption-key-management.md) | 🔴 加密金鑰 SOP（P0） | B |
| [`apple-developer-setup.md`](./apple-developer-setup.md) | Apple 開發者賬號 / iOS 簽名憑據交接 | C（自行構建簽名方） |

### 子目錄（各有獨立 README 導航）

| 目錄 | 內容 |
|---|---|
| [`business-flows/`](./business-flows/README.md) | **業務流程圖**（16 份 Mermaid 序列圖）：設備納管 / App 派發 / 遠端控制 / 策略推送 / LAPS / BitLocker / 轉校 / 退役 / 黑名單 / Webhook 等全場景 |
| [`ios-deployment/`](./ios-deployment/README.md) | iOS Agent App 對接：Managed App Config 鍵契約、ABM 分發、APNs 憑證、App 更新策略 |
| [`windows-deployment/`](./windows-deployment/README.md) | Windows 正式生產交付（13 份）：基礎設施部署、設備配置運維、LAPS / BitLocker、升級回滾、技術參考 |
| [`scripts/`](./scripts/README.md) | push MSIX 重 build 的 PowerShell 工具腳本（接手 / 換簽署主體時才需要） |
| [`archived/`](./archived/) | ⚠️ 多租戶重構前的探索 / demo 文件，**非交付，可跳過**（部分核心機制仍適用，各文頂部已標時效差異） |

---

## 一句話總結

**`integration-guide.md` + OpenAPI `/docs` 是核心**；對接開發者讀完這兩個加 iOS 的 `managed-app-config.md` 就能開工，運維 / 設備側再按 B、C 順序展開。
