# Jamf Pro API 整合文件

## 概述

本文件記錄了 Jamf Pro 例項 `cogrow.jamfcloud.com` 的 API 整合配置過程，包括認證方式、憑據建立步驟和 API 使用方法。

- **例項地址**: https://cogrow.jamfcloud.com
- **版本**: 11.25.2
- **管理員賬戶**: Jay Hao (dabuddha@126.com, Federated User)

## API 架構

Jamf Pro 提供兩套 API：

| API | 基礎路徑 | 說明 |
|-----|---------|------|
| **Jamf Pro API** (新版) | `/api/` | RESTful API，推薦使用，支援 Bearer Token 和 Client Credentials |
| **Classic API** (舊版) | `/JSSResource/` | 傳統 API，支援 Basic Auth 和 Bearer Token |

### 內建文件

- Swagger UI: https://cogrow.jamfcloud.com/api/doc/
- OpenAPI Schema: https://cogrow.jamfcloud.com/api/schema/
- API 入口頁面: https://cogrow.jamfcloud.com/api

## 認證方式

### 方式一：Client Credentials（推薦，適用於服務端整合）

這是最安全的長期方案，不依賴使用者密碼。

**憑據資訊（儲存在 `.env` 檔案中）：**

- Client ID: 見 `.env` 檔案的 `JAMF_CLIENT_ID`
- Client Secret: 見 `.env` 檔案的 `JAMF_CLIENT_SECRET`
- Token 有效期: 1800 秒（30 分鐘）
- 關聯 API Role: `Full Access Admin`（520 個許可權，全部許可權）

**獲取 Access Token：**

```bash
curl -X POST "https://cogrow.jamfcloud.com/api/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${JAMF_CLIENT_ID}&client_secret=${JAMF_CLIENT_SECRET}"
```

**響應示例：**

```json
{
  "access_token": "eyJhbGciOiJ...",
  "scope": "Full Access Admin",
  "token_type": "bearer",
  "expires_in": 1799
}
```

### 方式二：Bearer Token（使用者名稱/密碼）

適用於臨時除錯，需要本地標準賬戶（非 SSO/Federated 使用者）。

**獲取 Token：**

```bash
curl -X POST "https://cogrow.jamfcloud.com/api/v1/auth/token" \
  -u "api_admin:${JAMF_API_PASSWORD}"
```

**響應示例：**

```json
{
  "token": "eyJhbGciOiJ...",
  "expires": "2026-03-17T07:12:28.003Z"
}
```

> 注意：Token 預設有效期 20 分鐘，可透過 `/api/v1/auth/keep-alive` 續期。

### 使用 Token 呼叫 API

```bash
curl -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Accept: application/json" \
  https://cogrow.jamfcloud.com/api/v1/jamf-pro-version
```

## 配置建立步驟記錄

### 步驟 1：建立本地標準賬戶

由於管理員賬戶 Jay Hao 是 Federated User（SSO 聯合身份），無法透過使用者名稱/密碼獲取 API Token。因此需要建立一個本地標準賬戶。

1. 進入 **Settings > System > User accounts and groups**
2. 點選 **+ New** 建立新賬戶
3. 填寫資訊：
   - Username: `api_admin`
   - Privilege Set: `Administrator`
   - Access Status: `Enabled`
   - Password: 見 `.env` 檔案
4. 點選 **Save**

> 關鍵點：SSO 對 Federated User 強制生效，所以必須建立本地標準賬戶才能使用 API 的 Basic Auth。

### 步驟 2：透過 API 建立 API Role

使用 api_admin 獲取 Token 後，呼叫 API 建立包含全部許可權的 Role。

**查詢所有可用許可權：**

```bash
curl -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/json" \
  "https://your-instance.jamfcloud.com/api/v1/api-role-privileges" | jq '.privileges | length'
# 返回: 520
```

**建立包含全部許可權的 API Role：**

> ⚠️ **重要提示**：Jamf Pro 的「全部許可權」需要明確列出所有 520 個項目。
> 手動在 UI 勾選可能遺漏，建議透過 API 建立以確保完整性。
> 特別注意 `View MDM command information in Jamf Pro API` 和 `Send MDM command information in Jamf Pro API`
> 這一對許可權必須**同時開啟**，否則 v2 MDM 命令端點會返回 403。

<details>
<summary>完整 curl 命令（包含全部 520 個許可權，點選展開）</summary>

