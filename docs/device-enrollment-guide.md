# iPad 設備註冊指南：ABM + Jamf Pro

## 前提條件

| 專案 | 狀態 |
|------|------|
| Jamf Pro 例項 | cogrow.jamfcloud.com (v11.25.2) |
| Apple Business Manager 賬戶 | 已有 |
| APNs Push Certificate | ✅ 已配置（有效期至 2027-03-17） |
| 裝置 | iPad（可抹掉） |

---

## 第一階段：配置 APNs Push Certificate

APNs (Apple Push Notification service) 證書是所有 MDM 功能的基礎，沒有它 Jamf Pro 無法向裝置傳送管理命令。

### 操作步驟

1. 登入 Jamf Pro，進入 **Settings > Global > Push certificates**
2. 點選 **Create push certificate**
3. 在彈出頁面中選擇 **Download Signed CSR**，儲存 CSR 檔案
4. 開啟 [Apple Push Certificates Portal](https://identity.apple.com/pushcert/)
   - 使用 Apple ID 登入（**重要：記住此 Apple ID，續期時必須使用同一個**）
   - 點選 **Create a Certificate**
   - 同意條款
   - 點選 **Choose File**，上傳剛下載的 Signed CSR 檔案
   - 點選 **Upload**
   - 等待處理完成後，點選 **Download** 下載 `.pem` 證書檔案
5. 回到 Jamf Pro 的 Push certificates 頁面
   - 點選 **Upload** 上傳剛下載的 `.pem` 檔案
6. 驗證：頁面顯示證書有效，Expiration 日期為 1 年後

### 驗證命令

```bash
source .env
TOKEN=$(curl -s -X POST "${JAMF_BASE_URL}/api/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${JAMF_CLIENT_ID}&client_secret=${JAMF_CLIENT_SECRET}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# 檢查 Push Certificate 狀態
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "${JAMF_BASE_URL}/api/v1/apns-client-push-status" | python3 -m json.tool
```

---

## 第二階段：將 Jamf Pro 連線到 ABM

配置 Automated Device Enrollment (ADE)，讓 ABM 中的裝置自動註冊到 Jamf Pro。

### 操作步驟

#### A. 從 Jamf Pro 下載公鑰
1. 登入 Jamf Pro
2. 進入 **Settings > Global > Automated Device Enrollment**
3. 點選 **Download Public Key**，儲存 `.pem` 公鑰檔案

#### B. 在 ABM 中新增 MDM Server
1. 登入 [business.apple.com](https://business.apple.com)
2. 點選底部側邊欄 **Settings**
3. 點選 **Device Management Settings** > **Add MDM Server**
4. 輸入名稱：`Jamf Pro - Cogrow`
5. 上傳 Jamf Pro 的公鑰 `.pem` 檔案
6. 點選 **Save**
7. 點選 **Download Token**，儲存 `.p7m` 檔案

#### C. 在 Jamf Pro 上傳 Token
1. 回到 Jamf Pro 的 **Automated Device Enrollment** 頁面
2. 點選 **Upload Server Token File**
3. 上傳從 ABM 下載的 `.p7m` 檔案
4. 驗證連線成功（顯示 ABM 組織名稱）

### 驗證命令

```bash
# 檢查 ADE 配置
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "${JAMF_BASE_URL}/api/v1/device-enrollments" | python3 -m json.tool
```

---

## 第三階段：將 iPad 新增到 ABM

### 使用 iPhone 上的 Apple Configurator App

#### 前提
- iPad 執行 iPadOS 16.0 或更高版本
- iPhone 已安裝 [Apple Configurator](https://apps.apple.com/app/apple-configurator/id1588040660) App
- iPhone 和 iPad 都連線到 Wi-Fi
- ABM 賬戶具有"設備註冊管理員"或"管理員"許可權

#### 操作步驟

1. **抹掉 iPad**
   - 進入 Settings > General > Transfer or Reset iPad
   - 點選 **Erase All Content and Settings**
   - 確認並等待 iPad 重啟

2. **iPad 停在 Setup Assistant**
   - iPad 重啟後顯示 Hello 介面
   - 選擇語言和地區
   - 連線 Wi-Fi
   - **停在此處，不要繼續設定**

3. **使用 iPhone 新增到 ABM**
   - 開啟 iPhone 上的 Apple Configurator App
   - 用 ABM 管理員賬號登入
   - 將 iPhone 靠近 iPad
   - Apple Configurator 會自動發現 iPad
   - 按照螢幕提示完成新增

4. **在 ABM 中分配裝置**
   - 登入 [business.apple.com](https://business.apple.com)
   - 進入 **Devices**
   - 搜尋 iPad 序列號
   - 點選裝置，將 **MDM Server** 修改為 `Jamf Pro - Cogrow`

---

## 第四階段：建立 PreStage Enrollment 並完成註冊

### 建立 PreStage Enrollment

1. 登入 Jamf Pro
2. 進入 **Devices > Enrollment > PreStage Enrollments**
3. 點選 **+ New**
4. 配置以下選項：

| 設定 | 推薦值 |
|------|--------|
| Display Name | Default iPad Enrollment |
| Automatically assign new devices | ✓ 勾選 |
| Require Authentication | 根據需要 |
| Prevent MDM Profile Removal | ✓ 勾選 |
| Supervised | ✓ 勾選 |

5. 配置 **Setup Assistant** 跳過選項（建議跳過）：
   - Location Services
   - Restore
   - Apple ID
   - Terms and Conditions
   - Siri
   - Diagnostics
   - 等

6. 儲存

### 同步並完成註冊

1. 在 Jamf Pro 中手動同步：**Settings > Global > Automated Device Enrollment > Sync**
2. 驗證 iPad 出現在 PreStage 的裝置列表中
3. **在 iPad 上繼續 Setup Assistant**
   - 確保 iPad 連線到 Wi-Fi
   - iPad 會自動從 ABM 獲取 Jamf MDM Profile
   - 按照提示完成註冊
4. Setup Assistant 完成後，iPad 出現在 Jamf Pro Inventory

### 驗證命令

```bash
# 檢查 PreStage
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "${JAMF_BASE_URL}/api/v2/mobile-device-prestages" | python3 -m json.tool

# 檢查已註冊裝置
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "${JAMF_BASE_URL}/api/v2/mobile-devices" | python3 -m json.tool
```

---

## 注意事項

1. **證書續期**
   - APNs Push Certificate：有效期 1 年，續期必須用同一個 Apple ID
   - ABM Server Token：有效期 1 年
   - 建議在日曆中設定提前 30 天的續期提醒

2. **網路要求**
   - iPad 在 Setup Assistant 階段必須聯網
   - 需要能訪問 Apple 和 Jamf 的伺服器（確保防火牆放行）

3. **故障排除**
   - 如果 iPad 未收到 MDM Profile：檢查 ABM 中裝置是否已分配給正確的 MDM Server
   - 如果同步失敗：檢查 Server Token 是否過期
   - 如果 iPad 已經過了 Setup Assistant：需要重新抹掉重來
