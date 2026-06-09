# iOS Agent App 更新與灰度策略

> Windows Agent 走 EDA-CSP 灰度推 MSI + `agent-rollout` 健康驗證（我方完全掌控分批與回滾）。
> iOS 受 Apple 生態約束，**更新通道不同、可控性弱**，本文說明差異與可行的灰度做法。

## 1. iOS 更新通道

iOS Agent App 是 Custom App，更新走 **App Store Connect 上傳新版 → ABM/MDM 重新派發**：

```
Fastlane CI build 新版 → 上傳 App Store Connect →（Custom App 免重審或快速審）
  → 各 ASM 後台版本更新 → MDM InstallApplication 推新版到設備
```

關鍵約束（對比 Windows）：
- ❌ **無 EDA-CSP 式我方自控分批**：版本一旦在 ASM 可用，MDM 何時推由 MDM（Jamf）排程決定。
- ❌ **無 `agent-rollout` 健康桶**：iOS 沒有 install-agent / MSI 版本回報鏈，後端的 rollout health
  端點是 Windows 設備視角。
- ✅ **可控點在 MDM scope**：用 Jamf 的 Smart Group + App scope 分批推送（先推測試群組，再擴大）。

## 2. iOS 灰度的可行做法

既然我方後端無法像 Windows 那樣分批，iOS 灰度落在 **Jamf scope** 與 **後端健康觀測**：

1. **Jamf Smart Group 分批**：建「灰度測試群組」（先 2-3 校），App 更新先 scope 到該群組，
   觀察數日無異常再擴大 scope 到全部。
2. **後端健康觀測（複用上報數據）**：
   - 查 `GET /tenants/{tid}/agent/devices/{serial}/reports/latest` 的 `appVersion` 確認升級到位。
   - 監控 `agent.reported` webhook 的 `app_version` 分佈與上報設備數，若新版上線後上報設備驟降 →
     新版可能崩潰，暫停擴大 scope。
3. **回滾**：iOS 無「降版」概念（App Store 不允許裝舊版）。回滾 = **儘快上傳修復版**並推送，
   故新版上線務必先小範圍灰度。

## 3. 健康驗證指標（iOS 版）

| 指標 | 來源 | 健康判據 |
|---|---|---|
| 升級到位率 | 各設備 latest report 的 `appVersion` | 接近 scope 設備數 |
| 上報存活率 | `agent.reported` webhook 設備數 / 應上報數 | 新版上線後不應驟降 |
| 異常事件 | `agent.usage_anomaly` webhook | 不應因新版批量出現 |

> 沒有 Windows 的 `silent`（曾上報後失聯）自動分類；iOS 靠上報設備數趨勢人工研判。

## 4. 與 Windows 對照

| 維度 | iOS | Windows |
|---|---|---|
| 更新通道 | ABM Custom App 重新派發 | EDA-CSP 推 MSI |
| 分批控制 | Jamf scope / Smart Group | 後端 `agent-rollout`（deviceIds/count/percentage）|
| 健康驗證 | 上報數據人工研判 | `agent-rollout/health` 四桶自動分類 |
| 回滾 | 只能上修復版前推（無降版）| roll-forward（發更高版本號的回退包）|
| 可控性 | 弱（受 Apple + MDM 排程約束）| 強（我方全鏈掌控）|

## 5. 建議

- iOS 新版**務必先 Jamf 小範圍 scope 灰度**（無自動回滾兜底，崩潰只能靠快速修復版）。
- CI 建置 + 上傳自動化（Fastlane），但 scope 擴大保留人工 gate。
- 後端應對 `app_version` 分佈與上報存活率做基本監控告警（這部分目前缺，屬 backlog）。
