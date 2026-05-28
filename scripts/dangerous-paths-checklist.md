# 危險路徑真機測試 Checklist（W4 task 17）

> handoff 2026-05-28 §「W3 待辦」明列：
> task 17 危險路徑真機測——transfer Wipe / DELETE 解纳管 / POST commands LOCK\|WIPE\|REBOOT /
> OMA-DM ack→webhook 全鏈路；需建 dummy device 避免誤 Wipe task 57 真機。

## 前置條件

```bash
export API_BASE="https://succinctly-ashless-thuy.ngrok-free.dev"   # 或 http://localhost:3000
export ADMIN_TOKEN="..."                                            # 從 .env / KMS
export TENANT_ID="..."                                              # task 57 真機所在 tenant 同 ID

# 1. 建 dummy device（Mac / Win10 任一平台）
deno run -A --env-file=.env scripts/dummy-device.ts create \
  --tenant "$TENANT_ID" \
  --platform windows \
  --name "DUMMY-WIN-DANGEROUS"

# 假設拿到 DUMMY_DEVICE_ID（從 JSON output 的 id 欄位）
export DUMMY_DEVICE_ID="..."

# 2. 確認 dummy 不會誤觸真機（透過 udid prefix DUMMY-* 識別）
deno run -A --env-file=.env scripts/dummy-device.ts list --tenant "$TENANT_ID"
```

## 17 條危險路徑（順序：先讀後寫，先 dummy 後真機）

每條格式：
- **#X**：行為描述
- **Curl**：複製貼上模板
- **預期**：HTTP code + 關鍵 response 欄位 + 副作用
- **Dummy 防護**：dummy device 上跑時的安全屬性
- **真機核心**：必須在真機跑才能 100% 驗證的部分（標 ⚠️ 後留下次 session）

---

### #1 GET 設備詳情（基線，dummy ↔ 真機都應 200）
```bash
curl -s "$API_BASE/api/v1/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```
- **預期**：200，回 device row（含 `enrollmentType: "dummy"`）
- **Dummy 防護**：純讀，無副作用
- **真機核心**：核 Jamf detail 回傳 ⚠️

---

### #2 GET 命令歷史（基線）
```bash
curl -s "$API_BASE/api/v1/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID/commands?page=1&limit=10" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```
- **預期**：200，`{ data: [], meta: { total: 0 } }`（dummy 還沒下過命令）

---

### #3 POST commands DeviceLock（Apple/iOS）
```bash
curl -s -X POST "$API_BASE/api/v1/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID/command" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commandType": "DeviceLock", "payload": {"Message": "Lost"}}' | jq
```
- **預期**：202 + commandUuid（mdm_commands 新 row）
- **Dummy 防護**：APNS push 必失敗（假 pushToken），但 enqueue 成功
- **真機核心**：真機收到 lock + 顯示訊息 ⚠️

---

### #4 POST commands EraseDevice（Apple/iOS 全資料抹除）⚠️ 最高風險
```bash
# DUMMY device 跑：
curl -s -X POST "$API_BASE/api/v1/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID/command" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commandType": "EraseDevice", "payload": {"PreserveDataPlan": true}}' | jq
```
- **預期**：202 + commandUuid
- **Dummy 防護**：udid=DUMMY-APPLE-*，APNS BadDevice，命令落表但永不送達
- **真機核心**：⚠️ **嚴禁對 task 57 真機跑**；如要驗證，先確認 device id ≠ task 57

---

### #5 POST commands Restart
```bash
curl -s -X POST "$API_BASE/api/v1/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID/command" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commandType": "Restart"}' | jq
```
- **預期**：202 + commandUuid

---

### #6-8 Windows MDM Lock / Wipe / Reboot（透過自建 MDM 路徑）

Windows 命令走 `/api/mdm/devices/{udid}/command`，需要 udid 而非 internal device id。
從 #1 取 dummy 的 `udid`：

```bash
export DUMMY_UDID="DUMMY-WIN-..."  # 從 dummy-device.ts create 輸出

# Lock（透過 RemoteLock CSP 或 Reboot 替代）
curl -s -X POST "$API_BASE/api/mdm/devices/$DUMMY_UDID/command" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commandType": "RemoteLock"}' | jq

# Wipe ⚠️
curl -s -X POST "$API_BASE/api/mdm/devices/$DUMMY_UDID/command" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commandType": "doWipe"}' | jq

# Reboot
curl -s -X POST "$API_BASE/api/mdm/devices/$DUMMY_UDID/command" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commandType": "RebootNow"}' | jq
```
- **預期**：每條 202 + commandUuid（落 mdm_commands）
- **Dummy 防護**：WNS push 對 dummy channel URI 失敗
- **真機核心**：真機 OMA-DM session 拉命令 + 執行 ⚠️

---

