/**
 * OpenAPI 文檔的 tag / tagGroup 定義 —— 單一事實來源。
 *
 * 拆分後 Agent 服務與 Control 服務各自只展示自己掛載的 tag；
 * 兩者皆由 ALL_* 派生（過濾），避免手動維護重複清單。
 */

export interface OpenApiTag {
  name: string;
  description: string;
}

export interface OpenApiTagGroup {
  name: string;
  tags: string[];
}

export const ALL_TAGS: OpenApiTag[] = [
  // ── 公開 API（設備端 / Agent App）──
  { name: "設備查詢與操作", description: "設備列表 / 詳情 / 命令派送 / 遙測 / App Lock / 解除納管，操作員統一視角" },
  { name: "Agent 上報", description: "Agent App 上報設備健康狀態 + 螢幕使用時長統計（iOS / Windows 共用）" },
  { name: "應用下載", description: "App 安裝包下載（公開端點，SHA-256 校驗，供 MDM EDA-CSP 拉取 MSI / MSIX）" },

  // ── 租戶初始化 ──
  { name: "租戶管理", description: "租戶生命週期（CRUD）+ MDM 基礎配置（publicBaseUrl / appDownloadBaseUrl / CA 憑證）" },
  { name: "設備分組", description: "設備分組 CRUD（操作員可見性邊界 + 批次派送單位），可選綁定 Jamf 實例" },
  { name: "Jamf 整合", description: "Jamf Pro 整合設定（憑據錄入 / 驗證 / 設備同步），支援多實例" },

  // ── 設備管理 ──
  { name: "設備操作", description: "Admin 設備寫入（transfer 跨校轉移 + retire 退役 + Wipe 觸發 + Agent 派發）" },
  { name: "設備策略", description: "WiFi / 桌布 / 密碼政策 / USB 管控 / 應用限制（AppLocker）推送到設備" },
  { name: "批次註冊", description: "Windows PPKG 批次註冊（customizations.xml 生成，含 WiFi / 本機帳號配置）" },
  { name: "Agent 派發", description: "Agent App 一鍵派發（EDA-CSP 遠端安裝 + 灰度升級 + 健康驗證）" },
  { name: "密碼託管（LAPS）", description: "本機管理員密碼託管 —— 查詢當前密碼 / 手動觸發輪換" },
  { name: "Admin: Firewall", description: "Windows Firewall Rules 管理（tenant + device_group 兩層並集）+ 派發到設備（PRD §5.4）" },

  // ── 策略與合規 ──
  { name: "配置描述檔", description: "配置描述檔 CRUD + 指派到設備或分組 + 套用狀態追蹤" },
  { name: "策略預設", description: "高層 preset：網站黑名單 / Defender 強制 / Windows Update 策略（自動轉換為 CSP payload）" },
  { name: "合規評估", description: "合規政策即時評估（OS 版本下限 + 離線天數上限）" },

  // ── 應用管理 ──
  { name: "應用派發", description: "App 指派到設備或群組 / 卸載 / 安裝狀態追蹤 / 失敗重試" },
  { name: "應用套件管理", description: "App 安裝包上傳與管理（MSI / MSIX 二進位 + metadata）" },

  // ── 平台營運 ──
  { name: "審計日誌", description: "審計日誌查詢（唯讀；寫入由各端點自動記錄）" },
  { name: "Webhook 端點", description: "Webhook 接收端自助註冊：CRUD + 軟刪 + 輪換 secret（secret 僅建立 / 輪換時回傳一次）" },
  { name: "Webhook 監控", description: "Webhook 可觀測性（唯讀）：事件日誌 + 投遞記錄（含重試 / 死信狀態）" },

  // ── 已棄用 ──
  { name: "Jamf 原始視圖（已棄用）", description: "⚠️ 已棄用：請改用統一設備視角端點" },
];

export const ALL_TAG_GROUPS: OpenApiTagGroup[] = [
  { name: "公開 API", tags: ["設備查詢與操作", "Agent 上報", "應用下載"] },
  { name: "租戶初始化", tags: ["租戶管理", "設備分組", "Jamf 整合"] },
  { name: "設備管理", tags: ["設備操作", "設備策略", "批次註冊", "Agent 派發", "密碼託管（LAPS）", "Admin: Firewall"] },
  { name: "策略與合規", tags: ["配置描述檔", "策略預設", "合規評估"] },
  { name: "應用管理", tags: ["應用派發", "應用套件管理"] },
  { name: "平台營運", tags: ["審計日誌", "Webhook 端點", "Webhook 監控"] },
  { name: "已棄用", tags: ["Jamf 原始視圖（已棄用）"] },
];

/** Agent telemetry 服務掛載的 tag（只有上報）。 */
const AGENT_TAG_NAMES = new Set(["Agent 上報"]);

const filterTags = (keep: (name: string) => boolean): OpenApiTag[] =>
  ALL_TAGS.filter((t) => keep(t.name));

const filterTagGroups = (keep: (name: string) => boolean): OpenApiTagGroup[] =>
  ALL_TAG_GROUPS
    .map((g) => ({ ...g, tags: g.tags.filter(keep) }))
    .filter((g) => g.tags.length > 0);

export const AGENT_TAGS = filterTags((n) => AGENT_TAG_NAMES.has(n));
export const AGENT_TAG_GROUPS = filterTagGroups((n) => AGENT_TAG_NAMES.has(n));

export const CONTROL_TAGS = filterTags((n) => !AGENT_TAG_NAMES.has(n));
export const CONTROL_TAG_GROUPS = filterTagGroups((n) => !AGENT_TAG_NAMES.has(n));
