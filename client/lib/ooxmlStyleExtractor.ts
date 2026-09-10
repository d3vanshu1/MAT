/**
 * OOXML Style Extractor
 *
 * Parses `xl/styles.xml` from the .xlsx ZIP archive to extract:
 *   - numFmts   (custom number format strings)
 *   - fonts     (bold, italic, underline, size, color, name)
 *   - fills     (pattern fills and colors)
 *   - borders   (styles and colors for each edge)
 *   - cellXfs   (the cell-level style records: numFmtId, fontId, fillId, borderId, alignment)
 *
 * Also extracts per-cell `s` attribute (style index) and per-sheet merge ranges
 * from the worksheet XML. The OOXML formula extractor already unzips and iterates
 * sheets, so this module follows the same unzip-once pattern.
 *
 * Additionally extracts defined names from xl/workbook.xml and sheet-level
 * properties (hidden state, freeze panes, row/col dimensions).
 */

import { unzipSync, strFromU8 } from "fflate";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StyleTables {
  numFmts: NumFmt[];
  fonts: FontRecord[];
  fills: FillRecord[];
  borders: BorderRecord[];
  cellXfs: CellXf[];
}

export interface NumFmt {
  numFmtId: number;
  formatCode: string;
}

export interface FontRecord {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  size: number | null;
  color: string | null; // theme or rgb hex
  name: string | null;
}

export interface FillRecord {
  patternType: string | null;
  fgColor: string | null;
  bgColor: string | null;
}

export interface BorderRecord {
  left: string | null;
  right: string | null;
  top: string | null;
  bottom: string | null;
}

export interface CellXf {
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  applyNumberFormat: boolean;
  applyFont: boolean;
  applyFill: boolean;
  applyBorder: boolean;
  applyAlignment: boolean;
  indent: number;
  horizontal: string | null;
  vertical: string | null;
  wrapText: boolean;
}

export interface MergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface RowProperty {
  hidden: boolean;
  outlineLevel: number;
  height: number | null;
  customHeight: boolean;
  customFormat: boolean;
  styleIndex: number | null;
}

export interface ColProperty {
  hidden: boolean;
  outlineLevel: number;
  width: number | null;
  customWidth: boolean;
  styleIndex: number | null;
  min: number;  // 1-based start
  max: number;  // 1-based end
}

export interface SheetProperties {
  sheetState: "visible" | "hidden" | "veryHidden";
  mergedRanges: MergeRange[];
  freezePanes: string | null;
  rowProperties: Record<string, RowProperty>;   // key = row index (0-based)
  colProperties: Record<string, ColProperty>;    // key = col index (0-based)
  cellStyleIndices: Map<string, number>;         // cellAddress → s attribute
}

export interface DefinedName {
  name: string;
  value: string;   // the formula/range reference
  scope: string | null;  // sheet name or null (workbook scope)
}

export interface WorkbookMapExtraction {
  styleTables: StyleTables;
  sheetProperties: Map<string, SheetProperties>;  // sheetName → props
  definedNames: DefinedName[];
}

// ---------------------------------------------------------------------------
// Built-in number formats (Excel doesn't include these in the file)
// ---------------------------------------------------------------------------
const BUILTIN_NUM_FMTS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all style information, sheet properties, merge ranges, and defined
 * names from an .xlsx buffer.
 */
export function extractWorkbookMap(buffer: ArrayBuffer): WorkbookMapExtraction {
  const zipData = new Uint8Array(buffer);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipData);
  } catch {
    return {
      styleTables: emptyStyleTables(),
      sheetProperties: new Map(),
      definedNames: [],
    };
  }

  // 1. Parse styles
  const styleTables = parseStylesXml(files);

  // 2. Resolve sheet name → XML path (same as formula extractor)
  const sheetFileMap = resolveSheetFiles(files);
  const sheetStates = parseSheetStates(files);

  // 3. Parse each worksheet for properties
  const sheetProperties = new Map<string, SheetProperties>();
  for (const [sheetName, xmlPath] of sheetFileMap) {
    const xmlBytes = files[xmlPath];
    if (!xmlBytes) continue;
    const xmlStr = strFromU8(xmlBytes);
    const props = parseWorksheetProperties(xmlStr);
    props.sheetState = sheetStates.get(sheetName) ?? "visible";
    sheetProperties.set(sheetName, props);
  }

  // 4. Parse defined names
  const definedNames = parseDefinedNames(files);

  return { styleTables, sheetProperties, definedNames };
}

/**
 * Resolve the number format string for a given style index.
 * Uses style tables + built-in format map.
 */
