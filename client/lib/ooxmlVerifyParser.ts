/**
 * ooxmlVerifyParser.ts — C9 Second-Parse Path
 *
 * Independent OOXML cell value extractor for the double-read guard.
 * Reads raw <v> and <f> tags directly from the xlsx ZIP — does NOT use
 * SheetJS. This is the second code path; the primary uses SheetJS cell.v.
 *
 * What this catches: parser misreads where SheetJS interprets differently
 * from what Excel actually stored. The two values are compared at
 * reconciliation time; any disagreement drops the finding.
 *
 * What this doesn't cover: storage corruption after upload (covered by
 * the file hash on document_files chunks).
 */

import JSZip from "jszip";

export interface VerifyCell {
  sheetName: string;
  cellRef: string;
  valueRawV2: string | null;
  valueNumV2: number | null;
  valueTypeV2: string;
}

/**
 * Parse all numeric cells from an xlsx ArrayBuffer using raw OOXML XML.
 * Returns a flat list of (sheetName, cellRef, valueNum, valueRaw, valueType).
 */
export async function parseVerifyCells(xlsxBuffer: ArrayBuffer): Promise<VerifyCell[]> {
  const zip = await JSZip.loadAsync(xlsxBuffer);

  // 1. Parse shared strings
  const ssFile = zip.file("xl/sharedStrings.xml");
  const sharedStrings: string[] = [];
  if (ssFile) {
    const ssXml = await ssFile.async("string");
    const siRegex = /<si>([\s\S]*?)<\/si>/gi;
    let m: RegExpExecArray | null;
    while ((m = siRegex.exec(ssXml)) !== null) {
      const tParts: string[] = [];
      const tRegex = /<t[^>]*>([^<]*)<\/t>/gi;
      let tm: RegExpExecArray | null;
      while ((tm = tRegex.exec(m[1])) !== null) {
        tParts.push(tm[1]);
      }
      sharedStrings.push(
        tParts.join("")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'"),
      );
    }
  }

  // 2. Parse workbook.xml → sheet names and rIds
  const wbFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!wbFile || !relsFile) return [];

  const wbXml = await wbFile.async("string");
  const relsXml = await relsFile.async("string");

  const sheets: Array<{ name: string; rId: string }> = [];
  const sheetRegex = /<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = sheetRegex.exec(wbXml)) !== null) {
    sheets.push({
      name: m[1]
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
      rId: m[2],
    });
  }

  const rels = new Map<string, string>();
  const relRegex = /<Relationship\s[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/?>/gi;
  while ((m = relRegex.exec(relsXml)) !== null) {
    rels.set(m[1], m[2].replace(/^\//, ""));
  }

  // 3. Parse each sheet's cells
  const result: VerifyCell[] = [];

  for (const sheet of sheets) {
    const target = rels.get(sheet.rId);
    if (!target) continue;
    const path = target.startsWith("xl/") ? target : `xl/${target}`;
    const sheetFile = zip.file(path);
    if (!sheetFile) continue;

    const sheetXml = await sheetFile.async("string");

    // Match each <c> element
    const cellRegex = /<c\s([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/gi;
    let cm: RegExpExecArray | null;

    while ((cm = cellRegex.exec(sheetXml)) !== null) {
      const attrs = cm[1];
      const inner = cm[2] || "";

      // Cell address
      const rMatch = attrs.match(/r="([A-Z]{1,3}\d+)"/);
      if (!rMatch) continue;
      const cellRef = rMatch[1];

      // Cell type
      const tMatch = attrs.match(/t="([^"]*)"/);
      const cellType = tMatch ? tMatch[1] : "";

      // Value
      const vMatch = inner.match(/<v>([^<]*)<\/v>/);
      const rawV = vMatch ? vMatch[1] : null;

      // Formula
      const fMatch = inner.match(/<f[^>]*>([^<]*)<\/f>/);
      const formula = fMatch ? fMatch[1] : null;

      if (rawV === null && !formula) continue;

      let valueRawV2: string | null = null;
      let valueNumV2: number | null = null;
      let valueTypeV2 = "text";

      if (cellType === "s" && rawV !== null) {
        const ssIdx = parseInt(rawV, 10);
        valueRawV2 = sharedStrings[ssIdx] ?? rawV;
        valueTypeV2 = "text";
      } else if (cellType === "b") {
        valueTypeV2 = "bool";
        valueRawV2 = rawV;
        valueNumV2 = rawV === "1" ? 1 : 0;
      } else if (cellType === "str" || cellType === "inlineStr") {
        valueTypeV2 = "text";
        valueRawV2 = rawV;
      } else if (rawV !== null) {
        const num = parseFloat(rawV);
        if (!isNaN(num)) {
          valueTypeV2 = "number";
          valueRawV2 = rawV;
          valueNumV2 = num;
        } else {
          valueTypeV2 = "text";
          valueRawV2 = rawV;
        }
      } else if (formula) {
        valueTypeV2 = "formula_no_cache";
      }

      result.push({
        sheetName: sheet.name,
        cellRef,
        valueRawV2,
        valueNumV2,
        valueTypeV2,
      });
    }
  }

  return result;
}
