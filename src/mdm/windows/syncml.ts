/**
 * SyncML 1.2 解析與生成（Windows MDM 管理通道）
 *
 * Windows DM Client 透過 SyncML over HTTPS 與後端互動，每次 Session 結構：
 *   <SyncML>
 *     <SyncHdr>...</SyncHdr>          ← Session/Msg ID、目標 URI、認證
 *     <SyncBody>
 *       <Status>...</Status>          ← 對上一輪命令的回應（首次連線只含 Alert 1201）
 *       <Results>...</Results>        ← Get 回應
 *       <Alert>1201</Alert>           ← 客戶端事件通知
 *       <Final/>
 *     </SyncBody>
 *   </SyncML>
 *
 * 後端回應結構（無命令時）：
 *   <SyncML>
 *     <SyncHdr>...</SyncHdr>
 *     <SyncBody>
 *       <Status>...</Status>          ← 對 SyncHdr 的回應 (200)
 *       <Final/>
 *     </SyncBody>
 *   </SyncML>
 *
 * 參考：MS-MDM 規範 + OMA-DM 1.2.1
 */

import type { SyncMLVerb } from "../types.ts";

/** SyncML 訊息頭（SyncHdr） */
export interface SyncMLHeader {
  sessionId: string;
  msgId: string;
  /** 目標 URI（伺服器端 = 管理通道 URL；客戶端 = DeviceID） */
  target: string;
  /** 來源 URI（伺服器端 = DeviceID；客戶端 = 管理通道 URL） */
  source: string;
}

/** SyncML 狀態回應（對某條命令的執行結果） */
export interface SyncMLStatus {
  cmdId: string;
  msgRef: string;
  cmdRef: string;
  /** 對應的命令動詞（Add/Replace/Exec/Get/SyncHdr/Alert 等） */
  cmd: string;
  /** HTTP 風格狀態碼（200=OK、202=Accepted、404=Not Found、500=Error） */
  data: string;
  /** Get 命令的目標 URI（用於對齊） */
  targetRef?: string;
}

/** SyncML 命令（伺服器下發的 Add/Replace/Exec/Get/Delete） */
export interface SyncMLCommand {
  cmdId: string;
  verb: SyncMLVerb;
  /** CSP 路徑，例：./Device/Vendor/MSFT/RemoteWipe/doWipe */
  target: string;
  /** 命令資料（Replace/Add/Exec 才有；Get/Delete 通常無） */
  data?: string;
  /** Item 的 Format（chr/int/bool/b64 等），預設 chr */
  format?: string;
  /** Item 的 Type（MIME 類型，Replace 配置時用），通常省略 */
  type?: string;
}

/** Get 回應的單筆結果 */
export interface SyncMLResult {
  cmdId: string;
  msgRef: string;
  cmdRef: string;
  /** 對應的 CSP 路徑 */
  source: string;
  /** 回應資料 */
  data: string;
  format?: string;
}

/** 客戶端 Alert（如 1201 = ClientInitiated） */
export interface SyncMLAlert {
  cmdId: string;
  data: string;
}

/** 解析後的 SyncML 訊息（客戶端 → 伺服器） */
export interface ParsedSyncML {
  header: SyncMLHeader;
  /** 客戶端對伺服器上一輪命令的執行回應 */
  statuses: SyncMLStatus[];
  /** 客戶端對 Get 命令的回傳資料 */
  results: SyncMLResult[];
  /** 客戶端發起的 Alert（首次連線 1201、ChannelURI 變更等） */
  alerts: SyncMLAlert[];
  /** 是否含 Final（標誌訊息結束） */
  hasFinal: boolean;
}

// ============================================================
// 解析（客戶端 → 伺服器）
// ============================================================

