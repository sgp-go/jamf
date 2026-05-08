# data/test/ — Demo MSIX 產物 + Publisher Cert（接手即用）

> 這個目錄給接手團隊**直接驗證 install / update 流程**準備的：拿 git clone 下來就能派送，**不需要**自己裝 Win SDK 重 build。
>
> ⚠️ **不含 push MSIX**——push MSIX 的 PFN 綁 cogrow Microsoft Store 註冊，跨團隊不可共享。接手做 push 演示前必須走 [`docs/scripts/README.md` §接手：替換為你自己的應用標識](../../docs/scripts/README.md#接手替換為你自己的應用標識生產--獨立部署必做) 6 步流程，自行 build 一份 push MSIX。

## 文件清單

| 檔案 | 用途 | 對應的驗證場景 |
|---|---|---|
| `AspiraMdmDemo-1.0.msix` | demo install v1 | `POST /api/mdm/win/devices/:udid/apps/install` |
| `AspiraMdmDemo-2.0.msix` | demo update v2（同 PFN，version 2.0.0.0） | `POST /api/mdm/win/devices/:udid/apps/update` |
| `AspiraCert.cer` | Aspira-MDM-Test 自簽 publisher cert（公鑰） | sideload `AspiraMdmDemo-*` 前必須裝 |

> 為何 install / update 兩個 demo MSIX 接手**可直接沿用**：它們走 LOB sideload，OS 只校驗 cert chain 是否信任（裝好 `AspiraCert.cer` 即可），**與 Microsoft Store / Azure 註冊無關**。任何 device 裝 cert 後都能 install。
>
> 為何 push MSIX **不能**沿用：WNS 推送按 PFN 路由，PFN 綁 Microsoft Store 應用註冊，接手用自家 Azure 拿的 `WNS_PFN` 與 cogrow demo 的 PFN 不同，OS 即使裝上 cogrow demo MSIX，WNS 也不會推送到那個 PFN。

> ⚠️ **架構限制**：以上 `.msix` 都是 **x64**。如果裝到 **ARM64 Win11**（如 Apple Silicon UTM/Parallels VM 跑 ARM 版 Windows），OS 會回 `0x80070005` 拒絕 sideload —— MSIX 容器層強制架構匹配，不能依賴 x64 emulation 跨架構。
>
> ARM 環境需自行重 build ARM64 版（`docs/scripts/build-msix.ps1` 把 manifest `ProcessorArchitecture="x64"` 改成 `arm64`，csc 加 `/platform:arm64`，重簽）。

## Cert 詳情

### AspiraCert.cer（install / update 用）
- Subject / Issuer：`C=TW, O=Aspira, CN=Aspira-MDM-Test`
- 有效期：**2026-05-07 ~ 2031-05-07**（5 年）
- SHA-1 Fingerprint：`A2:0F:F8:14:91:60:08:ED:65:D2:FA:82:78:5B:CD:0B:47:75:CF:B8`

> ⚠️ Cert 過期會讓**新 build 的 MSIX 簽不上**，但**已簽好的 .msix 仍永久有效**（OS 驗簽查的是簽署當下的有效期）。也就是說：cert 5 年後過期，這 2 個 .msix 還是能裝。
>
> 接手 build 自家 push MSIX 時會生成自家 publisher cert，從新 .msix 提取後手動裝到 device 即可（流程同 [客戶端使用流程 §1](#1-裝-cert-到-trusted-root--trusted-people必須)）。

## 客戶端使用流程

### 1. 裝 cert 到 Trusted Root + Trusted People（必須）

```powershell
# 裝 demo install/update 用的 cert
Import-Certificate -FilePath AspiraCert.cer -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath AspiraCert.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
```

> 接手做 push 演示時，自家 build 的 push MSIX 會帶**自家** publisher cert，從新 .msix 提取後同樣 `Import-Certificate` 裝到 Trusted Root + Trusted People。

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

# 把產物 scp 回 Mac 的 data/test/
scp Win:/Temp/*.msix data/test/

# 提取新 cert（如果換了）
unzip -p data/test/AspiraMdmDemo-1.0.msix AppxSignature.p7x | tail -c +5 > /tmp/sig.p7s
openssl pkcs7 -inform DER -in /tmp/sig.p7s -print_certs > /tmp/cert.pem
openssl x509 -in /tmp/cert.pem -outform DER -out data/test/AspiraCert.cer
```

> push MSIX 的 build 流程獨立成章，且**接手必須走自己 Microsoft Store 註冊**——詳見 [`docs/scripts/README.md` §接手：替換為你自己的應用標識](../../docs/scripts/README.md#接手替換為你自己的應用標識生產--獨立部署必做) 6 步。

詳細 SDK 安裝 + 工具鏈在 [`docs/scripts/README.md`](../../docs/scripts/README.md)。

## 不在 git 裡的東西

`.gitignore` 排除：
- `*.pfx` —— 含**私鑰**，洩露 = 別人能簽冒充你的 MSIX
- `*.db` —— SQLite，會膨脹 + 含設備敏感資訊
- `*.log` / `tmp-*` / `.tmp/` —— 臨時 / 中間產物
- `CogrowMDMPush*.msix` / `CogrowMDMPushCert.cer` —— push MSIX 綁 cogrow demo 註冊，跨團隊不可共享，接手須自行 build

如果你重 build 後產生了 `.pfx`，**絕對不要 force add**。要備份的話放外部安全位置（password manager / vault）。
