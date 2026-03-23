# 裝置繫結步驟：將 iPad 加入 ABM 並註冊到 Jamf Pro

## 前提條件

以下配置必須已完成（僅需一次）：

| 配置項 | 狀態 | 說明 |
|--------|------|------|
| APNs Push Certificate | ✅ | 有效期至 2027-03-17 |
| ABM 連線 Jamf Pro (ADE) | ✅ | ADE 例項: Jamf Pro - Cogrow |
| PreStage Enrollment | ✅ | Default iPad Enrollment（已開啟自動分配新裝置）|

---

## 繫結流程

### 第一步：獲取裝置序列號

在 iPad 上檢視：**Settings > General > About > Serial Number**

或檢視裝置背面/包裝盒上的序列號。

### 第二步：將裝置新增到 Apple Business Manager

#### 方法 A：使用 Mac 上的 Apple Configurator 2

**前提**：
- Mac 已安裝 [Apple Configurator 2](https://apps.apple.com/app/apple-configurator-2/id1037126344)（Mac App Store 免費）
- 準備一根 USB-C 或 Lightning 資料線

**操作步驟**：

1. **抹掉 iPad**
   - 進入 Settings > General > Transfer or Reset iPad > **Erase All Content and Settings**
   - 確認並等待重啟

2. **iPad 停在 Setup Assistant**
   - 重啟後顯示 Hello 介面
   - 選擇語言、地區
   - 連線 Wi-Fi
   - **停在此處，不要繼續**

3. **USB 連線 Mac**
   - 用資料線將 iPad 連線到 Mac

4. **開啟 Apple Configurator 2**
   - iPad 會出現在主介面
   - 如果首次使用，需要在 Preferences > Organization 中登入 ABM 管理員賬號

5. **新增到 ABM**
   - 選中 iPad
   - 選單欄選擇 **Prepare**，或右鍵選擇 **Add to Apple Business Manager**
   - 按照嚮導完成（可能需要填寫 MDM 伺服器資訊）

6. **驗證**
   - 登入 [business.apple.com](https://business.apple.com) > Devices
   - 搜尋裝置序列號，確認已出現

#### 方法 B：使用 iPhone 上的 Apple Configurator App

**前提**：
- iPhone 已安裝 [Apple Configurator](https://apps.apple.com/app/apple-configurator/id1588040660) App
- iPhone 和 iPad 在同一 Wi-Fi 網路

**操作步驟**：

1. 抹掉 iPad（同方法 A 第 1 步）
2. iPad 停在 Setup Assistant 並連線 Wi-Fi（同方法 A 第 2 步）
3. 開啟 iPhone 上的 Apple Configurator App
4. 用 ABM 管理員賬號登入
5. 將 iPhone 靠近 iPad，App 會自動發現裝置
6. 按提示完成新增

### 第三步：在 ABM 中分配裝置給 Jamf MDM Server

1. 登入 [business.apple.com](https://business.apple.com)
2. 進入 **Devices**
3. 搜尋 iPad 序列號
4. 點選裝置
5. 將 **MDM Server** 修改為 **"Jamf Pro - Cogrow"**
6. 儲存

### 第四步：在 Jamf Pro 中分配裝置到 PreStage Enrollment

> 如果 PreStage 已開啟 "Automatically assign new devices"，新裝置會自動分配。
> 如果裝置在建立 PreStage 之前已新增到 ABM，需要手動分配。

**自動分配**：等待 Jamf Pro 自動同步（通常幾分鐘），裝置會自動出現在 PreStage 的 Scope 中。

**手動分配**：

1. 登入 Jamf Pro
2. 進入 **Devices > Enrollment > PreStage Enrollments**
3. 點選 **Default iPad Enrollment**
4. 切換到 **Scope** 標籤
5. 點選右下角 **Edit**
6. 勾選目標裝置的複選框
7. 點選 **Save**
8. 裝置狀態變為 **"Assigned - Pending Sync"**

### 第五步：在 iPad 上完成註冊

1. 確保 iPad 處於 **Setup Assistant（Hello 介面）**
   - 如果已經設定過，需要重新抹掉：Settings > General > Transfer or Reset iPad > Erase All Content and Settings
2. 選擇語言和地區
3. **連線 Wi-Fi**（必須聯網）
4. iPad 會自動從 ABM 獲取 MDM 配置
5. 出現 **"Remote Management"** 提示，顯示由你的組織管理
6. 按提示繼續完成 Setup Assistant
7. 註冊完成！

### 第六步：驗證註冊成功

**在 Jamf Pro 中驗證**：

1. 進入 **Devices > Search inventory**
2. 搜尋裝置序列號
3. 裝置應顯示在列表中，狀態為 Managed

**透過 API 驗證**：

```bash
source .env
TOKEN=$(curl -s -X POST "${JAMF_BASE_URL}/api/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${JAMF_CLIENT_ID}&client_secret=${JAMF_CLIENT_SECRET}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# 檢視已註冊裝置
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "${JAMF_BASE_URL}/api/v2/mobile-devices" | python3 -m json.tool
```

**在 iPad 上驗證**：

- 進入 Settings > General > VPN & Device Management
- 應顯示 MDM Profile，來源為你的組織

---

## 實際操作記錄

### 已繫結裝置

| 序列號 | 型號 | 描述 | 新增時間 |
|--------|------|------|----------|
| JHNWY39N9M | iPad (9th Generation) | IPAD WI-FI 64GB SPACE GRAY-CHN | 2026-03-17 |

---

## 故障排除

| 問題 | 解決方案 |
|------|----------|
| iPad 在 Setup Assistant 中沒有收到 MDM Profile | 檢查 ABM 中裝置是否已分配給 "Jamf Pro - Cogrow" MDM Server |
| Jamf Pro 中看不到裝置 | 檢查 ADE 同步狀態，手動重新整理 Automated Device Enrollment 頁面 |
| 裝置狀態一直是 "Pending Sync" | 等待幾分鐘讓 Jamf Pro 完成同步，或重新登入 Jamf Pro 觸發同步 |
| iPad 已經過了 Setup Assistant | 需要重新抹掉裝置，重新走 Setup Assistant 才能觸發 ADE 註冊 |
| Apple Configurator 無法發現 iPad | 確保 iPad 處於 Setup Assistant 介面且已連線 Wi-Fi / USB |
| ABM 中搜不到裝置 | 等待幾分鐘後重新整理，Apple Configurator 新增需要時間同步到 ABM |
