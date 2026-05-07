# data/test/ — Demo MSIX 產物 + Publisher Cert（接手即用）

> 這個目錄是給接手團隊**直接驗證自建 MDM 流程**準備的：拿 git clone 下來就能跑 install / update / push 派送，**不需要**自己裝 Win SDK 重 build。
>
> 想改源碼或改 manifest 重 build 才需要 SDK，流程在 [`docs/scripts/README.md`](../../docs/scripts/README.md)。

## 文件清單

| 檔案 | 用途 | 對應的驗證場景 |
|---|---|---|
| `AspiraMdmDemo-1.0.msix` | demo install v1 | `POST /api/mdm/win/devices/:udid/apps/install` |
| `AspiraMdmDemo-2.0.msix` | demo update v2（同 PFN，version 2.0.0.0） | `POST /api/mdm/win/devices/:udid/apps/update` |
| `CogrowMDMPush-2.0.msix` | push-capable v2（含 IBackgroundTask DLL） | `POST /api/mdm/win/devices/:udid/push-config` |
| `AspiraCert.cer` | Aspira-MDM-Test 自簽 publisher cert（公鑰） | sideload `AspiraMdmDemo-*` 前必須裝 |
| `CogrowMDMPushCert.cer` | CoGrow MDM Push publisher cert（自簽 GUID 形式） | sideload `CogrowMDMPush-2.0.msix` 前必須裝 |

> ⚠️ **架構限制**：以上 `.msix` 都是 **x64**。如果裝到 **ARM64 Win11**（如 UTM/Parallels VM 跑 ARM 版 Windows），OS 會回 `0x80070005` 拒絕 sideload —— MSIX 容器層強制架構匹配，不能依賴 x64 emulation 跨架構。
>
> ARM 環境需自行重 build ARM64 版（`docs/scripts/build-msix.ps1` 把 manifest `ProcessorArchitecture="x64"` 改成 `arm64`，csc 加 `/platform:arm64`，重簽）。

## Cert 詳情

### AspiraCert.cer（demo install/update 用）
- Subject / Issuer：`C=TW, O=Aspira, CN=Aspira-MDM-Test`
- 有效期：**2026-05-07 ~ 2031-05-07**（5 年）
- SHA-1 Fingerprint：`A2:0F:F8:14:91:60:08:ED:65:D2:FA:82:78:5B:CD:0B:47:75:CF:B8`

### CogrowMDMPushCert.cer（push 用）
- Subject / Issuer：`CN=27397969-3D59-40F4-A9A2-AEEC09535DB3`（GUID 形式，因為 MS Partner Center 註冊時 publisher 必須等於這個 GUID）
- 有效期：5 年（具體日期看 `openssl x509 -inform DER -in CogrowMDMPushCert.cer -noout -enddate`）

> ⚠️ Cert 過期會讓**新 build 的 MSIX 簽不上**，但**已簽好的 .msix 仍永久有效**（OS 驗簽查的是簽署當下的有效期）。也就是說：cert 5 年後過期，這 3 個 .msix 還是能裝。

## 客戶端使用流程

### 1. 裝 cert 到 Trusted Root + Trusted People（必須）

```powershell
# 裝 demo install/update 用的 cert
Import-Certificate -FilePath AspiraCert.cer -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath AspiraCert.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople

# 裝 push 用的 cert
Import-Certificate -FilePath CogrowMDMPushCert.cer -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath CogrowMDMPushCert.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
```

不裝會回 `HRESULT 0x800B0109 CERT_E_UNTRUSTEDROOT`。

### 2. 開 Sideload + Developer Mode（Win11 必須）

```powershell
$path = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
New-ItemProperty -Path $path -Name AllowDevelopmentWithoutDevLicense -Value 1 -PropertyType DWORD -Force | Out-Null
New-ItemProperty -Path $path -Name AllowAllTrustedApps -Value 1 -PropertyType DWORD -Force | Out-Null
```

不開會回 `HRESULT 0x80070005 拒絕存取`。

### 3. 透過 MDM 派送 install

```bash
curl -X POST https://<mdm-server>/api/mdm/win/devices/<udid>/apps/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageFamilyName": "AspiraMDM.Demo_cmnaf4m6btwng",
    "contentUri": "https://<mdm-server>/test/AspiraMdmDemo-1.0.msix"
  }'
```

PFN（`AspiraMDM.Demo_cmnaf4m6btwng`）由 Identity Name + Publisher 算出，**不能改**——改了就不對應這份 MSIX 了。算法：`docs/scripts/get-pfn.ps1`。

### 4. install 後在裝置內驗證

```powershell
Get-AppxPackage -Name AspiraMDM.Demo
# 應顯示 PackageFullName: AspiraMDM.Demo_1.0.0.0_x64__cmnaf4m6btwng
```

## 重 build 場景與步驟

需要重 build 的時機：
1. **改源碼**（`hello.cs` 添功能）
2. **改 manifest**（加 capability、改 ProcessorArchitecture）
3. **換 cert**（公司更換簽署主體）
4. **ARM64 環境**（現有產物是 x64，ARM 必須重 build）

重 build 步驟：

```powershell
# 在 Win 機器上（裝完 Win SDK 後）：
docs\scripts\build-msix.ps1        # 產 AspiraMdmDemo-1.0.msix
docs\scripts\build-msix-v2.ps1     # 產 AspiraMdmDemo-2.0.msix
docs\scripts\build-push-msix-v2.ps1 # 產 CogrowMDMPush-2.0.msix

# 把產物 scp 回 Mac 的 data/test/
scp Win:/Temp/*.msix data/test/

# 提取新 cert（如果換了）
unzip -p data/test/AspiraMdmDemo-1.0.msix AppxSignature.p7x | tail -c +5 > /tmp/sig.p7s
openssl pkcs7 -inform DER -in /tmp/sig.p7s -print_certs > /tmp/cert.pem
openssl x509 -in /tmp/cert.pem -outform DER -out data/test/AspiraCert.cer
```

詳細 SDK 安裝 + 工具鏈在 [`docs/scripts/README.md`](../../docs/scripts/README.md)。

## 不在 git 裡的東西（敏感 / 衍生）

`.gitignore` 排除：
- `*.pfx` —— 含**私鑰**，洩露 = 別人能簽冒充你的 MSIX
- `*.db` —— SQLite，會膨脹 + 含設備敏感資訊
- `*.log` / `tmp-*` / `.tmp/` —— 臨時 / 中間產物

如果你重 build 後產生了 `.pfx`，**絕對不要 force add**。要備份的話放外部安全位置（password manager / vault）。

## 為什麼 `CogrowMDMPush-1.0.msix` 不在這裡

那個版本是**反例**——manifest 寫了 BackgroundTask 但**沒實作 DLL**，OS 收 push 後找不到 PushHandler class 會丟棄消息。它是專案調試 push 流程時的歷史對照組，**不是合法的 push MSIX**，不應該被新接手的人誤用。它的存在意義已經寫進了 `windows-mdm-progress.md` 的 12 個 bug 筆記。

如果你想看 v1 vs v2 的差異對照，請在本地重 build（v1 腳本 `build-push-msix.ps1`，v2 腳本 `build-push-msix-v2.ps1`），對照 manifest 與 DLL 內容。
