# Windows MDM PRD 需求覆蓋對照表

> 對齊來源：Windows MDM 裝置管理平台 PRD v1.0（2026年5月）
> 用途：對接團隊查閱各 PRD 需求的實作狀態、對應 commit 與對接文檔
> 最後更新：2026-07-07

---

## 圖例

| 狀態 | 意義 |
|------|------|
| ✅ 已完成 | 程式碼實作完成，多數已於真機驗證 |
| 🟡 部分完成 | 有基礎實作，但與 PRD 描述有落差或驗證未齊（見備註） |
| ⚪ 設計上不需要 | PRD 自身註解或架構決策判定無需實作 |
| 🔵 對接方負責 | 超出本後端範圍，由貴團隊在身分/前端層負責（見「整合架構分工」） |
| ❌ 未完成 | 尚未實作 |

## 匯總（共 45 項）

| 狀態 | 數量 | 佔比 |
|------|------|------|
| ✅ 已完成 | 38 | 84% |
| 🟡 部分完成 | 3 | 7% |
| ⚪ 設計上不需要 | 1 | 2% |
| 🔵 對接方負責 | 2 | 4% |
| ❌ 未完成 | 1 | 2% |

- Phase 1a / 1b / 2 幾乎全數落地；Phase 3 的 Kiosk Mode、遠端密碼重設兩項已超前實作並真機驗證。
- 唯一未實作：App 金流採購（#43，PRD 本身列低優先、需商務洽談）。
- SSO 登入（#19）、唯讀角色（#44）由貴團隊在身分系統層負責，本後端只提供 scoping 原語。

---

## Phase 1a — 核心納管與基本管理

| # | 功能項目 | 狀態 | 關鍵 commit | 對接文檔 |
|---|----------|------|-------------|----------|
| 1 | 設備納管（防止學生解除） | ✅ | `590c000` `66d6c14` `e827c3e` | `business-flows/01-device-enrollment.md` |
| 2 | 預先配置（Prestage Enrollment） | ✅ | `66d6c14` `99b0e78` | `business-flows/02-ppkg-zero-touch.md` |
| 3 | 群組指派 | ✅ | `66d6c14` `590c000` | `business-flows/01-device-enrollment.md` |
| 4 | 零接觸部署（Zero-touch） | 🟡 | `66d6c14` `99b0e78` | `business-flows/02-ppkg-zero-touch.md`（見下方 Autopilot 專節） |
| 5 | 設備清單（Device Inventory） | ✅ | `9f06061` `59806ce` | `integration-guide.md §5.4`（GET /devices 查詢/篩選）；上報流見 `business-flows/04-agent-install-and-reporting.md` |
| 6 | 設定描述檔（Configuration Profile） | ✅ | — | `business-flows/06-configuration-profile.md` |
| 7 | 遠端鎖定 | ✅ | — | `business-flows/05-remote-lock-wipe-reboot.md` |
| 8 | 遠端清除（恢復原廠） | ✅ | `203176a` `0ed992c` `bdb964b` | `business-flows/05-remote-lock-wipe-reboot.md`、`16-device-retire.md` |
| 9 | 遠端重新開機 | ✅ | — | `business-flows/05-remote-lock-wipe-reboot.md` |
| 10 | 排程任務（定時啟動 App） | ⚪ | — | **PRD 自身註解**：Windows agent 為背景常駐 Service，不會被殺，無需排程喚醒 |
| 11 | Agent App 自動派發 | ✅ | `845da85` `47347fe` | `business-flows/04-agent-install-and-reporting.md`、`windows-deployment/agent-app-build-and-deploy.md` |
| 12 | 自訂 App 上傳（.exe/.msi） | ✅ | `19da30e` | `business-flows/03-app-deployment.md` |
| 13 | 遠端派發安裝 | ✅ | `19da30e` `47347fe` | `business-flows/03-app-deployment.md` |
| 14 | 遠端移除 App | ✅ | `4c6da3a` `19da30e` | `business-flows/03-app-deployment.md` |
| 15 | 遠端更新 App | ✅ | `cafad5c` | `business-flows/03-app-deployment.md`、`windows-deployment/agent-upgrade-rollback-strategy.md` |
| 16 | 防止學生刪除 App | ✅ | `e827c3e` | `business-flows/04-agent-install-and-reporting.md §4 防止卸載`（ARPSYSTEMCOMPONENT + 防脫離納管 + MDM 移除授權；非 AppLocker） |
| 17 | App 白名單／黑名單 | ✅ | `b934738` | `business-flows/12-app-blocklist.md` |
| 18 | 教育局 Admin / 學校管理員權限 | ✅ | `590c000` `66d6c14` | `integration-guide.md`、`business-flows/10-device-transfer.md`（本後端提供層級 + scoping 原語，登入/RBAC 由貴團隊落地） |
| 19 | SSO 登入（@gm.edu.tw / OIDC） | 🔵 | — | 由貴團隊負責，見「整合架構分工」 |

---

## Phase 1b — 管理完整化

