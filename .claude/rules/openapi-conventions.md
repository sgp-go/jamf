# OpenAPI 文檔規範

本文件定義 Jamf Explore API 的 OpenAPI 文檔撰寫標準。所有新增 / 修改的端點都必須遵守。

---

## 1. Tag 規則

### 命名格式

```
{受眾}: {領域}
```

- **公開 API**（設備端 / Agent App）：不帶前綴，如 `Devices`、`Agent`、`Apps`
- **Admin 端點**：以 `Admin: ` 開頭，如 `Admin: tenants`、`Admin: LAPS`

### 分組

使用 Scalar `x-tagGroups` 將 tags 按業務域分成 5 組（見 `server.ts`），新增 tag 時必須歸入對應組。

### 每個 tag 聲明必填

```ts
{ name: "Admin: LAPS", description: "管理員密碼託管（LAPS）..." }
```

`description` 用一句話說明此領域涵蓋哪些操作。

---

## 2. Route 定義（createRoute）

### 必填欄位

| 欄位 | 要求 |
|------|------|
| `method` | HTTP method |
| `path` | 路徑（含 `{param}` 佔位） |
| `tags` | 恰好一個 tag（不要跨 tag） |
| `security` | Admin 端點加 `[{ BearerAuth: [] }]` |
| `summary` | **< 50 字繁中**，一句話說明「做什麼」 |
| `description` | **必填**，見下方結構 |

### description 結構

```ts
description: [
  "一句話業務背景。",
  "",
  "**鑑權**：Bearer admin token / Agent token / 無鑑權。",
  "",
  "**注意事項**（如有）：",
  "- 不可逆操作提示",
  "- 副作用（cascade 刪除、audit log）",
  "",
  "**事件**（如有）：成功後觸發 webhook `event.type`。",
].join("\n"),
```

最低要求：至少寫清楚鑑權方式 + 業務背景。不可逆操作必須加警告。

---

## 3. 參數規則

### Path 參數

所有 path param 必須有 `description` + `example`：

```ts
tenantId: z.string().uuid().openapi({
  param: { name: "tenantId", in: "path" },
  description: "租戶 UUID（從 POST /admin/tenants 取得）",
  example: "00000000-0000-0000-0000-000000000001",
}),
```

### 共用參數

從 `~/lib/api.ts` 匯出的共用 param schema：

| 名稱 | 用途 |
|------|------|
| `tenantIdParam` | `{ tenantId }` |
| `deviceIdParam` | `{ tenantId, deviceId }` |
| `deviceGroupIdParam` | `{ tenantId, deviceGroupId }` |
| `serialNumberParam` | `{ tenantId, serialNumber }` |
| `paginationQuery` | `{ page, limit }` |

路由文件優先使用共用 param，需要擴充時用 `.extend()`。

### Query 參數

- 每個 query param 必須有 `description`
- 有意義的預設值用 `.default()` 並在 description 中標明
- 日期類加 `example: "2026-06-01"`

---

## 4. Schema 規則

### 命名

Schema 名用 PascalCase，通過 `.openapi("SchemaName")` 註冊：

```ts
const deviceGroupSchema = z.object({ ... }).openapi("DeviceGroup");
const createBody = z.object({ ... }).openapi("CreateDeviceGroupInput");
```

**命名慣例**：

| 用途 | 格式 | 範例 |
|------|------|------|
| 實體輸出 | `{Entity}` | `Device`、`Tenant` |
| 建立輸入 | `Create{Entity}Input` | `CreateTenantInput` |
| 更新輸入 | `Update{Entity}Input` | `UpdateTenantInput` |
| 操作結果 | `{Entity}{Action}Result` | `DeviceTransferResult` |
| 列表包裝 | `{Entity}List` | `AgentReportsList` |

### 欄位描述

所有業務欄位必須有 `.openapi({ description })`。技術欄位（id、timestamps）至少有 example：

```ts
z.object({
  id: z.string().uuid().openapi({ example: "..." }),
  code: z.string().openapi({
    description: "tenant 內唯一識別碼",
    example: "guangfu-es",
  }),
  displayName: z.string().openapi({
    description: "對外顯示名稱",
    example: "光復國小",
  }),
  createdAt: z.string().openapi({ description: "ISO 8601 UTC" }),
})
```

### Enum 欄位

Enum 每個值最好附帶說明：

```ts
status: z.enum(["draft", "active", "archived"]).openapi({
  description: "draft=不派發；active=可派發；archived=停用歸檔",
}),
```

---

## 5. Response 規則

### description 內容

Response description 必須描述返回的**內容**，而非泛化的 HTTP 狀態碼含義：

```ts
// ❌ 不可
responses: {
  201: { description: "Created" },
}

// ✅ 正確
responses: {
  201: { description: "建立成功，回傳完整 tenant 物件" },
}
```

### 共用錯誤回應

使用 `commonErrorResponses`（400/401/403/404/502）。路由有特殊錯誤碼（如 409）單獨加。

---

## 6. 檢查清單

新增 / 修改端點時自查：

- [ ] `summary` < 50 字，用繁中
- [ ] `description` 至少含鑑權 + 業務背景
- [ ] 所有 path param 有 description + example
- [ ] 所有 query param 有 description
- [ ] Schema 業務欄位有 description
- [ ] Response description 描述返回內容
- [ ] Tag 在 server.ts 的 `tags` 與 `x-tagGroups` 中均有聲明
- [ ] 不可逆操作有警告