```bash
curl -X POST "https://your-instance.jamfcloud.com/api/v1/api-roles" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
  "displayName": "Full Access Admin",
  "privileges": [
    "Access Management Setting Read",
    "Access Management Setting Update",
    "Allow User to Enroll",
    "Assign Users to Computers",
    "Assign Users to Mobile Devices",
    "CLEAR_TEACHER_PROFILE_PRIVILEGE",
    "Change Password",
    "Create AD CS Settings",
    "Create API Integrations",
    "Create API Roles",
    "Create Accounts",
    "Create Advanced Computer Searches",
    "Create Advanced Mobile Device Searches",
    "Create Advanced User Content Searches",
    "Create Advanced User Searches",
    "Create AirPlay Permissions",
    "Create Allowed File Extension",
    "Create Attachment Assignments",
    "Create Buildings",
    "Create Categories",
    "Create Classes",
    "Create Cloud Distribution Point",
    "Create Computer Enrollment Invitations",
    "Create Computer Extension Attributes",
    "Create Computer PreStage Enrollments",
    "Create Computers",
    "Create Custom Paths",
    "Create Departments",
    "Create Device Enrollment Program Instances",
    "Create Device Name Patterns",
    "Create DigiCert Settings",
    "Create Directory Bindings",
    "Create Disk Encryption Configurations",
    "Create Disk Encryption Institutional Configurations",
    "Create Distribution Points",
    "Create Dock Items",
    "Create Enrollment Customizations",
    "Create Enrollment Profiles",
    "Create File Attachments",
    "Create Infrastructure Managers",
    "Create Inventory Preload Records",
    "Create JSON Web Token Configuration",
    "Create Jamf Cloud Distribution Service Files",
    "Create Jamf Connect Deployments",
    "Create Jamf Protect Deployments",
    "Create Keystore",
    "Create LDAP Servers",
    "Create Licensed Software",
    "Create Mac Applications",
    "Create Maintenance Pages",
    "Create Managed Software Updates",
    "Create Mobile Device Applications",
    "Create Mobile Device Enrollment Invitations",
    "Create Mobile Device Extension Attributes",
    "Create Mobile Device Managed App Configurations",
    "Create Mobile Device PreStage Enrollments",
    "Create Mobile Devices",
    "Create Network Integration",
    "Create Network Segments",
    "Create Packages",
    "Create Patch External Source",
    "Create Patch Management Software Titles",
    "Create Patch Policies",
    "Create Peripheral Types",
    "Create Policies",
    "Create Printers",
    "Create Provisioning Profiles",
    "Create Push Certificates",
    "Create Remote Administration",
    "Create Removable MAC Address",
    "Create Restricted Software",
    "Create Scripts",
    "Create Self Service Bookmarks",
    "Create Self Service Branding Configuration",
    "Create Sites",
    "Create Smart Computer Groups",
    "Create Smart Mobile Device Groups",
    "Create Smart User Groups",
    "Create Software Update Servers",
    "Create Static Computer Groups",
    "Create Static Mobile Device Groups",
    "Create Static User Groups",
    "Create User",
    "Create User Extension Attributes",
    "Create VPP Assignment",
    "Create VPP Invitations",
    "Create Volume Purchasing Locations",
    "Create Webhooks",
    "Create eBooks",
    "Create iBeacon",
    "Create iOS Configuration Profiles",
    "Create macOS Configuration Profiles",
    "Delete AD CS Settings",
    "Delete API Integrations",
    "Delete API Roles",
    "Delete Accounts",
    "Delete Advanced Computer Searches",
    "Delete Advanced Mobile Device Searches",
    "Delete Advanced User Content Searches",
    "Delete Advanced User Searches",
    "Delete AirPlay Permissions",
    "Delete Allowed File Extension",
    "Delete Attachment Assignments",
    "Delete Buildings",
    "Delete Categories",
    "Delete Classes",
    "Delete Computer Extension Attributes",
    "Delete Computer PreStage Enrollments",
    "Delete Computers",
    "Delete Custom Paths",
    "Delete Departments",
    "Delete Device Enrollment Program Instances",
    "Delete Device Name Patterns",
    "Delete DigiCert Settings",
    "Delete Directory Bindings",
    "Delete Disk Encryption Configurations",
    "Delete Disk Encryption Institutional Configurations",
    "Delete Distribution Points",
    "Delete Dock Items",
    "Delete Enrollment Customizations",
    "Delete Enrollment Profiles",
    "Delete File Attachments",
    "Delete Infrastructure Managers",
    "Delete Inventory Preload Records",
    "Delete JSON Web Token Configuration",
    "Delete Jamf Cloud Distribution Service Files",
    "Delete Jamf Connect Deployments",
    "Delete Jamf Protect Deployments",
    "Delete Keystores",
    "Delete LDAP Servers",
    "Delete Licensed Software",
    "Delete Mac Applications",
    "Delete Maintenance Pages",
    "Delete Managed Software Updates",
    "Delete Mobile Device Applications",
    "Delete Mobile Device Enrollment Invitations",
    "Delete Mobile Device Extension Attributes",
    "Delete Mobile Device Managed App Configurations",
    "Delete Mobile Device PreStage Enrollments",
    "Delete Mobile Devices",
    "Delete Network Integration",
    "Delete Network Segments",
    "Delete Packages",
    "Delete Patch External Source",
    "Delete Patch Management Software Titles",
    "Delete Patch Policies",
    "Delete Peripheral Types",
    "Delete Policies",
    "Delete Printers",
    "Delete Provisioning Profiles",
    "Delete Push Certificates",
    "Delete Remote Administration",
    "Delete Removable MAC Address",
    "Delete Restricted Software",
    "Delete Return To Service Configurations",
    "Delete Scripts",
    "Delete Self Service Bookmarks",
    "Delete Self Service Branding Configuration",
    "Delete Sites",
    "Delete Smart Computer Groups",
    "Delete Smart Mobile Device Groups",
    "Delete Smart User Groups",
    "Delete Software Update Servers",
    "Delete Static Computer Groups",
    "Delete Static Mobile Device Groups",
    "Delete Static User Groups",
    "Delete User",
    "Delete User Extension Attributes",
    "Delete VPP Assignment",
    "Delete VPP Invitations",
    "Delete Volume Purchasing Locations",
    "Delete Webhooks",
    "Delete eBooks",
    "Delete iBeacon",
    "Delete iOS Configuration Profiles",
    "Delete macOS Configuration Profiles",
    "Dismiss Notifications",
    "Edit Return To Service Configurations",
    "Enroll Computers",
    "Enroll Mobile Devices",
    "Flush MDM Commands",
    "Flush Policy Logs",
    "Jamf Connect Deployment Retry",
    "Jamf Packages Action",
    "Jamf Protect Deployment Retry",
    "Read AD CS Certificate Jobs",
    "Read AD CS Settings",
    "Read Accounts",
    "Read Activation Code",
    "Read Advanced Computer Searches",
    "Read Advanced Mobile Device Searches",
    "Read Advanced User Content Searches",
    "Read Advanced User Searches",
    "Read AirPlay Permissions",
    "Read Allowed File Extension",
    "Read Apache Tomcat Settings",
    "Read App Request Settings",
    "Read Apple Configurator Enrollment",
    "Read Attachment Assignments",
    "Read Automatic Mac App Updates Settings",
    "Read Automatically Renew MDM Profile Settings",
    "Read Buildings",
    "Read Cache",
    "Read Categories",
    "Read Change Management",
    "Read Classes",
    "Read Cloud Distribution Point",
    "Read Cloud Services Settings",
    "Read Computer Check-In",
    "Read Computer Enrollment Invitations",
    "Read Computer Extension Attributes",
    "Read Computer Inventory Collection",
    "Read Computer Inventory Collection Settings",
    "Read Computer PreStage Enrollments",
    "Read Computer Security",
    "Read Computers",
    "Read Conditional Access",
    "Read Custom Paths",
    "Read Departments",
    "Read Device Compliance Information",
    "Read Device Enrollment Program Instances",
    "Read Device Name Patterns",
    "Read DigiCert Settings",
    "Read Directory Bindings",
    "Read Disk Encryption Configurations",
    "Read Disk Encryption Institutional Configurations",
    "Read Distribution Points",
    "Read Dock Items",
    "Read Education Settings",
    "Read Enrollment Customizations",
    "Read Enrollment Profiles",
    "Read File Attachments",
    "Read GSX Connection",
    "Read Impact Alert Notification Settings",
    "Read Infrastructure Managers",
    "Read Inventory Preload Records",
    "Read JSON Web Token Configuration",
    "Read JSS URL",
    "Read Jamf Cloud Distribution Service Files",
    "Read Jamf Connect Deployments",
    "Read Jamf Connect Settings",
    "Read Jamf Protect Deployments",
    "Read Jamf Protect Settings",
    "Read Keystores",
    "Read Knobs",
    "Read LDAP Servers",
    "Read Licensed Software",
    "Read Limited Access Settings",
    "Read Login Disclaimer",
    "Read Mac Applications",
    "Read Maintenance Pages",
    "Read Managed Software Updates",
    "Read Mobile Device App Maintenance Settings",
    "Read Mobile Device Applications",
    "Read Mobile Device Enrollment Invitations",
    "Read Mobile Device Extension Attributes",
    "Read Mobile Device Inventory Collection",
    "Read Mobile Device Managed App Configurations",
    "Read Mobile Device PreStage Enrollments",
    "Read Mobile Devices",
    "Read Mobile Device Self Service",
    "Read Network Integration",
    "Read Network Segments",
    "Read Onboarding Configuration",
    "Read PKI",
    "Read Packages",
    "Read Parent App Settings",
    "Read Password Policy",
    "Read Patch External Source",
    "Read Patch Internal Source",
    "Read Patch Management Settings",
    "Read Patch Management Software Titles",
    "Read Patch Policies",
    "Read Peripheral Types",
    "Read Policies",
    "Read Printers",
    "Read Provisioning Profiles",
    "Read Push Certificates",
    "Read Re-enrollment",
    "Read Removable MAC Address",
    "Read Remote Administration",
    "Read Remote Assist",
    "Read Restricted Software",
    "Read Retention Policy",
    "Read SMTP Server",
    "Read SSO Settings",
    "Read Scripts",
    "Read Self Service",
    "Read Self Service Bookmarks",
    "Read Self Service Branding Configuration",
    "Read Sites",
    "Read Smart Computer Groups",
    "Read Smart Mobile Device Groups",
    "Read Smart User Groups",
    "Read Software Update Servers",
    "Read Static Computer Groups",
    "Read Static Mobile Device Groups",
    "Read Static User Groups",
    "Read Teacher App Settings",
    "Read User",
    "Read User Extension Attributes",
    "Read VPP Assignment",
    "Read VPP Invitations",
    "Read Volume Purchasing Locations",
    "Read Webhooks",
    "Read eBooks",
    "Read iBeacon",
    "Read iOS Configuration Profiles",
    "Read macOS Configuration Profiles",
    "Remove Jamf Parent management capabilities",
    "Remove restrictions set by Jamf Parent",
    "Renewal of the Built-in Certificate Authority",
    "Send Application Attributes Command",
    "Send Apply Redemption Code Command",
    "Send Blank Pushes to Mobile Devices",
    "Send Command to Renew MDM Profile",
    "Send Computer Bluetooth Command",
    "Send Computer Delete User Account Command",
    "Send Computer Remote Command to Download and Install OS X Update",
    "Send Computer Remote Command to Install Package",
    "Send Computer Remote Desktop Command",
    "Send Computer Remote Lock Command",
    "Send Computer Remote Wipe Command",
    "Send Computer Restart Command",
    "Send Computer Set Activation Lock Command",
    "Send Computer Shut Down Command",
    "Send Computer Unlock User Account Command",
    "Send Computer Unmanage Command",
    "Send Declarative Management Command",
    "Send Device Information Command",
    "Send Disable Bootstrap Token Command",
    "Send Email to End Users via JSS",
    "Send Enable Bootstrap Token Command",
    "Send Inventory Requests to Mobile Devices",
    "Send Local Admin Password Command",
    "Send MDM Check In Command",
    "Send MDM command information in Jamf Pro API",
    "Send Messages to Self Service Mobile",
    "Send Mobile Device Bluetooth Command",
    "Send Mobile Device Diagnostics and Usage Reporting and App Analytics Commands",
    "Send Mobile Device Disable Data Roaming Command",
    "Send Mobile Device Disable Voice Roaming Command",
    "Send Mobile Device Enable Data Roaming Command",
    "Send Mobile Device Enable Voice Roaming Command",
    "Send Mobile Device Lost Mode Command",
    "Send Mobile Device Managed Settings Command",
    "Send Mobile Device Mirroring Command",
    "Send Mobile Device Personal Hotspot Command",
    "Send Mobile Device Refresh Cellular Plans Command",
    "Send Mobile Device Remote Command to Download and Install iOS Update",
    "Send Mobile Device Remote Lock Command",
    "Send Mobile Device Remote Wipe Command",
    "Send Mobile Device Remove Passcode Command",
    "Send Mobile Device Remove Restrictions Password Command",
    "Send Mobile Device Restart Device Command",
    "Send Mobile Device Set Activation Lock Command",
    "Send Mobile Device Set Device Name Command",
    "Send Mobile Device Set Wallpaper Command",
    "Send Mobile Device Shared Device Configuration Commands",
    "Send Mobile Device Shared iPad Commands",
    "Send Mobile Device Shut Down Command",
    "Send Mobile Device Software Update Recommendation Cadence Command",
    "Send Set Recovery Lock Command",
    "Send Set Timezone Command",
    "Send Software Update Settings Command",
    "Send Update Passcode Lock Grace Period Command",
    "Send Verify Recovery Lock Command",
    "Start Remote Assist Session",
    "Unmanage Mobile Devices",
    "Update AD CS Certificate Jobs",
    "Update AD CS Settings",
    "Update API Integrations",
    "Update API Roles",
    "Update Accounts",
    "Update Activation Code",
    "Update Advanced Computer Searches",
    "Update Advanced Mobile Device Searches",
    "Update Advanced User Content Searches",
    "Update Advanced User Searches",
    "Update AirPlay Permissions",
    "Update Apache Tomcat Settings",
    "Update App Request Settings",
    "Update Apple Configurator Enrollment",
    "Update Attachment Assignments",
    "Update Automatic Mac App Updates Settings",
    "Update Automatically Renew MDM Profile Settings",
    "Update Buildings",
    "Update Cache",
    "Update Categories",
    "Update Change Management",
    "Update Classes",
    "Update Cloud Distribution Point",
    "Update Cloud Services Settings",
    "Update Clustering",
    "Update Computer Check-In",
    "Update Computer Enrollment Invitations",
    "Update Computer Extension Attributes",
    "Update Computer Inventory Collection",
    "Update Computer Inventory Collection Settings",
    "Update Computer PreStage Enrollments",
    "Update Computer Security",
    "Update Computers",
    "Update Conditional Access",
    "Update Custom Paths",
    "Update Departments",
    "Update Device Enrollment Program Instances",
    "Update Device Name Patterns",
    "Update DigiCert Settings",
    "Update Directory Bindings",
    "Update Disk Encryption Configurations",
    "Update Disk Encryption Institutional Configurations",
    "Update Distribution Points",
    "Update Dock Items",
    "Update Education Settings",
    "Update Enrollment Customizations",
    "Update Enrollment Profiles",
    "Update File Attachments",
    "Update GSX Connection",
    "Update Impact Alert Notification Settings",
    "Update Infrastructure Managers",
    "Update Inventory Preload Records",
    "Update JSON Web Token Configuration",
    "Update JSS URL",
    "Update Jamf Connect Deployments",
    "Update Jamf Connect Settings",
    "Update Jamf Protect Deployments",
    "Update Jamf Protect Settings",
    "Update Keystores",
    "Update Knobs",
    "Update LDAP Servers",
    "Update Licensed Software",
    "Update Limited Access Settings",
    "Update Login Disclaimer",
    "Update Mac Applications",
    "Update Maintenance Pages",
    "Update Managed Software Updates",
    "Update Mobile Device App Maintenance Settings",
    "Update Mobile Device Applications",
    "Update Mobile Device Enrollment Invitations",
    "Update Mobile Device Extension Attributes",
    "Update Mobile Device Inventory Collection",
    "Update Mobile Device Managed App Configurations",
    "Update Mobile Device PreStage Enrollments",
    "Update Mobile Device Self Service",
    "Update Mobile Devices",
    "Update Network Integration",
    "Update Network Segments",
    "Update Onboarding Configuration",
    "Update PKI",
    "Update Packages",
    "Update Parent App Settings",
    "Update Password Policy",
    "Update Patch External Source",
    "Update Patch Management Settings",
    "Update Patch Management Software Titles",
    "Update Patch Policies",
    "Update Peripheral Types",
    "Update Policies",
    "Update Printers",
    "Update Provisioning Profiles",
    "Update Push Certificates",
    "Update Re-enrollment",
    "Update Remote Administration",
    "Update Remote Assist",
    "Update Removable MAC Address",
    "Update Restricted Software",
    "Update Retention Policy",
    "Update Scripts",
    "Update Self Service",
    "Update Self Service Bookmarks",
    "Update Self Service Branding Configuration",
    "Update Sites",
    "Update Smart Computer Groups",
    "Update Smart Mobile Device Groups",
    "Update Smart User Groups",
    "Update SMTP Server",
    "Update Software Update Servers",
    "Update SSO Settings",
    "Update Static Computer Groups",
    "Update Static Mobile Device Groups",
    "Update Static User Groups",
    "Update Teacher App Settings",
    "Update User",
    "Update User Extension Attributes",
    "Update User-Initiated Enrollment",
    "Update Volume Purchasing Locations",
    "Update VPP Assignment",
    "Update VPP Invitations",
    "Update watchOS Enrollment Settings",
    "Update Webhooks",
    "View Activation Lock Bypass Code",
    "View Computer Device Lock Pin",
    "View Disk Encryption Recovery Key",
    "View Event Logs",
    "View JSS Information",
    "View License Serial Numbers",
    "View Local Admin Password",
    "View Local Admin Password Audit History",
    "View MDM command information in Jamf Pro API",
    "View Mobile Device Lost Mode Location",
    "View Recovery Lock",
    "View Return To Service Configurations",
    "blueprints create",
    "blueprints delete",
    "blueprints read",
    "blueprints update",
    "compliance-benchmarks create",
    "compliance-benchmarks delete",
    "compliance-benchmarks read",
    "compliance-benchmarks update"
  ]
}'
```