export function resolveNumberFormat(styleTables: StyleTables, styleIndex: number): string | null {
  if (styleIndex < 0 || styleIndex >= styleTables.cellXfs.length) return null;
  const xf = styleTables.cellXfs[styleIndex];
  if (!xf.applyNumberFormat && xf.numFmtId === 0) return null;

  // Check custom formats first
  const custom = styleTables.numFmts.find((f) => f.numFmtId === xf.numFmtId);
  if (custom) return custom.formatCode;

  // Fall back to built-in
  const builtin = BUILTIN_NUM_FMTS[xf.numFmtId];
  if (builtin && builtin !== "General") return builtin;

  return null;
}

// ---------------------------------------------------------------------------
// Styles parsing
// ---------------------------------------------------------------------------

function emptyStyleTables(): StyleTables {
  return { numFmts: [], fonts: [], fills: [], borders: [], cellXfs: [] };
}

function parseStylesXml(files: Record<string, Uint8Array>): StyleTables {
  const stylesBytes = files["xl/styles.xml"];
  if (!stylesBytes) return emptyStyleTables();
  const xml = strFromU8(stylesBytes);

  return {
    numFmts: parseNumFmts(xml),
    fonts: parseFonts(xml),
    fills: parseFills(xml),
    borders: parseBorders(xml),
    cellXfs: parseCellXfs(xml),
  };
}

function parseNumFmts(xml: string): NumFmt[] {
  const result: NumFmt[] = [];
  const regex = /<numFmt\s[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"[^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    result.push({
      numFmtId: parseInt(m[1], 10),
      formatCode: decodeXmlEntities(m[2]),
    });
  }
  return result;
}

function parseFonts(xml: string): FontRecord[] {
  const result: FontRecord[] = [];
  // Extract the <fonts> block
  const fontsBlock = xml.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/i);
  if (!fontsBlock) return result;

  const fontRegex = /<font>([\s\S]*?)<\/font>/gi;
  let m: RegExpExecArray | null;
  while ((m = fontRegex.exec(fontsBlock[1])) !== null) {
    const inner = m[1];
    result.push({
      bold: /<b[\s/>]/i.test(inner),
      italic: /<i[\s/>]/i.test(inner),
      underline: /<u[\s/>]/i.test(inner),
      size: extractAttr(inner, "sz", "val"),
      color: extractStrAttr(inner, "color", "rgb") || extractStrAttr(inner, "color", "theme"),
      name: extractStrAttr(inner, "name", "val"),
    });
  }
  return result;
}

function parseFills(xml: string): FillRecord[] {
  const result: FillRecord[] = [];
  const fillsBlock = xml.match(/<fills[^>]*>([\s\S]*?)<\/fills>/i);
  if (!fillsBlock) return result;

  const fillRegex = /<fill>([\s\S]*?)<\/fill>/gi;
  let m: RegExpExecArray | null;
  while ((m = fillRegex.exec(fillsBlock[1])) !== null) {
    const inner = m[1];
    result.push({
      patternType: extractStrAttr(inner, "patternFill", "patternType"),
      fgColor: extractStrAttr(inner, "fgColor", "rgb") || extractStrAttr(inner, "fgColor", "theme"),
      bgColor: extractStrAttr(inner, "bgColor", "rgb") || extractStrAttr(inner, "bgColor", "theme"),
    });
  }
  return result;
}

function parseBorders(xml: string): BorderRecord[] {
  const result: BorderRecord[] = [];
  const bordersBlock = xml.match(/<borders[^>]*>([\s\S]*?)<\/borders>/i);
  if (!bordersBlock) return result;

  const borderRegex = /<border(?:\s[^>]*)?>([\s\S]*?)<\/border>/gi;
  let m: RegExpExecArray | null;
  while ((m = borderRegex.exec(bordersBlock[1])) !== null) {
    const inner = m[1];
    result.push({
      left: extractStrAttr(inner, "left", "style"),
      right: extractStrAttr(inner, "right", "style"),
      top: extractStrAttr(inner, "top", "style"),
      bottom: extractStrAttr(inner, "bottom", "style"),
    });
  }
  return result;
}

