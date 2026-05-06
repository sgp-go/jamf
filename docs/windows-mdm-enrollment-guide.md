# Windows 真機加入自建 MDM 操作指南

> 配合 [windows-mdm-account-setup.md](./windows-mdm-account-setup.md)（WNS 帳戶配置）使用。本文聚焦把一台 Windows 設備加入自建 MDM 的端到端步驟，含後端部署、客戶端操作、故障排除。

## 適用範圍

- Windows **10 Pro / Enterprise / Education**（Home 不支援 MDM）
- Windows **11 Pro / Enterprise / Education**
- 已驗證真機：Win 10 22H2 build 19045

不支援：Windows 10 / 11 Home。

## 加入流程總覽

```
①  後端起服 + 對外 HTTPS 暴露（Let's Encrypt 真實證書）
②  Windows GUI：設定 → 帳戶 → 存取公司或學校資源
③  鏈接工作或學校帳戶 → 仅注册到设备管理（右欄）
④  輸入郵箱（任意，僅觸發流程）
⑤  輸入 enrollment URL（指向後端 Discovery.svc）
⑥  下一步 → 後端三步協商完成註冊
⑦  Windows 顯示「已連接到 <EntDeviceName> MDM」
⑧  設備自動每 1 分鐘輪詢管理通道接收命令
```

---

## 第 1 步：後端部署前置條件

### 必需

- **HTTPS 公網域名**（Let's Encrypt / 公開 CA TLS 證書）
  - Windows MDM client 拒絕自簽 TLS 與私有 CA 的 server 證書
  - 開發期可用 **ngrok** / **Cloudflare Tunnel** 暴露本地 HTTP，自帶有效公開 CA 證書
- **DNS 子域名**（`EnterpriseEnrollment.<domain>`）**不必需**——本方案 Provisioning Package / 手動 enrollment URL 路徑直接走完整 URL，跳過 Auto-Discovery
- 服務器端口任意（80/443/3000 都行，只要對外 HTTPS 可達）

### 啟動後端

```bash
deno task dev
# server 起在 PORT=3000（默認）
```

### 開發期暴露公網（推薦 ngrok）

```bash
ngrok http 3000 --request-header-remove="Accept-Encoding"
# 拿到 https://<random>.ngrok-free.dev
```

> **`--request-header-remove="Accept-Encoding"`** 可選——配合下面 `setSoapHeaders` 強制不 gzip。即使不加，後端的 `Cache-Control: no-transform + Content-Encoding: identity` 也能讓 ngrok 不 gzip。

### 驗證公網可達

```bash
curl -s https://<your-host>/EnrollmentServer/Discovery.svc
# 應回：Microsoft Mobile Device Management Discovery Service
```

---

## 第 2 步：Windows 真機操作（GUI）

### 路徑（Win 10 中文版實際 UI）

1. 開**設定**（Win+I 或開始菜單搜「設定」）
2. **帳戶** → **存取公司或學校資源**
3. 點**鏈接工作或學校帳戶**——這是頂部進入鏈接流程的選項
4. 在進入頁面**右欄**找「**僅註冊到設備管理**」（不是右下角藍色「連接」按鈕）

   ⚠️ **這個入口位置容易找錯**：
   - ❌ 右下角「連接」按鈕 → 走的是 Workplace Join 流程，會強制 Federated auth
   - ✅ 右欄「僅註冊到設備管理」（Enroll only in device management）→ 純 MDM enrollment，OnPremise auth 即可

5. 輸入郵箱：任意（如 `test@example.com`），僅用於觸發流程，後端不驗證
6. 點**下一步**——系統會嘗試 Auto-Discovery（基於 email domain）
7. Auto-Discovery 失敗後，會出現 **server URL 輸入框**
8. 填入完整 enrollment URL：

   ```
   https://<your-host>/EnrollmentServer/Discovery.svc
   ```

