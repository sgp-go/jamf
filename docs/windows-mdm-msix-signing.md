# MSIX 簽名與證書信任

> 部署到 Win10 的 LOB MSIX 必須簽名。dev / 生產有不同流程。

## 為什麼需要簽名

Win10 sideload MSIX 強制要求：
1. MSIX 由有效 cert 簽名（cert 不能過期）
2. cert subject 必須**完全等於** manifest `<Identity Publisher="..."/>`
3. cert 在 device 上被信任（裝在 `LocalMachine\TrustedRoot` 或 `TrustedPeople`）

任一缺失 → device 拒絕 install，事件日誌報 `0x800B0109` 之類證書鏈錯。

## 三類流程對比

| 場景 | 簽名 cert 來源 | Win10 信任 | 客戶感知 |
|---|---|---|---|
| **dev 自簽** | 本地 PowerShell `New-SelfSignedCertificate` | 手動裝到 `LocalMachine\Root` + `LocalMachine\TrustedPeople` | 客戶端必須預配根證書 |
| **生產 Trusted Publisher** | Microsoft Partner Center 申請的 sideload cert | Win10 預信任（**首發即可裝**） | 透明，無需配置 |
| **生產 EV Code Signing** | 商業 CA（DigiCert/Sectigo 等）EV cert | Win10 預信任 | 透明 |

## 1. dev 自簽流程（當前實作）

### 生成 cert + 裝信任

```powershell
$publisher = "CN=Aspira-MDM-Test, O=Aspira, C=TW"

# 創建 code-signing cert
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
    -Subject $publisher `
    -KeyAlgorithm RSA -KeyLength 2048 `
    -NotAfter (Get-Date).AddYears(5) `
    -CertStoreLocation 'Cert:\CurrentUser\My'

# Export PFX（含私鑰，給 signtool）
$pwd = ConvertTo-SecureString -String 'pass1234' -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath 'C:\Temp\msix-cert.pfx' -Password $pwd

# Export CER（公鑰）+ 裝到信任位置
Export-Certificate -Cert $cert -FilePath 'C:\Temp\msix-cert.cer'
Import-Certificate -FilePath 'C:\Temp\msix-cert.cer' -CertStoreLocation 'Cert:\LocalMachine\Root'
Import-Certificate -FilePath 'C:\Temp\msix-cert.cer' -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
```

### 簽 MSIX

```powershell
& signtool.exe sign /fd SHA256 /a /f 'C:\Temp\msix-cert.pfx' /p 'pass1234' 'C:\Temp\AspiraMdmDemo-1.0.msix'
```

### 客戶端 device 預配根證書

每台目標 device 必須裝這個 `.cer` 到 `LocalMachine\Root`。三種分發方式：
- 手動 `certutil -addstore Root msix-cert.cer`
- GPO 推送（域環境）
- enrollment 時透過 .ppkg 嵌入根證書（本案實作 `src/mdm/windows/provisioning.ts` 已嵌 server CA 根證書，**MSIX 簽名 cert 同根時自動信任**）

> ⚠️ 自簽 cert 在客戶感知層 **可見「未知發行者」**（雖然 install 能過）。生產不建議。

## 2. push-capable MSIX 的 Identity 約束（最嚴格）

如果 MSIX 用於接收 WNS push（即 PFN 必須等於 `.env WNS_PFN`）：

### Identity 必須完全匹配 Microsoft Partner Center 註冊值

從 Partner Center → Product Identity 頁拿到完整片段：
```xml
<Identity
  Name="CoGrow.CogrowMDMPush"
  Publisher="CN=27397969-3D59-40F4-A9A2-AEEC09535DB3"
  Version="1.0.0.0"
  ProcessorArchitecture="x64" />