</details>

**驗證 Role 許可權數量：**

```bash
curl -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/json" \
  "https://your-instance.jamfcloud.com/api/v1/api-roles/{roleId}" | jq '.privileges | length'
# 應返回: 520
```

**如需更新已有 Role 的許可權（補全缺失的許可權）：**

```bash
# 先獲取全部可用許可權
ALL_PRIVILEGES=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/json" \
  "https://your-instance.jamfcloud.com/api/v1/api-role-privileges" | jq -c '.privileges')

# 用全部許可權覆蓋更新指定 Role
curl -X PUT "https://your-instance.jamfcloud.com/api/v1/api-roles/{roleId}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"displayName\":\"Full Access Admin\",\"privileges\":${ALL_PRIVILEGES}}"
```

### 步驟 3：建立 API Client（Integration）

```bash
# 建立 API Integration
POST /api/v1/api-integrations
{
  "authorizationScopes": ["Full Access Admin"],
  "displayName": "Cogrow API Client",
  "enabled": true,
  "accessTokenLifetimeSeconds": 1800
}

# 生成 Client Credentials
POST /api/v1/api-integrations/{id}/client-credentials
# 返回 clientId 和 clientSecret
```

### 步驟 4：驗證

```bash
# 用 Client Credentials 獲取 Token
POST /api/oauth/token
grant_type=client_credentials&client_id=...&client_secret=...

# 測試 API 呼叫
GET /api/v1/jamf-pro-version
# 返回: {"version": "11.25.2-t1772925731845"}
```