| # | 功能項目 | 狀態 | 關鍵 commit | 對接文檔 |
|---|----------|------|-------------|----------|
| 20 | 網站黑名單 | ✅ | `afd5b0a` `75555f6` | `business-flows/11-website-blocklist.md` |
| 21 | 惡意軟體限制（Windows Defender） | ✅ | `afd5b0a` | `business-flows/13-defender-enforce.md` |
| 22 | 序號管理 | ✅ | `9f06061` | `integration-guide.md §5.4`（設備詳情）+ `business-flows/04-agent-install-and-reporting.md`（上報快照） |
| 23 | OS 版本 / 硬體資訊 | ✅ | `9f06061` | `business-flows/04-agent-install-and-reporting.md`（reports 快照：OS/版本/電量/儲存/網路） |
| 24 | App 安裝清單 | ✅ | `9a1cf81` | `business-flows/21-installed-apps-inventory.md` |
| 25 | 設備轉校 | 🟡 | `6548d51` | `business-flows/10-device-transfer.md`（實作為「標記新組 + 派 Wipe」，非無縫遷移，見下方落差說明） |

---

## Phase 2 — 進階管理功能

| # | 功能項目 | 狀態 | 關鍵 commit | 對接文檔 |
|---|----------|------|-------------|----------|
| 26 | 自動設備命名 | ✅ | `32f0d6d` `b934738` | `business-flows/07-device-policies.md` |
| 27 | 遠端初始化 / 重新部署 | ✅ | `8ab7c32` | `business-flows/16-device-retire.md §遠端重新部署（/redeploy）`（含 redeploy/transfer/retire 三者對比） |
| 28 | WiFi / VPN 設定下發 | ✅ | `b934738` | `business-flows/06-configuration-profile.md`、`07-device-policies.md`（WiFi 已實作；VPN 程式碼完成，真機驗證程度待確認） |
| 29 | 桌布與登入畫面設定 | ✅ | `b934738` | `business-flows/07-device-policies.md` |
| 30 | 設備功能限制 | ✅ | `b934738` | `business-flows/07-device-policies.md` |
| 31 | 遺失模式（Lost Mode） | ✅ | `a46498f` `9a856b4` `e7ef4ad` | `business-flows/20-lost-mode.md`、`19-agent-gps-reporting.md` |
| 32 | App 分類管理 | ✅ | `4d0f64c` | `business-flows/17-inventory-and-app-metadata.md` |
| 33 | 授權數量管理 | ✅ | `4d0f64c` | `business-flows/17-inventory-and-app-metadata.md` |
| 34 | WinGet App 目錄 | ✅ | `6bda6f0` `3cbeb4b` `c3c26fe` | `windows-deployment/winget-app-dispatch.md` |
| 35 | USB / Camera 禁用 | ✅ | `d9cf907` `b934738` | `business-flows/07-device-policies.md` |
| 36 | 密碼政策 | ✅ | — | `business-flows/06-configuration-profile.md` |
| 37 | 防火牆管理 | ✅ | `8ba7ce9` `74a2130` | `business-flows/07-device-policies.md` |
| 38 | 合規政策（OS版本 / 離線偵測） | ✅ | `2ea53a3` | `business-flows/18-compliance-batch-history.md` |
| 39 | OS 更新管理 | ✅ | `afd5b0a` | `business-flows/14-os-update.md` |
| 40 | 購買資訊 / 地理位置 Inventory | ✅ | `4d0f64c` `9a856b4` | `business-flows/17-inventory-and-app-metadata.md`、`19-agent-gps-reporting.md` |

---

## Phase 3 — Future Roadmap（PRD 列為未來規劃）

| # | 功能項目 | 狀態 | 關鍵 commit | 對接文檔 |
|---|----------|------|-------------|----------|
| 41 | Kiosk Mode（單一 App 模式） | ✅ 超前 | `27967e6` `67c3894` | `windows-deployment/kiosk-mode-integration-guide.md` |
| 42 | 遠端密碼重設 | ✅ 超前 | `809bc29` | `business-flows/08-laps-password.md §學生 / 指定帳號密碼重設`、`windows-deployment/laps-password-management.md §6` |
| 43 | App 金流採購機制 | ❌ | — | 未實作。PRD 標註需與 App 廠商洽談商務、開發成本高 |
| 44 | 唯讀角色 | 🔵 | — | 由貴團隊負責，見「整合架構分工」 |
| 45 | Geofence 地理圍欄 | 🟡 | `e6015c6` | `business-flows/22-geofence.md` + `integration-guide.md §5.14`（後端 polygon CRUD + GPS point-in-polygon + webhook 已實作；真機離開圍欄自動聯動待確認） |

---

## 整合架構分工（本後端 vs 貴團隊）

本後端定位為 **Windows MDM 引擎 API**。使用者資料、認證、SSO、角色權限（RBAC）由貴團隊的後端負責。分工如下：

