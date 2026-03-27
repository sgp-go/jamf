/** XML Plist 解析/建構 - 包裝 npm:plist */

import plist from "plist";

/** 解析 XML plist 字串為 JavaScript 物件 */
export function parsePlist<T = Record<string, unknown>>(xml: string): T {
  return plist.parse(xml) as T;
}

/** 將 JavaScript 物件建構為 XML plist 字串 */
export function buildPlist(obj: Record<string, unknown>): string {
  return plist.build(obj);
}

/**
 * 將二進位 Buffer 轉為 hex 字串
 * 用於處理 APNS Token 等二進位欄位
 */
export function bufferToHex(buf: Uint8Array | string): string {
  if (typeof buf === "string") {
    // 可能是 base64 編碼
    const bytes = Uint8Array.from(atob(buf), (c) => c.charCodeAt(0));
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 將二進位 Buffer 轉為 base64 字串
 * 用於處理 UnlockToken 等欄位
 */
export function bufferToBase64(buf: Uint8Array | string): string {
  if (typeof buf === "string") return buf;
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}