## 主要 API 端點分類

### 裝置管理
| 端點 | 說明 |
|------|------|
| `GET /api/v1/computer-inventory` | 獲取電腦庫存列表 |
| `GET /api/v2/mobile-devices` | 獲取移動裝置列表 |
| `GET /api/v1/computer-groups` | 獲取電腦分組 |
| `GET /api/v1/mobile-device-groups` | 獲取裝置分組 |

### 策略與配置
| 端點 | 說明 |
|------|------|
| `GET /api/preview/policies` | 獲取策略列表 |
| `GET /api/v1/scripts` | 獲取指令碼列表 |
| `GET /api/v1/packages` | 獲取軟體包列表 |
| `GET /api/v1/categories` | 獲取分類列表 |

### 使用者管理
| 端點 | 說明 |
|------|------|
| `GET /api/v1/accounts` | 獲取使用者賬戶列表 |
| `GET /api/v1/api-roles` | 獲取 API 角色列表 |
| `GET /api/v1/api-integrations` | 獲取 API 整合列表 |

### 註冊管理
| 端點 | 說明 |
|------|------|
| `GET /api/v1/device-enrollments` | 獲取設備註冊配置 |
| `GET /api/v1/computer-prestages` | 獲取電腦預配置 |
| `GET /api/v1/mobile-device-prestages` | 獲取裝置預配置 |