9. 點**下一步** → 後端三步協商
10. 成功後返回「存取公司或學校資源」頁，看到一個**已連接的 MDM 條目**，名稱形如 `Aspira-<deviceId-prefix> MDM`

### 後端日誌應該看到

```
POST /EnrollmentServer/Discovery.svc → 200
POST /EnrollmentServer/Policy.svc    → 200
POST /EnrollmentServer/Enrollment.svc → 200
[Win MDM] Enrolled: deviceId=<GUID> udid=windows-<GUID>
POST /api/mdm/win/manage/<deviceId>?mode=Maintenance&Platform=WoA → 200
[Win MDM] Device <deviceId> 觸發 1201 (ClientInitiated)
```

設備之後每 1 分鐘自動 poll 管理通道接收命令。

---

## 第 3 步：驗證註冊成功

### 後端側

```bash
sqlite3 data/agent_reports.db \
  "SELECT udid, windows_device_id, enrollment_status FROM mdm_devices WHERE platform='windows';"
```

應有一筆 `enrollment_status='enrolled'` 記錄。

### Windows 側

設定 → 帳戶 → 存取公司或學校資源 → 看到「已連接到 ... MDM」條目。

### API 側

```bash
curl -s https://<your-host>/api/mdm/win/devices | jq
```

應列出新設備。

---

## 第 4 步：下發命令測試

### 應用清單查詢（無害，建議首測）

```bash
UDID="windows-<GUID>"
curl -X POST https://<your-host>/api/mdm/win/devices/$UDID/apps/refresh
# 等 1 分鐘設備 poll
curl https://<your-host>/api/mdm/win/devices/$UDID/apps
```

### 遠端清除（謹慎！）

```bash
# 真實清除（會抹掉設備數據）
curl -X POST https://<your-host>/api/mdm/win/devices/$UDID/wipe \
  -H "Content-Type: application/json" \
  -d '{"action":"doWipe"}'
```

可選 `action`：
- `doWipe` 標準清除
- `doWipeProtected` 受保護清除（重啟後重進 OOBE）
- `doWipePersistProvisionedData` 保留預配資料（適合 Autopilot 重設）

### MSIX 部署

需先把簽署過的 .msixbundle 託管在公開 HTTPS。

```bash
curl -X POST https://<your-host>/api/mdm/win/devices/$UDID/apps/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageFamilyName": "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
    "contentUri": "https://cdn.example.com/calc.msixbundle",
    "hashHex": "<sha256-of-msixbundle>",
    "isLOB": true
  }'
```

---

## 後端協議要點（避免重做時踩坑）

以下每一點都是我們真機調試時逐個發現的，少一條就會卡在某個 HRESULT。

### 1. 反向代理協議還原

`X-Forwarded-Proto` / `X-Forwarded-Host` 必須讀取，否則 Discovery 響應裡的 Policy/Enrollment URL 會是 `http://` 被 client 拒絕。

