/**
 * Windows MDM 應用清單解析（EnterpriseModernAppManagement/AppInventoryResults）
 *
 * 設備收到 Get 請求後，會在下次 SyncML 中以 Results 區塊回傳應用清單。
 * Data 欄位是 escape 過的 XML，內容大致：
 *   <Results Schema="1.0">
 *     <App PackageFamilyName="..." Version="..." ...>
 *       <Name>...</Name>
 *     </App>
 *     ...
 *   </Results>
 *
 * 為相容不同 Windows 版本（11 較新、10 較舊）的格式差異，採用寬容 regex 抽取，
 * 只關注 PackageFamilyName / Version / Name / InstallState 四個欄位。
 */

/** 解析後的單一應用記錄 */
export interface InventoryEntry {
  packageFamilyName: string;
  displayName?: string;
  version?: string;
  /** 0=NotInstalled, 1=Installing, 2=Installed, 3=Failed（保留為字串以容納未知值） */
  installState?: string;
}

/**
 * 解析 inventory Data 內的應用清單 XML
 *
 * @param dataXml - Results <Item><Data> 內已經 unescape 後的 XML 字串
 * @returns 應用清單記錄陣列（無法解析則回空陣列）
 */
export function parseInventoryData(dataXml: string): InventoryEntry[] {
  if (!dataXml.trim()) return [];

  // 同時相容自閉合 <App .../> 與成對 <App>...</App>
  // Windows 11 多用屬性式自閉合；部分舊版用子標籤式
  const re = /<(?:App|Package)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:App|Package)>)/g;
  const entries: InventoryEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(dataXml)) !== null) {
    const attrs = m[1];
    const inner = m[2] ?? ""; // 自閉合無 inner

    const pfn =
      attrValue(attrs, "PackageFamilyName") ??
      attrValue(attrs, "packageFamilyName");
    if (!pfn) continue; // 無 PFN 的節點跳過

    entries.push({
      packageFamilyName: pfn,
      version:
        attrValue(attrs, "Version") ??
        attrValue(attrs, "version") ??
        innerTag(inner, "Version"),
      displayName:
        attrValue(attrs, "Name") ??
        innerTag(inner, "Name") ??
        innerTag(inner, "DisplayName"),
      installState:
        attrValue(attrs, "InstallState") ??
        innerTag(inner, "InstallState") ??
        attrValue(attrs, "Status"),
    });
  }
  return entries;
}

function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}="([^"]*)"`);
  const m = attrs.match(re);
  return m ? m[1] : undefined;
}

function innerTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : undefined;
}

/** 判斷某條 SyncMLResult 是否是 AppInventoryResults */
export function isInventoryResult(sourceUri: string): boolean {
  return /AppInventoryResults/i.test(sourceUri);
}