### 系統資訊
| 端點 | 說明 |
|------|------|
| `GET /api/v1/jamf-pro-version` | 獲取版本資訊 |
| `GET /api/v1/jamf-pro-information` | 獲取例項資訊 |
| `GET /api/startup-status` | 獲取啟動狀態（無需認證）|

## 自建管理平臺 API

後端服務執行在 `http://localhost:3000`，基於 Deno + Hono + SQLite。

### Agent 裝置狀態上報

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/agent/report` | POST | Agent App 上報裝置狀態（電池、儲存、網路等） |
| `/api/agent/reports/:deviceId` | GET | 查詢裝置上報歷史（支援 `limit`/`offset` 分頁） |
| `/api/agent/latest/:deviceId` | GET | 獲取裝置最新一條上報 |

### Agent 使用時長統計

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/agent/usage` | POST | 上報裝置使用時長 |
| `/api/agent/usage/:deviceId` | GET | 查詢裝置使用時長 |

**POST /api/agent/usage 請求體：**

```json
{
  "deviceId": "裝置ID",
  "sessionId": "可選的會話ID",
  "stats": [
    {
      "date": "2026-03-18",
      "totalMinutes": 120,
      "pickup": 15,
      "maxContinuous": 45,
      "timeStats": [{"hour": 9, "minutes": 30}, {"hour": 10, "minutes": 45}]
    }
  ]
}
```