function parseCellXfs(xml: string): CellXf[] {
  const result: CellXf[] = [];
  const xfsBlock = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/i);
  if (!xfsBlock) return result;

  const xfRegex = /<xf\s([^>]*?)\/?>([\s\S]*?)(?:<\/xf>|(?=<xf\s))/gi;
  let m: RegExpExecArray | null;
  while ((m = xfRegex.exec(xfsBlock[1])) !== null) {
    const attrs = m[1];
    const inner = m[2] || "";

    const numFmtId = parseInt(getAttrVal(attrs, "numFmtId") ?? "0", 10);
    const fontId = parseInt(getAttrVal(attrs, "fontId") ?? "0", 10);
    const fillId = parseInt(getAttrVal(attrs, "fillId") ?? "0", 10);
    const borderId = parseInt(getAttrVal(attrs, "borderId") ?? "0", 10);

    // Alignment
    const alignMatch = inner.match(/<alignment\s([^>]*?)\/?>/i);
    const alignAttrs = alignMatch ? alignMatch[1] : "";
    const indent = parseInt(getAttrVal(alignAttrs, "indent") ?? "0", 10);

    result.push({
      numFmtId,
      fontId,
      fillId,
      borderId,
      applyNumberFormat: getAttrVal(attrs, "applyNumberFormat") === "1",
      applyFont: getAttrVal(attrs, "applyFont") === "1",
      applyFill: getAttrVal(attrs, "applyFill") === "1",
      applyBorder: getAttrVal(attrs, "applyBorder") === "1",
      applyAlignment: getAttrVal(attrs, "applyAlignment") === "1",
      indent,
      horizontal: getAttrVal(alignAttrs, "horizontal"),
      vertical: getAttrVal(alignAttrs, "vertical"),
      wrapText: getAttrVal(alignAttrs, "wrapText") === "1",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sheet resolution (shared with formula extractor)
// ---------------------------------------------------------------------------

function resolveSheetFiles(files: Record<string, Uint8Array>): Map<string, string> {
  const result = new Map<string, string>();
  const workbookXml = files["xl/workbook.xml"];
  if (!workbookXml) return result;

  const wbStr = strFromU8(workbookXml);
  const sheetToRId = new Map<string, string>();
  const sheetRegex = /<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = sheetRegex.exec(wbStr)) !== null) {
    sheetToRId.set(decodeXmlEntities(m[1]), m[2]);
  }

  const relsXml = files["xl/_rels/workbook.xml.rels"];
  if (!relsXml) return result;
  const relsStr = strFromU8(relsXml);
  const rIdToTarget = new Map<string, string>();
  const relRegex = /<Relationship\s[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/?>/gi;
  while ((m = relRegex.exec(relsStr)) !== null) {
    rIdToTarget.set(m[1], m[2]);
  }

  for (const [sheetName, rId] of sheetToRId) {
    const target = rIdToTarget.get(rId);
    if (target) {
      const fullPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      result.set(sheetName, fullPath);
    }
  }
  return result;
}

/** Parse sheet visibility state from workbook.xml */
function parseSheetStates(files: Record<string, Uint8Array>): Map<string, "visible" | "hidden" | "veryHidden"> {
  const states = new Map<string, "visible" | "hidden" | "veryHidden">();
  const workbookXml = files["xl/workbook.xml"];
  if (!workbookXml) return states;

  const wbStr = strFromU8(workbookXml);
  const sheetRegex = /<sheet\s[^>]*?name="([^"]*)"[^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = sheetRegex.exec(wbStr)) !== null) {
    const name = decodeXmlEntities(m[1]);
    const fullTag = m[0];
    const stateMatch = fullTag.match(/\bstate="([^"]*)"/);
    if (stateMatch) {
      const s = stateMatch[1];
      if (s === "hidden") states.set(name, "hidden");
      else if (s === "veryHidden") states.set(name, "veryHidden");
      else states.set(name, "visible");
    } else {
      states.set(name, "visible");
    }
  }
  return states;
}

// ---------------------------------------------------------------------------
// Worksheet properties parsing
// ---------------------------------------------------------------------------

function parseWorksheetProperties(xml: string): SheetProperties {
  return {
    sheetState: "visible", // overridden by caller from workbook.xml
    mergedRanges: parseMergedRanges(xml),
    freezePanes: parseFreezePanes(xml),
    rowProperties: parseRowProperties(xml),
    colProperties: parseColProperties(xml),
    cellStyleIndices: parseCellStyleIndices(xml),
  };
}

function parseMergedRanges(xml: string): MergeRange[] {
  const result: MergeRange[] = [];
  const mergeRegex = /<mergeCell\s+ref="([^"]+)"\s*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = mergeRegex.exec(xml)) !== null) {
    const parts = m[1].split(":");
    if (parts.length === 2) {
      result.push({
        s: decodeCellAddress(parts[0]),
        e: decodeCellAddress(parts[1]),
      });
    }
  }
  return result;
}

function parseFreezePanes(xml: string): string | null {
  // <pane ... topLeftCell="B5" state="frozen" ... />
  const paneMatch = xml.match(/<pane\s[^>]*?state="frozen[^"]*"[^>]*?\/?>/i);
  if (!paneMatch) return null;
  const tlc = getAttrVal(paneMatch[0], "topLeftCell");
  return tlc || null;
}