| 職責 | 本後端（MDM 引擎） | 貴團隊後端 |
|------|-------------------|-----------|
| 使用者帳號 / 認證 / SSO（OIDC @edu.tw） | ✗ | ✓ |
| 角色 / 權限 enforcement（含唯讀角色） | ✗ | ✓ |
| 多租戶層級資料模型（tenant=教育局 / device_group=學校） | ✓ 提供 | 使用 |
| 學校維度作用域（`/tenants/{tid}/...`、設備列表 `?deviceGroupId=` 過濾） | ✓ 提供 | 呼叫時帶對 |
| MDM 指令 / App 派發 / Inventory / 合規 | ✓ | — |

### 對接契約（重要，請務必落實）

1. **`ADMIN_API_TOKEN` 是單一、全租戶滿權限的 service token** — 前提假設只有貴團隊後端持有，**絕不可下放到終端瀏覽器或客戶端**。可選帶 `X-CoGrow-Timestamp` + `X-CoGrow-Signature`（HMAC）防重放。
2. **本 API 不自我強制學校隔離，完全信任呼叫方** — 「學校管理員僅見本校」100% 由貴團隊負責：每次呼叫須帶正確的 `tenantId` + `deviceGroupId`。作用域漏帶會造成跨校資料外洩。
3. **教育局專屬操作**（如設備轉校 #25）本 API 不區分呼叫者角色，須由貴團隊 gate 住「僅教育局 Admin 可呼叫」。
4. 詳細端點與鑑權見 `integration-guide.md` 及 `/api/doc`（Scalar OpenAPI）。

---

## 與 PRD 描述有落差、建議雙方確認的項目

| 項目 | PRD 描述 | 實際實作 | 建議 |
|------|----------|----------|------|
| 零接觸部署（#4） | 序號 CSV 匯入 → 開機純零接觸 | PPKG 需應用一次描述包 | 見下方 Autopilot 專節。建議確認可接受 PPKG 方案 |
| 設備轉校（#25） | 轉校後無需重新納管 | 標記新組 + 派 Wipe（清資料重納管） | 確認是否需要「保留資料」的無縫轉校 |
| 排程任務（#10） | 定時啟動 App | 判定不需要（agent 常駐後台） | 依 PRD 自身註解確認共識 |

### 零接觸部署（#4）的取捨與 Windows Autopilot 費用

PRD 描述的「序號 CSV 匯入 → 開機純零接觸」對應的是 **Windows Autopilot**。本平台**刻意不採用**，原因是成本與架構雙重衝突：

**1. Autopilot 需要付費訂閱（不是免費技術）**

Windows Autopilot 本身沒有獨立售價的 SKU——它是內建於 Windows + 管理平面的部署技術，但要啟用它，必須同時具備：

- **Microsoft Entra ID P1/P2**（Autopilot 強制設備 Entra 加入）
- **一個受 Entra 認可的 MDM 訂閱**（Intune，或 Entra 已整合的第三方 MDM）

換算到 8,000 台教育設備的**經常性年費**（列表價，教育/政府量購另議）：

| 授權方式 | 單價（列表價） | 8,000 台年費估算 |
|----------|----------------|-------------------|
| Intune for Education（教育、按設備） | 約 US$30–42／台／年（經銷 ~US$2.5–3.5／台／月） | 約 US$24 萬–34 萬／年（≈ NT$770 萬–1,070 萬／年） |
| Intune Plan 1（標準、按使用者） | US$8／使用者／月（≈ US$96／年） | 視使用者數更高 |
| 另加 Microsoft Entra ID P1 | 約 US$6／使用者／月 | Autopilot 前置，教育 A 版可能已含 |

> 匯率以 ~31.5 TWD/USD 概估；台灣教育部與微軟通常有校園授權協議，實際單價需向微軟/授權經銷取報價。重點在於**這是每年重複支出的訂閱**，非一次性。

**2. 與本專案目標直接衝突**

PRD §1.1 明載目標是「將原本由 **Microsoft Intune** 管理的 Windows 設備，**無痛遷移至本平台**」。而 Autopilot 恰恰把設備重新綁回 Intune/Entra 付費訂閱——採用它等於回到專案要擺脫的成本。

**3. 架構耦合**

Autopilot 強制 Entra ID 加入 + 每台設備硬體 hash 註冊到微軟雲。本平台走 PPKG + workgroup/本機帳號（自建 OMA-DM），非 Entra 加入。改用 Autopilot 需重新耦合微軟雲身分，違背自建自主的方向。

**結論**：以 PPKG 達成「貼一次描述包 → 開機全自動納管+歸組+裝 App」，用零經常性授權費換取「開機前需應用一次 PPKG」的一次性動作。若廠商在出貨前預先套用 PPKG，對學校端即等同零接觸。詳見 `business-flows/02-ppkg-zero-touch.md`。

---

## 參考文檔索引

- **對接主文檔**：`docs/integration-guide.md`（API 端點、鑑權、資料模型）
- **API 線上文檔**：`/api/doc`（Scalar OpenAPI）
- **業務流程**（逐功能）：`docs/business-flows/`（01–22 篇 + README）
- **Windows 生產交付**：`docs/windows-deployment/`（後端部署、構建機、Agent build/upgrade、push 自建、Kiosk、LAPS、BitLocker、winget、故障排除等）
- **iOS 交付**：`docs/ios-deployment/`