**GET /api/agent/usage/:deviceId 查詢引數：**

| 引數 | 說明 |
|------|------|
| `date` | 查詢指定日期，如 `2026-03-18` |
| `startDate` | 日期範圍起始，如 `2026-03-01` |
| `endDate` | 日期範圍結束，如 `2026-03-31` |
| `limit` | 限制返回條數 |

**資料庫表 `device_usage_stats`：**

```sql
CREATE TABLE device_usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  session_id TEXT,
  date TEXT NOT NULL,              -- "YYYY-MM-DD"
  total_minutes INTEGER NOT NULL,  -- 使用分鐘數
  pickup INTEGER NOT NULL,         -- 解鎖次數
  max_continuous INTEGER NOT NULL,  -- 最長連續使用分鐘數
  time_stats TEXT,                 -- JSON: 每小時統計
  reported_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(device_id, date)          -- 同裝置同日覆蓋更新
);
```

### 裝置管理（代理 Jamf API）

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/devices` | GET | 獲取 Jamf 管理的裝置列表 |
| `/api/devices/:id` | GET | 獲取裝置詳情（合併 Jamf + Agent 資料） |
| `/api/devices/:id/command` | POST | 傳送管理命令（支援的命令見下方列表） |
| `/api/devices/:id/app-lock` | POST | 啟用單 App 模式（將裝置加入 App Lock Profile scope） |
| `/api/devices/:id/app-lock` | DELETE | 停用單 App 模式（將裝置從 App Lock Profile scope 移除） |

**支援的管理命令（POST /api/devices/:id/command）：**

| 命令 | 說明 | 額外參數 |
|------|------|----------|
| `DEVICE_LOCK` | 鎖定裝置螢幕 | - |
| `ERASE_DEVICE` | 清除裝置所有內容 | - |
| `CLEAR_PASSCODE` | 清除密碼（需 Supervised） | - |
| `DEVICE_INFORMATION` | 更新裝置庫存資訊 | - |
| `RESTART_DEVICE` | 重新啟動裝置 | - |
| `SHUT_DOWN_DEVICE` | 關機 | - |
| `ENABLE_LOST_MODE` | 啟用遺失模式 | `lostModeMessage`、`lostModePhone`、`lostModeFootnote`（均為可選） |
| `DISABLE_LOST_MODE` | 停用遺失模式 | - |

**遺失模式範例：**

```bash
# 啟用遺失模式
curl -X POST http://localhost:3000/api/devices/1/command \
  -H "Content-Type: application/json" \
  -d '{
    "command": "ENABLE_LOST_MODE",
    "lostModeMessage": "此裝置已被管理員鎖定",
    "lostModePhone": "010-12345678",
    "lostModeFootnote": "請聯繫管理員解鎖"
  }'

