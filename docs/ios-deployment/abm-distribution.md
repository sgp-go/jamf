# iOS Agent App ABM Custom App 分發

> iOS 生態無「真正不上架 + 批量派發」路徑。對 8000 台教育設備，唯一可行 =
> **ABM/ASM Custom App**（私有通路）+ MDM `InstallApplication` 派發。Ad Hoc（每年 100 UDID
> 上限）僅夠 1-2 台測試，**生產不可行**。

## 1. 為什麼是 Custom App

| 方式 | 學生可搜到 | 8000 台 | 結論 |
|---|---|---|---|
| App Store 公開上架 | 是 | ✅ | 排除（不要公開）|
| **ABM Custom App（私有）** | **否** | ✅ 無 UDID 限制 | ⭐ 採用 |
| Ad Hoc | 否 | ❌ 100/年 | 僅測試 |
| Enterprise (ADEP) | 否 | ✅ | 2024 後幾乎拿不到 + 給學生用違反協議 |

「不上架」在學生視角的等價實現 = Custom App：搜不到、不需 Apple ID、MDM 直接裝上。等同 Windows 的「私有 .msi」。

## 2. 角色分工

| 環節 | 負責方 | 說明 |
|---|---|---|
| App binary 建置 + 提交 Custom App 審核 | **我方** | Aspira ABM 即可，無需 ASM |
| Authorized Organizations 維護 | **我方** | 把各縣市 ASM Org ID 加入授權列表（**無 API，手動**）|
| 客戶 ABM/ASM 帳號 + Organization ID | **客戶（甲方）** | 8000 台 DEP 註冊前提；客戶須先有 ABM 或 ASM |
| 客戶端購買授權 + 指派 MDM Server | **客戶** | ASM → Apps and Books |
| MDM `InstallApplication` + App Configuration 派發 | **台灣後端（經 Jamf）** | 注入配置鍵 |

> 🔴 **關鍵外部依賴**：客戶必須先有 ABM 或 ASM（教育版免費，申請週期 1-2 週）。對接會議須先確認。

## 3. 一次性流程（我方做一次）

```
1. Fastlane：export_method 從 ad-hoc → app-store（Custom App 用 appstore 證書，非 adhoc）
2. App Store Connect → Distribution Method → "Custom App for Business and Education"
3. 填 metadata（描述、截圖、隱私政策）→ 提交審核（1-3 天，比公開 App 寬鬆）
4. 審核通過 → Pricing and Availability 出現 "Authorized Organizations" 區塊
```

## 4. 每新增一個客戶 ASM（約 5 分鐘）

```
客戶端：school.apple.com / business.apple.com → 頭像 → Preferences →
        Enrollment Information → 複製 Organization ID（數字串）→ 給我方
我方：  App Store Connect → AgentApp → Pricing and Availability →
        Authorized Organizations → Add Organization → 貼 Org ID → Save
        （不需重新審核，數小時內生效）
客戶端：ASM → Apps and Books → 搜 AgentApp → Buy Licenses（填數量）→ 指派給 MDM Server
```

**一個 binary 派 N 個 organization**，不需為每個 ASM 重 build / 重審。台灣 22 縣市 + 部分學校
自有 ASM ≈ 30-50 個 organization，在合理範圍。

## 5. MDM 派發命令（含配置注入）

```xml
<dict>
  <key>RequestType</key><string>InstallApplication</string>
  <key>iTunesStoreID</key><integer>1234567890</integer>
  <key>InstallAsManaged</key><true/>
  <key>ManagedConfiguration</key>
  <dict>
    <key>serverURL</key><string>https://api.cogrow.com</string>
    <key>tenantId</key><string>6f9c2b8a-...</string>
    <key>serialNumber</key><string>$SERIALNUMBER</string>
    <key>agentToken</key><string>__PER_DEVICE_TOKEN__</string>
    <key>deviceId</key><string>$UDID</string>
  </dict>
</dict>
```

> ⚠️ 鍵用 **camelCase**（`serverURL` / `tenantId` / `serialNumber` / `agentToken` / `deviceId`），
> 對齊 App 端實作。完整契約與 `agentToken` 每台注入方式見
> [managed-app-config.md](./managed-app-config.md)。

## 6. 多租戶配置

同一 App binary，各 ASM 派發時注入**不同** `tenantId`（`serverURL` 通常相同）。多租戶隔離靠
`tenantId` 進 API 路徑自動達成（`/api/v1/tenants/{tenantId}/agent/...`）。

## 7. 維護與解約

- **App 升級上傳 / 提交審核**：✅ Fastlane CI 自動化。
- **Authorized Organizations 維護**：❌ 無 Apple API，必須手動。建議內部表單收 Org ID + 每週批次更新 +
  DB 加表追蹤客戶 organization 狀態。
- **客戶解約清理**：① 透過該 MDM 下 `RemoveApplication` 清設備上的 App；② 從 Authorized Organizations
  移除 Org ID。僅做 ② → 既有設備 App 仍可用，直到 OS / App 升級無法更新。

## 8. 行動清單（對接前確認）

| 動作 | 優先度 | 阻塞 |
|---|---|---|
| 確認客戶是否已有 ABM / ASM | 🔴 高 | iOS 派發整體 |
| 客戶若無：請其申請 ASM（教育免費，1-2 週）| 🔴 高 | 上線時程 |
| 取得客戶 Organization ID | 🔴 高 | Custom App 授權 |
| 我方提交 AgentApp 為 Custom App + 改 Fastfile export_method | 🟡 中 | — |

## 參考

- Apple Business Manager：https://support.apple.com/guide/apple-business-manager
- Custom Apps 政策：https://developer.apple.com/custom-apps/
- ASM 申請（教育機構）：https://school.apple.com