/** 解析 SyncML 訊息（XML 字串） */
export function parseSyncML(xml: string): ParsedSyncML {
  const header = parseHeader(xml);
  const bodyMatch = xml.match(/<SyncBody>([\s\S]*?)<\/SyncBody>/);
  const body = bodyMatch ? bodyMatch[1] : "";

  return {
    header,
    statuses: parseAllBlocks(body, "Status").map(parseStatusBlock),
    results: parseAllBlocks(body, "Results").flatMap(parseResultsBlock),
    alerts: parseAllBlocks(body, "Alert").map(parseAlertBlock),
    hasFinal: /<Final\s*\/?>/i.test(body),
  };
}

function parseHeader(xml: string): SyncMLHeader {
  const headerMatch = xml.match(/<SyncHdr>([\s\S]*?)<\/SyncHdr>/);
  if (!headerMatch) {
    throw new Error("SyncML 訊息缺少 SyncHdr");
  }
  const h = headerMatch[1];
  return {
    sessionId: extractTag(h, "SessionID") ?? "",
    msgId: extractTag(h, "MsgID") ?? "",
    target: extractLocURI(h, "Target") ?? "",
    source: extractLocURI(h, "Source") ?? "",
  };
}

function parseStatusBlock(block: string): SyncMLStatus {
  return {
    cmdId: extractTag(block, "CmdID") ?? "",
    msgRef: extractTag(block, "MsgRef") ?? "",
    cmdRef: extractTag(block, "CmdRef") ?? "",
    cmd: extractTag(block, "Cmd") ?? "",
    data: extractTag(block, "Data") ?? "",
    targetRef: extractLocURI(block, "TargetRef") ?? undefined,
  };
}

function parseResultsBlock(block: string): SyncMLResult[] {
  const cmdId = extractTag(block, "CmdID") ?? "";
  const msgRef = extractTag(block, "MsgRef") ?? "";
  const cmdRef = extractTag(block, "CmdRef") ?? "";
  // 同一個 Results 區塊可含多個 Item
  const items = parseAllBlocks(block, "Item");
  return items.map((item) => ({
    cmdId,
    msgRef,
    cmdRef,
    source: extractLocURI(item, "Source") ?? "",
    data: extractTag(item, "Data") ?? "",
    format: extractFormat(item),
  }));
}

function parseAlertBlock(block: string): SyncMLAlert {
  return {
    cmdId: extractTag(block, "CmdID") ?? "",
    data: extractTag(block, "Data") ?? "",
  };
}

// ============================================================
// 生成（伺服器 → 客戶端）
// ============================================================

/** 伺服器回應建構參數 */
export interface BuildSyncMLOptions {
  /** 對客戶端訊息的回應，需要對齊 sessionId */
  sessionId: string;
  /** 自增的 server msgId（首次回應 = 1，之後 +1） */
  msgId: string;
  /** 客戶端 DeviceID（作為 Target） */
  deviceId: string;
  /** 後端管理通道 URL（作為 Source） */
  managementUrl: string;
  /** 對客戶端 SyncHdr 的 Status 回應（msgRef = 客戶端的 MsgID） */
  hdrStatus: { msgRef: string; data: string };
  /** 對客戶端各命令的 Status 回應 */
  statuses?: SyncMLStatus[];
  /** 伺服器下發的命令 */
  commands?: SyncMLCommand[];
  /** 是否加 Final（最後一個訊息要加） */
  final?: boolean;
}