# 停用遺失模式
curl -X POST http://localhost:3000/api/devices/1/command \
  -H "Content-Type: application/json" \
  -d '{"command": "DISABLE_LOST_MODE"}'
```

## 單 App 模式（App Lock）配置

### 前提條件

- 裝置必須是 **Supervised** 模式
- 目標 App 已安裝到裝置上

### 配置步驟

**步驟 1：在 Jamf Pro UI 建立 Configuration Profile**

> ⚠️ `com.apple.app.lock` payload 無法透過 API 建立，只能透過 Jamf Pro Web UI。

1. 登入 Jamf Pro → **Devices → Configuration Profiles → + New**
2. **General** 設定：
   - Name: 自定義名稱（如 `SPA`）
   - Level: `Device Level`
   - Distribution Method: `Install Automatically`
   - Security: `Never`（防止 Profile 被手動移除）
3. 左側選擇 **Single App Mode (App Lock)**
4. App Bundle ID 填入目標 App 的 Bundle ID（如 `com.aspira.agent.app`）
5. **Scope 指向步驟 2 建立的 Static Group**（不直接指向裝置）
6. 點選 **Save**

**步驟 2：建立 Static Group**

透過 API 或 UI 建立一個 Static Mobile Device Group，作為 App Lock 的開關：

```bash
curl -X POST "${JAMF_BASE_URL}/JSSResource/mobiledevicegroups/id/0" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: text/xml; charset=utf-8" \
  -H "Accept: application/xml" \
  -d '<mobile_device_group>
  <name>App Lock Devices</name>
  <is_smart>false</is_smart>