function parseRowProperties(xml: string): Record<string, RowProperty> {
  const result: Record<string, RowProperty> = {};
  // Only capture rows with meaningful attributes (hidden, outline, custom height/format, non-default style)
  const rowRegex = /<row\s([^>]*?)(?:\/>|>)/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(xml)) !== null) {
    const attrs = m[1];
    const r = getAttrVal(attrs, "r");
    if (!r) continue;
    const rowIdx = parseInt(r, 10) - 1; // 0-based

    const hidden = getAttrVal(attrs, "hidden") === "1";
    const outlineLevel = parseInt(getAttrVal(attrs, "outlineLevel") ?? "0", 10);
    const ht = getAttrVal(attrs, "ht");
    const height = ht ? parseFloat(ht) : null;
    const customHeight = getAttrVal(attrs, "customHeight") === "1";
    const customFormat = getAttrVal(attrs, "customFormat") === "1";
    const s = getAttrVal(attrs, "s");
    const styleIndex = s ? parseInt(s, 10) : null;

    // Only store rows with non-default properties
    if (hidden || outlineLevel > 0 || customHeight || customFormat || styleIndex) {
      result[String(rowIdx)] = { hidden, outlineLevel, height, customHeight, customFormat, styleIndex };
    }
  }
  return result;
}

function parseColProperties(xml: string): Record<string, ColProperty> {
  const result: Record<string, ColProperty> = {};
  const colRegex = /<col\s([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = colRegex.exec(xml)) !== null) {
    const attrs = m[1];
    const minStr = getAttrVal(attrs, "min");
    const maxStr = getAttrVal(attrs, "max");
    if (!minStr || !maxStr) continue;

    const min = parseInt(minStr, 10);
    const max = parseInt(maxStr, 10);
    const hidden = getAttrVal(attrs, "hidden") === "1";
    const outlineLevel = parseInt(getAttrVal(attrs, "outlineLevel") ?? "0", 10);
    const widthStr = getAttrVal(attrs, "width");
    const width = widthStr ? parseFloat(widthStr) : null;
    const customWidth = getAttrVal(attrs, "customWidth") === "1";
    const s = getAttrVal(attrs, "style");
    const styleIndex = s ? parseInt(s, 10) : null;

    // Store one entry per column range (0-based keys)
    for (let c = min; c <= max; c++) {
      result[String(c - 1)] = { hidden, outlineLevel, width, customWidth, styleIndex, min, max };
    }
  }
  return result;
}

function parseCellStyleIndices(xml: string): Map<string, number> {
  const result = new Map<string, number>();
  // Match <c r="A1" s="5" ...> — the s attribute is the style index
  const cellRegex = /<c\s[^>]*?r="([A-Z]{1,3}\d+)"[^>]*?s="(\d+)"[^>]*?(?:\/>|>)/gi;
  let m: RegExpExecArray | null;
  while ((m = cellRegex.exec(xml)) !== null) {
    result.set(m[1], parseInt(m[2], 10));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Defined names
// ---------------------------------------------------------------------------

function parseDefinedNames(files: Record<string, Uint8Array>): DefinedName[] {
  const result: DefinedName[] = [];
  const workbookXml = files["xl/workbook.xml"];
  if (!workbookXml) return result;
  const xml = strFromU8(workbookXml);

  const block = xml.match(/<definedNames>([\s\S]*?)<\/definedNames>/i);
  if (!block) return result;

  const nameRegex = /<definedName\s([^>]*)>([\s\S]*?)<\/definedName>/gi;
  let m: RegExpExecArray | null;
  while ((m = nameRegex.exec(block[1])) !== null) {
    const attrs = m[1];
    const name = getAttrVal(attrs, "name");
    const value = decodeXmlEntities(m[2].trim());
    if (!name) continue;

    // localSheetId maps to sheet index (0-based), but we'd need the sheet list
    // to resolve names — store the raw index for now
    const localSheetId = getAttrVal(attrs, "localSheetId");

    result.push({
      name: decodeXmlEntities(name),
      value,
      scope: localSheetId ?? null,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeCellAddress(addr: string): { r: number; c: number } {
  const match = addr.match(/^([A-Z]{1,3})(\d+)$/i);
  if (!match) return { r: 0, c: 0 };
  let col = 0;
  const letters = match[1].toUpperCase();
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { c: col - 1, r: parseInt(match[2], 10) - 1 };
}

function getAttrVal(attrs: string, name: string): string | null {
  const regex = new RegExp(`\\b${name}="([^"]*)"`, "i");
  const m = attrs.match(regex);
  return m ? m[1] : null;
}

function extractAttr(xml: string, tag: string, attr: string): number | null {
  const regex = new RegExp(`<${tag}\\s[^>]*?${attr}="([^"]*)"`, "i");
  const m = xml.match(regex);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) ? null : n;
}

function extractStrAttr(xml: string, tag: string, attr: string): string | null {
  const regex = new RegExp(`<${tag}\\s[^>]*?${attr}="([^"]*)"`, "i");
  const m = xml.match(regex);
  return m ? decodeXmlEntities(m[1]) : null;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
