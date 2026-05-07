# Windows MDM 快速上手（30 分鐘）

> 給新接手工程師。從 0 到「Win10 真機加入自建 MDM + 裝上 demo 應用 + inventory 反查」全流程。

## 前置條件

| 項目 | 要求 |
|---|---|
| 開發機 | macOS / Linux / Windows，裝 [Deno](https://deno.land) ≥ 1.40（含 `--unstable-http` 支援） |
| 公網暴露 | [ngrok](https://ngrok.com) 帳戶（免費版即可）或 Cloudflare Tunnel |
| 測試 Win10 | Win10 22H2 **Pro/Enterprise/Education**（**Home 不支援 MDM**），可被加入工作或學校帳戶；裝 Windows 10 SDK（用來生成簽名 demo MSIX） |
| 帳戶配置 | `.env` 已配 WNS_PACKAGE_SID / WNS_CLIENT_SECRET / WNS_PFN（見 [windows-mdm-account-setup.md](./windows-mdm-account-setup.md)） |

## 流程總覽

```
①  clone repo + .env 配好
②  deno task dev 起後端 + ngrok 暴露公網
③  Win10 GUI：設定 → 帳戶 → 存取公司或學校資源 → 連線
④  輸入 enrollment URL（指向 ngrok / Discovery.svc）
⑤  發 inventory query → 確認 mdm_windows_apps 有資料
⑥  生成簽名 demo MSIX → 派送 install → device 自動 5-15 分鐘內裝上
   （或者 push-config 後 enqueue 命令自動 ~10 秒觸發）
```

---

## 第 1 步：起後端

```bash
git clone <repo> jamf_explore && cd jamf_explore
cp .env.example .env  # 填寫 WNS_* 凭据等
deno task dev          # 起在 http://localhost:3000
```

**驗證**：
```bash
curl http://localhost:3000/api/mdm/win/devices
# 預期 {"devices":[]}（空列表，正常）
```

## 第 2 步：暴露公網

開發期推薦 ngrok：
```bash
ngrok http 3000 --request-header-remove="Accept-Encoding"
```

拿到 URL 如 `https://succinctly-ashless-thuy.ngrok-free.dev`。

> ⚠️ ngrok URL 每次重啟可能變。Win10 enrollment 時記住的是當時的 URL，若 ngrok URL 變化舊 enrollment 會失效。生產環境用固定域名（見 [windows-mdm-production-deployment.md](./windows-mdm-production-deployment.md)）。

## 第 3 步：Win10 加入 MDM

詳細 GUI 操作見 [windows-mdm-enrollment-guide.md](./windows-mdm-enrollment-guide.md) 第 2 步。簡版：

設定 → 帳戶 → **存取公司或學校資源** → 鏈接工作或學校帳戶 → **僅註冊到設備管理**（右欄選項，不是「加入」）→ 任意郵箱 → enrollment URL 填：
```
https://<ngrok-url>/EnrollmentServer/Discovery.svc
```

成功後 GUI 顯示「已連接到 Aspira-XXX MDM」。後端 log 會看到：
```
[Win MDM] Enrolled: deviceId=... udid=windows-...
```

## 第 4 步：發 inventory query 驗證命令通道

```bash
UDID=$(curl -s http://localhost:3000/api/mdm/win/devices | jq -r '.devices[0].udid')
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/refresh
```

**等 device 自動 poll**（默認 5-60 分鐘，第一次 enrollment 後通常更快）。

驗證：
```bash
sqlite3 data/agent_reports.db "SELECT COUNT(*) FROM mdm_windows_apps WHERE device_udid='$UDID';"
# 預期 80+ 條應用記錄
```

> 如果遲遲拿不到應用清單：發 `/poll-config` 把 polling 縮短到 5 分鐘（見 第 6 步）。

## 第 5 步：生成簽名 demo MSIX

詳見 [docs/scripts/README.md](./scripts/README.md)。簡版：

```bash
# 在 Win10 上跑（透過 SSH）：
B64=$(python3 -c "import base64; print(base64.b64encode(open('docs/scripts/build-msix.ps1','r').read().encode('utf-16-le')).decode())")
ssh -i ~/.ssh/win10_mdm_test AHS@<win10-ip> "powershell -EncodedCommand $B64"
# 拿到輸出中的 MSIX_PATH，scp 回本地：
scp ... AHS@<win10-ip>:/Temp/AspiraMdmDemo-1.0.msix data/test/
```

派送 install：
```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/apps/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageFamilyName": "AspiraMDM.Demo_cmnaf4m6btwng",
    "contentUri": "https://<ngrok-url>/test/AspiraMdmDemo-1.0.msix"
  }'
```

device 拉到後在開始選單會出現「Aspira MDM Demo」應用（藍色圖示）。

## 第 6 步：縮短 polling 間隔（可選但推薦）

默認 polling 8 小時太久。改 5 分鐘密集 + 15 分鐘穩態：

```bash
curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/poll-config \
  -H "Content-Type: application/json" \
  -d '{"intervalFirst":5,"countFirst":8,"intervalRest":15}'
```

device 套用後**最遲 5 分鐘內自動 poll**，再也不用手動同步。

## 第 7 步：（進階）開啟 WNS push 秒級觸發

如果業務需要「排命令後 ≤10 秒生效」（如緊急 wipe），開 A 路徑 push：

1. 確認 `.env` 已配 WNS 凭据 + 註冊好 push-capable MSIX（PFN 必須 == `WNS_PFN`）
2. 裝該 push MSIX：用 `docs/scripts/build-push-msix-v2.ps1` 生成 + 派送
3. 配 push channel：
   ```bash
   curl -X POST http://localhost:3000/api/mdm/win/devices/$UDID/push-config -d '{}'
   ```
4. device 套用後自動上報 ChannelURI 入庫。之後任何 enqueue 命令會自動觸發 push，device **9 秒內**響應。

完整機制見 [windows-mdm-trigger-mechanism.md](./windows-mdm-trigger-mechanism.md)。

---

## 下一步閱讀

| 場景 | 文檔 |
|---|---|
| 「我要呼叫某個 API」 | [windows-mdm-api-reference.md](./windows-mdm-api-reference.md) |
| 「device 為什麼遲遲不拉命令」 | [windows-mdm-trigger-mechanism.md](./windows-mdm-trigger-mechanism.md) |
| 「上線到生產環境」 | [windows-mdm-production-deployment.md](./windows-mdm-production-deployment.md) |
| 「遇到 404/405/500/E_INVALIDARG」 | [windows-mdm-troubleshooting.md](./windows-mdm-troubleshooting.md) |
| 「DB 各個欄位什麼意思」 | [windows-mdm-data-model.md](./windows-mdm-data-model.md) |
| 「MSIX 為什麼裝不上」 | [windows-mdm-msix-signing.md](./windows-mdm-msix-signing.md) |