</mobile_device_group>'
```

記下群組 ID，填入 `.env` 的 `JAMF_APP_LOCK_GROUP_ID`。
然後將步驟 1 的 Profile scope 綁定到此群組。

**步驟 2：透過 API 開關單 App 模式**

啟用（將裝置加入 Profile scope）：

```bash
curl -X POST http://localhost:3000/api/devices/1/app-lock
# 返回: {"ok": true, "action": "enabled"}
```

停用（將裝置從 Profile scope 移除）：

```bash
curl -X DELETE http://localhost:3000/api/devices/1/app-lock
# 返回: {"ok": true, "action": "disabled"}
```

### 底層原理

API 透過 Classic API 操作 Static Group 成員來實現開關（增量操作，不影響其他裝置）：

```
啟用: PUT /JSSResource/mobiledevicegroups/id/{groupId}
      → mobile_device_additions 加入裝置
      → Jamf 自動推送 App Lock Profile → 裝置進入單 App 模式

停用: PUT /JSSResource/mobiledevicegroups/id/{groupId}
      → mobile_device_deletions 移除裝置
      → Jamf 自動移除 App Lock Profile → 裝置恢復正常

每次操作後自動發送 Blank Push 加速裝置簽入。
```

## 注意事項

1. **SSO 限制**: Federated User 無法透過使用者名稱/密碼獲取 API Token，必須使用 Client Credentials 或本地標準賬戶
2. **Token 過期**: Client Credentials Token 有效期 30 分鐘，Bearer Token 有效期 20 分鐘，需要在過期前重新整理
3. **許可權管理**: 當前 `Full Access Admin` Role 包含全部 520 個許可權，生產環境建議按最小許可權原則建立專用 Role
4. **Classic API**: 舊版 API 的 Basic Auth 認證方式將來可能被廢棄，建議優先使用 Jamf Pro API + Client Credentials
5. **速率限制**: Jamf Cloud 例項有 API 速率限制，大量請求時需注意控制頻率

## 疑難排解

### MDM 命令返回 403 INVALID_PRIVILEGE

**症狀**：呼叫 `POST /api/v2/mdm/commands` 發送裝置命令（如 DEVICE_LOCK、DEVICE_INFORMATION）時返回：

```json
{
  "httpStatus": 403,
  "errors": [{"code": "INVALID_PRIVILEGE", "description": "Forbidden", "id": "0", "field": null}]
}
```

**根因**：API Role 缺少 `View MDM command information in Jamf Pro API` 許可權。

Jamf Pro v2 MDM 命令端點需要**兩個**許可權同時開啟：

| 許可權 | 作用 |
|--------|------|
| `Send MDM command information in Jamf Pro API` | 允許透過 API **發送** MDM 命令 |
| `View MDM command information in Jamf Pro API` | 允許透過 API **存取** MDM 命令端點 |

即使 Role 名稱顯示為 "Full Access Admin"，實際許可權數量可能不足 520 個（例如 UI 手動勾選遺漏）。

**排查步驟**：

```bash
# 1. 檢查 Role 實際許可權數量
curl -s -H "Authorization: Bearer ${TOKEN}" \
  "https://your-instance.jamfcloud.com/api/v1/api-roles/{roleId}" | jq '.privileges | length'
# 若小於 520，說明有遺漏

# 2. 查看缺少哪些許可權
AVAILABLE=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "https://your-instance.jamfcloud.com/api/v1/api-role-privileges" | jq -r '.privileges[]' | sort)
ASSIGNED=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "https://your-instance.jamfcloud.com/api/v1/api-roles/{roleId}" | jq -r '.privileges[]' | sort)
diff <(echo "$AVAILABLE") <(echo "$ASSIGNED") | grep "^<" | sed 's/^< //'

# 3. 補全許可權（參見步驟 2 的「更新已有 Role」方法）
```

**實際案例**：甲方 tnmdm 例項的 "Full Access Admin" Role 僅有 465/520 個許可權，缺少 `View MDM command information in Jamf Pro API` 等 55 個許可權。透過 API 補全至 520 個後，MDM 命令恢復正常。

> 💡 **注意**：修改 Role 許可權後，需要重新獲取 Token（舊 Token 仍攜帶舊的 scope），新 Token 才會包含更新後的許可權。

### MDM 命令返回 500 Unable to perform MDM operation

**症狀**：命令已成功授權（非 403），但返回 500 錯誤。

**可能原因**：
- 裝置離線或未連接網路
- 裝置的 MDM Profile 已過期或損壞
- 裝置的 Push Certificate 配置異常
- 該命令需要裝置為 Supervised 模式（如 CLEAR_PASSCODE）

**排查**：先嘗試 `DEVICE_LOCK`（要求最低），若成功則說明 MDM 通道正常，問題在於特定命令的前置條件
