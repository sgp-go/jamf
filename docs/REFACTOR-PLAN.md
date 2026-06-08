# 產品化重構方案（Productization Refactor Plan）

> 起草日：2026-05-15
> 目標：將 PoC 階段的 `src/`（Deno + Hono + SQLite + 單租戶 env 配置）演進為可商用的多租戶 SaaS 後端

## 1. 決策摘要（TL;DR）

| 維度 | PoC 現狀 | 產品化目標 | 理由 |
|---|---|---|---|
| Runtime | Deno + `--unstable-http` | **Node 22 LTS + tsx** | drizzle-kit / pnpm / 各類部署平台一等公民 |
| Web 框架 | Hono (`jsr:@hono/hono`) | Hono (`npm:hono`) + `@hono/node-server` | 沿用 API，避免重寫 |
| ORM / DB | `jsr:@db/sqlite` + 手寫 SQL | **Drizzle ORM + node-postgres** | 型別安全的 schema-first DSL，產品化遷移工具齊全 |
| 入參驗證 | 無 / 手寫 type guard | **Zod + `@hono/zod-openapi`** | schema 同時當 validator、TypeScript 型別、OpenAPI 3.1 來源 |
| API 文件 | 手寫 markdown | `@hono/zod-openapi` + **`@scalar/hono-api-reference`** | `/openapi.json` 自動產生，`/docs` 提供互動式 UI（Scalar 比 Swagger UI 現代） |
| 多租戶 | env 單組憑據 | **DB 驅動租戶配置** | device_group N → ASM N → Jamf 1..N 的對應 |
| 機密儲存 | `.env` + `certs/` 檔案 | DB 加密欄位（envelope encryption）+ 物件儲存 | 同一台後端服務多客戶共用 |

> APNS HTTP/2 長連線在 Node 上由 `http2` 內建，無需 `--unstable-http`；Apple-MDM 用的 client cert 透過 `node:tls` 的 `ca/cert/key` 傳入即可。

## 2. 多租戶領域模型

```
tenant              // 一個產品客戶（通常 = 一個學區 / 教育局 / 廠商簽約方）
 ├─ device_group    // 設備分組單位（操作員可見性邊界 + 批次派送單位）
 │   └─ device      // 設備（指向所屬 jamf_instance 或自建 mdm）
 │
 ├─ jamf_instance   // Jamf Pro 實例（1 tenant 可以有 0..N 個）
 │   ├─ base_url, client_id, client_secret(encrypted)
 │   └─ scope: 哪些 device_group 透過這個實例管理
 │
 ├─ asm_instance    // Apple School Manager（1 tenant 可以有 0..N 個）
 │   └─ dep_token   // DEP token（.p7m 解出來後存的 OAuth 憑據）
 │
 └─ mdm_config      // 自建 MDM 配置（tenant 級別共用一份 CA + APNS）
     ├─ ca_cert, ca_key(encrypted)
     ├─ apns_cert, apns_key(encrypted), apns_topic
     └─ public_base_url（對外暴露給設備的 HTTPS endpoint）
```

### 設計考量
- **設備可同時被 Jamf 與自建 MDM 管理**（遷移過渡期）：`mdm_devices.jamf_instance_id` 與 `mdm_devices.self_mdm_managed` 並存
- **跨 tenant 隔離**：所有 query 一律以 `tenant_id` 為第一條件；service 層強制注入 `tenantId` context
- **APNS topic 唯一性**：自建 MDM 在 Apple Push Certificate Portal 上每張憑證對應一個 topic，因此 `mdm_config` 與 `apns_*` 1:1
- **DEP token 過期**：`dep_tokens.expires_at` index，到期前 7 天觸發提醒任務
- **device_group 跨 tenant 共享 ASM**（少見但可能）：暫不支援，需要時用 `asm_instance.shared_with_tenant_ids[]`

## 3. 並存遷移策略

不一次性丟掉 `src/`，採用「**新舊雙寫，逐路由切換**」：

```
repo/
 ├─ src/          # 舊 Deno 程式碼，凍結（只修 critical bug）
 ├─ app/          # 新 Node + Drizzle 程式碼，feature-by-feature 重建
 ├─ docs/REFACTOR-PLAN.md
 └─ package.json  # Node 工程入口
```

### 階段
1. **Phase 1（本 worktree 範圍）** — 基礎建設
   - Node 骨架 + tsx + 雙路徑（Deno 舊服務暫不動）
   - Drizzle schema（完整多租戶模型）
   - tenant-aware JamfClient 工廠
   - Zod schema 即 validator 即 OpenAPI source（`createRoute` + `OpenAPIHono`）
   - 一條端到端範例路由：`GET /api/v1/tenants/:tenantId/jamf-instances/:instanceId/devices`
   - `/openapi.json` + `/docs`（Scalar 互動式文件）開箱即用
2. **Phase 2** — 路由遷移（依風險倒序）
   - jamf 代理（讀多寫少，最安全）
   - agent 上報 + usage（無設備互動）
   - 自建 MDM checkin/command（協議端點，需配合裝置同時驗證）
   - Windows MDM（最複雜，最後做）
3. **Phase 3** — 機密管理
   - 引入 KMS / envelope encryption，加密 client_secret / dep_token / apns_key
   - 將 `certs/*.pem` 從 filesystem 移到 DB（或 S3 + KMS）