/** 生成 SyncML 回應 XML */
export function buildSyncML(opts: BuildSyncMLOptions): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<SyncML xmlns="SYNCML:SYNCML1.2">'
  );
  lines.push("  <SyncHdr>");
  lines.push("    <VerDTD>1.2</VerDTD>");
  lines.push("    <VerProto>DM/1.2</VerProto>");
  lines.push(`    <SessionID>${escapeXml(opts.sessionId)}</SessionID>`);
  lines.push(`    <MsgID>${escapeXml(opts.msgId)}</MsgID>`);
  lines.push(
    `    <Target><LocURI>${escapeXml(opts.deviceId)}</LocURI></Target>`
  );
  lines.push(
    `    <Source><LocURI>${escapeXml(opts.managementUrl)}</LocURI></Source>`
  );
  lines.push("  </SyncHdr>");
  lines.push("  <SyncBody>");

  // 對客戶端 SyncHdr 的 Status（CmdID 1, CmdRef=0, Cmd=SyncHdr）
  let cmdIdCounter = 1;
  lines.push(
    statusXml({
      cmdId: String(cmdIdCounter++),
      msgRef: opts.hdrStatus.msgRef,
      cmdRef: "0",
      cmd: "SyncHdr",
      data: opts.hdrStatus.data,
    })
  );

  // 對客戶端各命令的 Status
  for (const s of opts.statuses ?? []) {
    lines.push(statusXml({ ...s, cmdId: String(cmdIdCounter++) }));
  }

  // 伺服器下發的命令
  for (const cmd of opts.commands ?? []) {
    lines.push(commandXml({ ...cmd, cmdId: String(cmdIdCounter++) }));
  }

  if (opts.final !== false) {
    lines.push("    <Final/>");
  }
  lines.push("  </SyncBody>");
  lines.push("</SyncML>");
  return lines.join("\n");
}

function statusXml(s: SyncMLStatus): string {
  const parts = [
    "    <Status>",
    `      <CmdID>${escapeXml(s.cmdId)}</CmdID>`,
    `      <MsgRef>${escapeXml(s.msgRef)}</MsgRef>`,
    `      <CmdRef>${escapeXml(s.cmdRef)}</CmdRef>`,
    `      <Cmd>${escapeXml(s.cmd)}</Cmd>`,
    `      <Data>${escapeXml(s.data)}</Data>`,
    "    </Status>",
  ];
  return parts.join("\n");
}

function commandXml(c: SyncMLCommand): string {
  const lines: string[] = [`    <${c.verb}>`];
  lines.push(`      <CmdID>${escapeXml(c.cmdId)}</CmdID>`);
  lines.push("      <Item>");
  lines.push(
    `        <Target><LocURI>${escapeXml(c.target)}</LocURI></Target>`
  );
  if (c.format || c.type) {
    lines.push("        <Meta>");
    if (c.format) {
      lines.push(
        `          <Format xmlns="syncml:metinf">${escapeXml(c.format)}</Format>`
      );
    }
    if (c.type) {
      lines.push(
        `          <Type xmlns="syncml:metinf">${escapeXml(c.type)}</Type>`
      );
    }
    lines.push("        </Meta>");
  }
  if (c.data !== undefined && c.data !== null) {
    lines.push(`        <Data>${escapeXml(c.data)}</Data>`);
  }
  lines.push("      </Item>");
  lines.push(`    </${c.verb}>`);
  return lines.join("\n");
}

// ============================================================
// 內部 XML 工具
// ============================================================

/** 抓出第一個 <tag>...</tag> 之間的內容（去除 CDATA 包裝） */
function extractTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  if (!m) return undefined;
  const raw = m[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return unescapeXml(cdata ? cdata[1] : raw);
}

/** 抓出 <wrapper><LocURI>val</LocURI></wrapper> 中的 val */
function extractLocURI(xml: string, wrapper: string): string | undefined {
  const re = new RegExp(
    `<${wrapper}>[\\s\\S]*?<LocURI>([\\s\\S]*?)</LocURI>[\\s\\S]*?</${wrapper}>`
  );
  const m = xml.match(re);
  return m ? unescapeXml(m[1].trim()) : undefined;
}

/** 抓 <Format xmlns="syncml:metinf">val</Format> */
function extractFormat(xml: string): string | undefined {
  const m = xml.match(/<Format[^>]*>([\s\S]*?)<\/Format>/);
  return m ? m[1].trim() : undefined;
}

/** 抓出所有 <tag>...</tag> 區塊（同名重複會全部回傳） */
function parseAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/** XML 特殊字元編碼 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** XML 特殊字元解碼 */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