### #9 自建 MDM /api/mdm/devices/{udid}/push（APNS / WNS 手動觸發）
```bash
curl -s -X POST "$API_BASE/api/mdm/devices/$DUMMY_UDID/push" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```
- **預期**：200/202；dummy 上預期 push 失敗但端點仍 ack 接收

---

### #10 POST 批次命令 /api/mdm/commands/bulk
```bash
curl -s -X POST "$API_BASE/api/mdm/commands/bulk" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"udids\": [\"$DUMMY_UDID\"], \"commandType\": \"RebootNow\"}" | jq
```
- **預期**：每 udid 各一 commandUuid

---

### #11 transfer / 學期硬轉校（admin Wipe + 解纳管 + 再 enroll）⚠️ 真實 Wipe
```bash
curl -s -X POST "$API_BASE/api/v1/admin/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID/transfer" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetDeviceGroupId": "00000000-0000-0000-0000-000000000000"}' | jq
```
- **預期**：202 + 後續工作流（assignments 移除 + EraseDevice 排隊）
- **Dummy 防護**：targetDeviceGroupId 用一個 dummy group（先建好）
- **真機核心**：跑完後設備真重置 ⚠️

---

### #12 DELETE 解纳管 `/api/v1/tenants/{tid}/devices/{id}`
```bash
curl -s -X DELETE "$API_BASE/api/v1/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```
- **預期**：204，DB row 刪除（或標 deleted）；relationships cascade 清
- **Dummy 防護**：刪 dummy 不影響真機

---

### #13 OMA-DM ack→webhook 全鏈（Windows 真設備拉命令 + ack）

⚠️ 純真機驗證——dummy windowsDeviceId/channelUri 無法收 WNS push。

模擬手段：拿一台**真實但隔離的** Win10 設備（如閒置 VM），enroll 後手動測。或：
```bash
# 不真送 push，直接以 device 身分模擬 SyncML PUT 觸發 webhook：
curl -s -X PUT "$API_BASE/api/mdm/command" \
  -H "Content-Type: application/vnd.syncml.dm+xml" \
  --data-binary @scripts/syncml-ack-sample.xml | jq
```
（需另寫 syncml-ack-sample.xml 模擬 device 完整 ack；參考 [[w2-oma-dm-webhook-events]]）

---

### #14 POST profile/assign（無危險，但驗證 push 鏈）
```bash
# 先建一個 W4 preset：
PROFILE_ID=$(curl -s -X POST "$API_BASE/api/v1/admin/tenants/$TENANT_ID/profile-presets/blocked-sites" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"displayName": "test-blocklist", "hosts": ["evil.example.com"], "status": "active"}' \
  | jq -r .data.id)

# 派到 dummy device：
curl -s -X POST "$API_BASE/api/v1/admin/tenants/$TENANT_ID/profiles/$PROFILE_ID/assign" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"scope\": \"device\", \"deviceId\": \"$DUMMY_DEVICE_ID\"}" | jq
```
- **預期**：201 + assignment row；push 排隊（dummy 永遠 pending）

---

### #15 DELETE profile assignment（解除指派）
```bash
ASSIGNMENT_ID="..."  # 從 #14 拿
curl -s -X DELETE "$API_BASE/api/v1/admin/tenants/$TENANT_ID/profiles/$PROFILE_ID/assignments/$ASSIGNMENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
- **預期**：204，profile_assignments status=removed；publishProfileRemoved 觸發

---

### #16 POST compliance/evaluate（即時評估，無副作用）
```bash
curl -s -X POST "$API_BASE/api/v1/admin/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID/compliance/evaluate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "id": "p1",
      "name": "Win10 baseline",
      "minOSVersion": "10.0.19045.0",
      "maxOfflineDays": 7
    }
  }' | jq
```
- **預期**：200 + ComplianceResult（dummy lastSeenAt 是 created time，<7 天合規）

---

### #17 POST install-agent（一鍵派發 MSI；真機才能 install）⚠️
```bash
curl -s -X POST "$API_BASE/api/v1/admin/tenants/$TENANT_ID/devices/$DUMMY_DEVICE_ID/install-agent" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```
- **預期**：202 + agentToken + jobId
- **Dummy 防護**：MSI 不會真裝（dummy 無 channelUri）；token 寫 DB OK
- **真機核心**：MSI 真裝 + agent 開始上報 ⚠️

---

## 結束清理

```bash
deno run -A --env-file=.env scripts/dummy-device.ts clear --tenant "$TENANT_ID"
```

## 留給下次 Win10/Apple 真機 session 的 ⚠️ 條目

需要真機才能完整驗證：#3 #4 #5 #6 #7 #8 #11 #13 #17。建議流程：
1. 確認可受測真機編號 ≠ task 57（task 57 = 業主主力測試機）
2. 先 backup 真機資料
3. 跑 #3 #5 #6 #8（lock / restart / reboot，非破壞）
4. 確認 ack → mdm_commands status 從 sent → acked
5. 最後再評估是否跑 #4 #7 #11（Wipe），需業主明確授權