4. **Phase 4** — 觀測 / 部署
   - Pino logger、OpenTelemetry traces、健康檢查、Docker、CI/CD

## 4. 不在本次 worktree 範圍

- 不動 `ios-agent-app/`（iOS 客戶端）
- 不動 Windows MDM 路由（先把 Apple 側收斂）
- 不做機密加密（暫時欄位明文，但已預留 schema 欄位 `_enc` 後綴）
- 不寫前端管理後台

## 5. 風險與注意

- **Deno 與 Node 雙存期間**：兩個 server 不要同時開（搶 port、搶資料）。新 server 連線同一張 Postgres，舊 SQLite 視為唯讀
- **資料遷移**：SQLite → Postgres 寫獨立 `scripts/migrate-sqlite-to-postgres.ts`（Phase 2 才做）
- **APNS 憑證**：Apple Push Certificate Portal 一個 Apple ID 上限 ~10 張憑證，多 tenant 共用 APNS 需要設計 cert pool 或讓客戶上傳自己的 .p12（傾向後者）
- **DEP token 同步**：跨 tenant 各自 cron，不能共用 schedule lock

## 6. 命名與規範

- 所有 Postgres 表 / 欄位：`snake_case`
- TypeScript 程式碼：`camelCase`
- Drizzle relations 用 `relations(...)` 顯式宣告，避免 lazy magic
- API 路徑：`/api/v1/tenants/:tenantId/...` 為標準前綴
- 錯誤格式：`{ ok: false, error: { code, message, details? } }`，成功 `{ ok: true, data }`

## 7. 本 worktree 已完成的事

| 項目 | 路徑 |
|---|---|
| Node 工程入口 | `package.json` / `tsconfig.json` / `drizzle.config.ts` |
| Drizzle schema（15 張表） | `app/db/schema/{tenants,jamf,asm,self-mdm,devices,agent,relations}.ts` |
| 初次 migration SQL | `app/db/migrations/0000_*.sql` |
| Postgres 客戶端 | `app/db/client.ts` |
| Migration runner / Seed | `app/db/migrate.ts` / `app/db/seed.ts` |
| Tenant-aware JamfClient | `app/services/jamf/client.ts`（含 DB token 快取） |
| OpenAPI + Scalar | `app/server.ts`（`/openapi.json` + `/docs`） |
| 共用 zod-openapi hook | `app/lib/openapi-hook.ts`（validation 失敗統一信封） |
| Jamf 代理 5 條 | `GET/POST/DELETE` `…/jamf-instances/{id}/devices…` |
| Agent 上報 5 條 | `…/tenants/{id}/agent/{reports,usage,devices/{serial}/…}` |
| Admin tenants CRUD 5 條 | `…/admin/tenants{,/{id}}` POST/GET/PATCH/DELETE |
| Admin jamf-instances CRUD + verify 6 條 | `…/admin/tenants/{id}/jamf-instances{,/{instanceId}}{,/verify}` |

### Admin API 鑑權與配置

```bash
# 1. 設 token（生產用 256-bit 隨機字串）
echo "ADMIN_API_TOKEN=$(openssl rand -hex 32)" >> .env

# 2. 建 tenant
curl -X POST http://localhost:3000/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"taipei-edu","displayName":"台北市教育局"}'

# 3. 把 Jamf 實例掛上去（憑證即時驗證）
TENANT_ID=...  # 上一步回傳的 id
curl -X POST "http://localhost:3000/api/v1/admin/tenants/$TENANT_ID/jamf-instances" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "displayName":"光復國小 Jamf",
    "baseUrl":"https://guangfu.jamfcloud.com",
    "clientId":"...",
    "clientSecret":"...",
    "appLockGroupId":42
  }'

# 4. 真打 OAuth 端點驗證憑證有效
INSTANCE_ID=...
curl -X POST "http://localhost:3000/api/v1/admin/tenants/$TENANT_ID/jamf-instances/$INSTANCE_ID/verify" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN"
# → {"ok":true,"data":{"ok":true,"expiresIn":1800}}
```

#### 安全行為
- `ADMIN_API_TOKEN` 未設 → admin 端點全部 503（不裸奔）
- 字串比對用 `node:crypto` 的 `timingSafeEqual`（防時序側信道）
- GET /admin/.../jamf-instances 回應只露 secret 最後 4 字（`****cdef`），完整 secret 不可讀回
- 改 `clientSecret` 或 `baseUrl` 自動清掉 `jamf_token_cache` 對應 row

### 啟動指令

```bash
pnpm install
pnpm db:generate     # 從 schema 產生 SQL（已產出 0000_*.sql，再改 schema 才需重跑）
pnpm db:migrate      # 套用到 Postgres
pnpm db:seed         # 建立 demo tenant / device_group / jamf instance
pnpm dev             # tsx watch 啟動，預設 :3000
# http://localhost:3000/docs       Scalar 互動式文件
# http://localhost:3000/openapi.json
```

### 已驗證點

- `tsc --noEmit` 0 錯誤
- `drizzle-kit generate` 成功識別所有 FK、unique partial index、`pgEnum`
- 啟動後 `/openapi.json` 路徑 + JamfDevice schema 正確輸出
- `/docs` 回傳 Scalar HTML
- bad uuid 進入 validation hook → 標準 `validation_failed` 信封