```

`Name` 與 `Publisher` 兩個值都不能改，否則：
1. PFN 計算結果與 `.env WNS_PFN` 不一致
2. WNS 後端拒絕該 channel 註冊

### 自簽 cert 仍可工作（特例）

雖然 Publisher 是 Microsoft GUID（看似只有 Microsoft 能簽），但 **自簽 cert subject 設成同樣的 GUID 字串就能 sideload**。Win10 sideload 機制只校驗 cert subject == manifest Publisher 字串相等 + cert 在信任 store。

完整腳本見 [docs/scripts/build-push-msix-v2.ps1](./scripts/build-push-msix-v2.ps1)。

> 這是 dev / 開發內部 sideload 才行得通。生產正式部署仍需 Microsoft Partner Center 簽發的 Trusted Publisher cert。

## 3. 生產 Trusted Publisher cert（推薦）

### 流程

1. 登入 [Microsoft Partner Center](https://partner.microsoft.com)
2. App overview → 該應用 → Sideloading distribution（如有此入口）
3. 申請 cert（耗時：Microsoft 審核 1-3 工作日）
4. 下載 `.pfx`（含私鑰）+ `.cer`（公鑰）
5. 用該 `.pfx` 簽名 MSIX（同 dev 流程，只是 cert 來源不同）
6. **客戶 Win10 預信任**：cert 鏈頂端是 Microsoft 簽發的根，Win10 已預裝 → 客戶端不需要做任何配置

### 與 EV cert 的差別

| 項 | Trusted Publisher | EV Code Signing |
|---|---|---|
| 簽發方 | Microsoft Partner Center | 商業 CA |
| 成本 | 包含在 Microsoft 開發者帳戶費用內 | $200-700/year |
| 有效期 | 1-3 年 | 1-3 年 |
| 適用範圍 | 該 Microsoft Store app PFN | 任意 Identity |
| Win10 預信任 | ✅ | ✅ |
| 需要 USB token | ❌ | ⚠️ 部分 CA 要 |

對本案：用 Trusted Publisher（Microsoft 已給 PackageSID + ClientSecret + PFN，sideload cert 同源）即可。

## 4. 客戶端信任配置（生產期）

### 場景：客戶 Win10 已加入自建 MDM，要裝自簽 LOB MSIX

**步驟 A：enrollment 時透過 .ppkg 嵌入根證書（已實作）**

`src/mdm/windows/enrollment.ts` 簽發設備 cert 時用 server 的 CA 根。`provisioning.ts` 生成的 `.ppkg` 在 enrollment 流程裡被 device 自動接收，根證書裝到 device 的 `LocalMachine\TrustedRoot`。

只要 MSIX 用同一個 server CA 簽（或子簽），device 自動信任。

**步驟 B：(可選) 推送 LOB cert 到 TrustedPeople**

如果 MSIX 用獨立的 cert 不在 server CA 鏈下：

```bash
# 排個 SyncML 命令推送 cert（CSP：./Vendor/MSFT/RootCATrustedCertificates/UntrustedCertificates）
# 當前實作未包含此功能，需自己加 csp.ts function
```

或客戶端用 GPO / SCCM 推。

### 場景：客戶 Win10 還沒加入 MDM（首次 enrollment）

enrollment 時 device 已自動信任 server CA（透過 ppkg）。只要 LOB MSIX 簽名 cert == server CA 鏈下的 cert，自動 work。

## 5. 證書到期管理

### 監控

cert 到期前 30 天告警：

```powershell
Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.NotAfter -lt (Get-Date).AddDays(30)
} | Select-Object Subject, NotAfter
```

### 換 cert 流程

cert 過期後 device 仍能執行已裝的 MSIX（cert 只在 install 時校驗），但**新版 MSIX 必須用新 cert 簽**。

1. 生成新 cert（同 publisher）
2. 客戶 device 裝新根證書到 TrustedRoot（透過 GPO / MDM 推送 / enrollment 時 ppkg）
3. 用新 cert 簽新版 MSIX
4. 派送 update — device 用新 cert 校驗、装上

> 重要：**publisher 字串不能變**，否則 PFN 計算會變，等於是新應用。

## 6. 常見錯誤

### `0x800B0109` 證書鏈不可信

device 不信任簽名 cert 的根。修：把根 cert 裝到 `LocalMachine\TrustedRoot`。

### `0x800B0100` cert subject 與 manifest publisher 不符

cert 的 `Subject` 與 manifest 的 `<Identity Publisher="..."/>` 字串不完全相同。檢查空格、大小寫、屬性順序（`O=,C=,CN=` 跟 `CN=,O=,C=` 是不同字串）。

### `0x80073CFD` cert 過期

換新 cert。

### `0x800B0114` cert 被吊銷

如果 cert 在 CRL（證書吊銷列表）裡。商業 cert 可能被 CA 吊銷；自簽不會。

## 7. 與當前實作的對照

| 文件 | 用途 |
|---|---|
| `src/mdm/crypto.ts` | server CA 根 + enrollment cert 簽發 |
| `src/mdm/windows/enrollment.ts` | 用 server CA 簽發設備 cert |
| `src/mdm/windows/provisioning.ts` | .ppkg 嵌入 server CA 根證書 |
| `docs/scripts/build-msix.ps1` | 生成自簽 cert + 簽簡單 demo MSIX |
| `docs/scripts/build-push-msix-v2.ps1` | 生成自簽 cert（subject = Microsoft GUID）+ 簽 push-capable MSIX |

當前**自簽 cert 與 server CA 不同**（PowerShell 腳本生成的獨立 cert，需要單獨 import 到 device）。生產建議：把 LOB MSIX cert 和 server enrollment CA 合一，或者透過 `.ppkg` 一併推送 LOB cert。