```ts
const fwdProto = c.req.header("x-forwarded-proto");
const fwdHost = c.req.header("x-forwarded-host");
const baseUrl = (fwdProto && fwdHost) ? `${fwdProto}://${fwdHost}` : ...;
```

### 2. SOAP 1.2 Content-Type 必須含 action 參數

```
Content-Type: application/soap+xml; charset=utf-8; action="<action-uri>"
```

少了 `action="..."` 參數會回 `0x80192F76`（winhttp ERROR_HEADER_NOT_FOUND）。

### 3. 阻止反向代理變換 body

```ts
c.header("Cache-Control", "no-transform, no-store");
c.header("Content-Encoding", "identity");
c.header("Content-Length", String(byteLength));
```

ngrok 默認對 text MIME 自動 gzip + chunked，Win 10 ENROLLClient 有時對組合不接受。

### 4. DiscoverResult 子元素的 namespace

**子元素繼承父 `<DiscoverResponse>` 的 enrollment namespace**，不要單獨標 PKI namespace。

❌ 錯（spec sample 是這樣，但實際 Microsoft Intune 不用）：
```xml
<EnrollmentVersion xmlns="http://schemas.microsoft.com/windows/pki/2009/01/enrollment">4.0</EnrollmentVersion>
```

✅ 對（對齊 Microsoft Intune 真實響應）：
```xml
<EnrollmentVersion>4.0</EnrollmentVersion>
```

### 5. DiscoverResult 元素順序

```
AuthPolicy
EnrollmentPolicyServiceUrl
EnrollmentServiceUrl
EnrollmentVersion       ← 在最後
```

### 6. ActivityId 格式

```xml
<ActivityId CorrelationId="urn:uuid:..." xmlns="http://schemas.microsoft.com/2004/09/ServiceModel/Diagnostics">urn:uuid:...</ActivityId>
```

### 7. OnPremise 模式下不寫 AuthenticationServiceUrl

填了反而觸發 `0x80070057 (E_INVALIDARG)`——Win 10 認為它是 Federated 流程然後找 STS。

### 8. Enrollment.svc 的 BinarySecurityToken 解析

Win 10 ENROLLClient 在 SOAP Header 也放一個**空的** `<wsse:BinarySecurityToken>`（DeviceEnrollmentUserToken 類型）。**真實 CSR 在 Body 裡 `ValueType` 含 PKCS10**。

parser 必須優先取 PKCS10 那個：

```ts
const pkcs10 = candidates.find(c => /PKCS10/i.test(c.attrs) && c.body);
```

### 9. Provider ID 用 magic name `MS DM Server`

wap-provisioningdoc 中 `DMClient/Provider/<id>` 的 ID 必須是 `MS DM Server`（含空格），其它字串可能不被 Win 10 DM 子系統識別。

### 10. wap-provisioningdoc 不寫 Push/PFN block（除非 MSIX 已安裝）

```xml
<characteristic type="Push">
  <parm name="PFN" value="..."/>
</characteristic>
```

PFN CSP 要求**對應 MSIX 應用必須本地已安裝**。否則 client 應用 wap-provisioningdoc 報 `parm-error PFN hresult=0x82AA0002`，整個 enrollment 回滾（`MENROLL_E_DEVICE_FAILED_TO_PROVISION` 0x80180023 → unenroll）。

WNS 推播 PFN 要在設備裝完 MSIX 後，透過 SyncML 管理通道 `Replace ./Vendor/MSFT/DMClient/Provider/MS DM Server/Push/PFN` 動態下發。

---

## 故障排除

### 客戶端錯誤碼對照

| HRESULT | 現象 | 根因 |
|---------|------|------|
| `0x80192F76` | GUI 「無法自動發現與輸入的用戶名匹配的管理終結點」 | winhttp `ERROR_HEADER_NOT_FOUND`——響應缺 Content-Type action 參數 |
| `0x80070057` | E_INVALIDARG | DiscoverResult 多餘字段（如 OnPremise 模式填了 AuthenticationServiceUrl） |
| `0x80180010` | MENROLL_E client 拒絕 Discovery | DiscoverResult 字段順序 / namespace 不對 |
| `0x80180020` | OMA-DM 配置失敗 | wap-provisioningdoc 某 CSP 應用失敗（看詳細 Debug log） |
| `0x80180023` | MENROLL_E_DEVICE_FAILED_TO_PROVISION | wap-provisioningdoc 整體應用失敗 + 自動 unenroll 回滾 |
| `0x82AA0002` | parm-error 子節點 hresult | 該 CSP 路徑的某個 parm 應用失敗（如 Push/PFN 對應 MSIX 未安裝） |
| `0x00000000` (S_OK) | 成功 | 🎉 |

### GUI「無法自動發現」但 server 已 200 OK

說明 client 收到響應後內部解析或校驗失敗。常見原因：
1. Content-Type 缺 `action="..."`（→ `0x80192F76`）
2. DiscoverResult 字段格式 / 順序不對
3. Win 10 ENROLLClient cache 同一 UPN 失敗結果——換新 UPN 重試

### 排查工具

#### Win 10 端：抓詳細錯誤

```powershell
# 啟用 Debug log（一次性）
wevtutil sl Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Debug /e:true

