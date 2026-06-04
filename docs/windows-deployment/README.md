# Windows 部署交付文件（正式生產）

> ⚠️ 本目錄為**正式生產交付**文件，區別於 `docs/` 下的 demo / 探索 / 調試文件。
> 規則由我方制定，供台灣團隊轉交學校 IT 執行。

## 文件清單

| 文件 | 說明 |
|---|---|
| [device-provisioning-guide.md](device-provisioning-guide.md) | Windows 電腦初始化配置完整指南：PPKG 生成 → OOBE 套用 → 驗證納管 → 批量方案 → 防脫離配套 → **帳戶與密碼策略** → 故障排除 → 已知限制 |

## 適用對象

台灣團隊（規劃 / 對接）→ 學校 IT 團隊（執行）。

## 環境前提（一次性）

- MDM 後端 + 公網 HTTPS（有效 CA，Windows 拒絕自簽 TLS）
- 一台裝 Windows ADK 的工具機（把 `customizations.xml` build 成 `.ppkg`）
- push 推送整套**自建**（自己的 Microsoft Store 註冊 → WNS 憑據 → push MSIX → cert，全域一套；見指南 §10）

## 核心原則速記

1. **學生用標準帳號**——防脫離的根；管理員權限可繞過一切 MDM 策略
2. **PPKG 永遠統一**（一個檔刷所有機器）；密碼每台差異化交給「納管後 MDM 動態注入」
3. **存量已激活設備**先「重置」回 OOBE 再套 PPKG（PPKG 刪不掉已有管理員）
4. 無 Autopilot，批量配置須人工插 USB 或刷映像（非零接觸）