# 收集 enrollment 完整診斷包
mdmdiagnosticstool.exe -area "DeviceEnrollment" -zip C:\diag.zip

# P/Invoke 直接調用避免 GUI cache 干擾（拿到精確 HRESULT）
$src = @"
using System; using System.Runtime.InteropServices; using System.Threading;
public class MdmReg {
  [DllImport("mdmregistration.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  private static extern int RegisterDeviceWithManagement(string upn, string mdmUrl, string accessToken);
  public static int Run(string upn, string url) {
    int r = -1;
    var t = new Thread(() => { r = RegisterDeviceWithManagement(upn, url, ""); });
    t.SetApartmentState(ApartmentState.MTA);
    t.Start(); t.Join();
    return r;
  }
}
"@
Add-Type -TypeDefinition $src
$hr = [MdmReg]::Run("test@example.com", "https://<your-host>/EnrollmentServer/Discovery.svc")
"HRESULT: 0x" + ("{0:X8}" -f ([uint32]([int64]$hr -band 0xFFFFFFFFL)))
```

#### 後端：ngrok inspector

```bash
# 看完整 HTTP 請求 / 響應原文（含 header）
curl -s http://localhost:4040/api/requests/http?limit=5 | jq
```

#### 解 etl trace（Win 10 端）

```powershell
logman start -ets MdmTrace -p "{3DA494E4-0FE2-415C-B895-FB5265C5C83B}" 0xFFFFFFFFFFFFFFFF 0xFF -o C:\trace.etl -f bincirc -max 200
# 觸發 enrollment
logman stop -ets MdmTrace
tracerpt C:\trace.etl -of XML -o C:\trace.xml -y
```

#### 對照 Microsoft 真實 server 響應

當不確定某字段格式時，直接 curl 抓 Intune 的響應作為金標準：

```bash
curl -s -X POST -H "Content-Type: application/soap+xml" \
  --data @discover-request.xml \
  https://enrollment.manage.microsoft.com/EnrollmentServer/Discovery.svc
```

---

## 註銷設備（uninstall）

### 從 Windows 端

設定 → 帳戶 → 存取公司或學校資源 → 選中 MDM 條目 → **斷開連接**。

設備會發送 unenroll alert 到後端（後端可在 `/api/mdm/win/manage/:deviceId` 收到 SyncML `<Alert>1226</Alert>`）。

### 從後端側強制移除（暫無 API，直接 DB 操作）

```sql
DELETE FROM mdm_windows_apps WHERE device_udid = 'windows-<GUID>';
DELETE FROM mdm_commands WHERE device_udid = 'windows-<GUID>';
DELETE FROM mdm_certificates WHERE device_udid = 'windows-<GUID>';
DELETE FROM mdm_devices WHERE udid = 'windows-<GUID>';
```

設備下次 poll 會收到 404，自動進入 unenroll retry。

---

## 參考

- [windows-mdm-account-setup.md](./windows-mdm-account-setup.md) — Microsoft Store 開發者帳戶 + WNS 配置
- [Microsoft MS-MDE2 spec](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-mde2/) — 協議規範
- [DMClient CSP](https://learn.microsoft.com/en-us/windows/client-management/mdm/dmclient-csp) — DM 客戶端配置
- [EnterpriseModernAppManagement CSP](https://learn.microsoft.com/en-us/windows/client-management/mdm/enterprisemodernappmanagement-csp) — MSIX 應用部署
- [RemoteWipe CSP](https://learn.microsoft.com/en-us/windows/client-management/mdm/remotewipe-csp) — 遠端清除
- 內部 brain：`~/brain/projects/jamf-explore/raw/win10-mdm-enrollment-blocker.md` — 完整調試紀錄
