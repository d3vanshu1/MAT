/**
 * read-cell-from-bytes.ts — C9 Double-Read: Independent cell reader
 *
 * Given a workbook, sheet, and cell reference, reads the stored OOXML bytes
 * directly and returns that cell's raw value. This is the SECOND independent
 * path for the double-read guard — completely separate from the map's
 * value_raw/value_num populated by Phase 1.
 *
 * The two paths that must agree:
 *   Path 1: workbook_cells.value_raw / value_num (from Phase 1 parse)
 *   Path 2: this API (fresh OOXML parse from stored bytes)
 *
 * If they disagree, the finding is dropped. No tie-breaking, no fuzzy compare.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
// ---------------------------------------------------------------------------
// Inline ZIP extractor — no npm deps, uses DecompressionStream (Web API)
// with sync fallback via manual inflate for the Superblocks server VM
// ---------------------------------------------------------------------------

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  // Try DecompressionStream (available in Node 18+ and modern browsers)
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(compressed as any);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    return result;
  }
  throw new Error("No decompression API available in this runtime");
}

async function unzipAsync(zipData: Uint8Array): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);
  // Find End of Central Directory
  let eocdOffset = -1;
  for (let i = zipData.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("Not a valid ZIP");
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);
  let pos = cdOffset;
  for (let e = 0; e < cdEntries; e++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const compMethod = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameBytes = zipData.subarray(pos + 46, pos + 46 + nameLen);
    const name = String.fromCharCode(...nameBytes);
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lhNameLen = view.getUint16(localOffset + 26, true);
    const lhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = zipData.slice(dataStart, dataStart + compSize);
    if (compMethod === 0) {
      result.set(name, new Uint8Array(raw));
    } else if (compMethod === 8) {
      result.set(name, await inflateRaw(new Uint8Array(raw)));
    }
  }
  return result;
}

function utf8Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { parts.push(String.fromCharCode(b)); i++; }
    else if (b < 0xe0) { parts.push(String.fromCharCode(((b & 0x1f) << 6) | (bytes[i+1] & 0x3f))); i += 2; }
    else if (b < 0xf0) { parts.push(String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i+1] & 0x3f) << 6) | (bytes[i+2] & 0x3f))); i += 3; }
    else { const cp = ((b & 0x07) << 18) | ((bytes[i+1] & 0x3f) << 12) | ((bytes[i+2] & 0x3f) << 6) | (bytes[i+3] & 0x3f); const o = cp - 0x10000; parts.push(String.fromCharCode(0xd800 + (o >> 10), 0xdc00 + (o & 0x3ff))); i += 4; }
  }
  return parts.join("");
}

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// OOXML single-cell parser (independent of reparse-from-storage.ts)
// ---------------------------------------------------------------------------

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRegex = /<si>([\s\S]*?)<\/si>/gi;
  let m: RegExpExecArray | null;
  while ((m = siRegex.exec(xml)) !== null) {
    const tParts: string[] = [];
    const tRegex = /<t[^>]*>([^<]*)<\/t>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tRegex.exec(m[1])) !== null) {
      tParts.push(tm[1]);
    }
    strings.push(
      tParts.join("")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    );
  }
  return strings;
}

function getSheetPaths(wbXml: string, relsXml: string): Array<{ name: string; path: string }> {
  const sheets: Array<{ name: string; rId: string }> = [];
  const sheetRegex = /<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = sheetRegex.exec(wbXml)) !== null) {
    sheets.push({
      name: m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<")
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
  return sheets.map(s => ({
    name: s.name,
    path: rels.get(s.rId)?.startsWith("xl/")
      ? rels.get(s.rId)!
      : `xl/${rels.get(s.rId) ?? "worksheets/sheet1.xml"}`,
  }));
}

interface CellReadResult {
  cellRef: string;
  sheet: string;
  valueRaw: string | null;
  valueNum: number | null;
  valueType: string;
  formula: string | null;
}

/**
 * Parse a single cell from sheet XML.
 * Returns null if the cell is not found.
 */
function readSingleCell(
  sheetXml: string,
  targetCellRef: string,
  sharedStrings: string[],
): CellReadResult | null {
  // Find the <c> element for this specific cell
  // Match <c r="H86" ...> or <c r="H86" ... />
  const escaped = targetCellRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cellRegex = new RegExp(
    `<c\\s[^>]*?r="${escaped}"[^>]*(?:\\/>|>([\\s\\S]*?)<\\/c>)`,
    "i",
  );
  const m = cellRegex.exec(sheetXml);
  if (!m) return null;

  const attrs = m[0];
  const inner = m[1] || "";

  // Type
  const tMatch = attrs.match(/t="([^"]*)"/);
  const cellType = tMatch ? tMatch[1] : "";

  // Value
  const vMatch = inner.match(/<v>([^<]*)<\/v>/);
  const rawV = vMatch ? vMatch[1] : null;

  // Formula
  const fMatch = inner.match(/<f[^>]*>([^<]*)<\/f>/);
  const formula = fMatch ? fMatch[1] : null;

  let valueRaw: string | null = null;
  let valueNum: number | null = null;
  let valueType = "text";

  if (rawV === null && !formula) return null;

  if (cellType === "s" && rawV !== null) {
    const ssIdx = parseInt(rawV, 10);
    valueRaw = sharedStrings[ssIdx] ?? rawV;
    valueType = "text";
  } else if (cellType === "b") {
    valueType = "bool";
    valueRaw = rawV;
    valueNum = rawV === "1" ? 1 : 0;
  } else if (cellType === "str" || cellType === "inlineStr") {
    valueType = "text";
    valueRaw = rawV;
  } else if (rawV !== null) {
    const num = parseFloat(rawV);
    if (!isNaN(num)) {
      valueType = "number";
      valueRaw = rawV;
      valueNum = num;
    } else {
      valueType = "text";
      valueRaw = rawV;
    }
  } else if (formula) {
    valueType = "formula_no_cache";
    valueRaw = null;
  }

  return {
    cellRef: targetCellRef,
    sheet: "", // filled by caller
    valueRaw,
    valueNum,
    valueType,
    formula,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "ReadCellFromBytes",
  description: "C9 independent cell reader — reads one cell directly from stored OOXML bytes",

  integrations: { ic_db: postgres(IC_DB) },

  input: z.object({
    workbookId: z.string(),
    sheetName: z.string(),
    cellRef: z.string(),
  }),

  output: z.object({
    found: z.boolean(),
    bytesPath: z.object({
      valueRaw: z.string().nullable(),
      valueNum: z.number().nullable(),
      valueType: z.string(),
      formula: z.string().nullable(),
    }).nullable(),
    mapPath: z.object({
      valueRaw: z.string().nullable(),
      valueNum: z.number().nullable(),
      valueType: z.string().nullable(),
    }).nullable(),
    match: z.boolean(),
    mismatchDetail: z.string().nullable(),
  }),

  async run(ctx, { workbookId, sheetName, cellRef }) {
    const q = ctx.integrations.ic_db;

    // --- Load the map's value for this cell (Path 1) ---
    const MapRow = z.object({
      value_raw: z.string().nullable(),
      value_num: z.string().nullable(), // numeric comes as string
      value_type: z.string().nullable(),
    });
    const mapRows = await q.query(
      "SELECT value_raw, value_num::text, value_type FROM workbook_cells WHERE workbook_id = $1 AND sheet_name = $2 AND cell_ref = $3 LIMIT 1",
      MapRow, [workbookId, sheetName, cellRef],
      { label: "Map path: read cell" },
    );

    const mapValue = mapRows.length > 0 ? {
      valueRaw: mapRows[0].value_raw,
      valueNum: mapRows[0].value_num ? parseFloat(mapRows[0].value_num) : null,
      valueType: mapRows[0].value_type,
    } : null;

    // --- Get document_id for this workbook ---
    const DocRow = z.object({ document_id: z.string() });
    const [docRow] = await q.query(
      "SELECT document_id::text FROM workbooks WHERE id = $1 LIMIT 1",
      DocRow, [workbookId],
      { label: "Get document_id" },
    );
    if (!docRow) throw new Error("Workbook not found: " + workbookId);

    // --- Load stored bytes (Path 2) ---
    const ChunkMeta = z.object({ chunk_index: z.number(), byte_count: z.number() });
    const chunkMeta = await q.query(
      "SELECT chunk_index, byte_count FROM document_files WHERE document_id = $1::uuid ORDER BY chunk_index",
      ChunkMeta, [docRow.document_id],
      { label: "Chunk metadata" },
    );
    if (chunkMeta.length === 0) throw new Error("No stored file chunks for document " + docRow.document_id);

    // Reassemble bytes (hex-encoded slices to stay under gRPC 4MB)
    const SLICE_SIZE = 200_000;
    const totalBytes = chunkMeta.reduce((sum, c) => sum + c.byte_count, 0);
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const meta of chunkMeta) {
      for (let sliceStart = 1; sliceStart <= meta.byte_count; sliceStart += SLICE_SIZE) {
        const sliceLen = Math.min(SLICE_SIZE, meta.byte_count - sliceStart + 1);
        const rows = await q.query(
          `SELECT encode(substr(bytes, $3, $4), 'hex') AS hex
           FROM document_files
           WHERE document_id = $1::uuid AND chunk_index = $2
           LIMIT 1`,
          z.object({ hex: z.string() }),
          [docRow.document_id, meta.chunk_index, sliceStart, sliceLen],
          { label: "Bytes slice " + meta.chunk_index + "@" + sliceStart },
        );
        const hex = rows[0].hex;
        const bin = new Uint8Array(hex.length / 2);
        for (let h = 0; h < hex.length; h += 2) {
          bin[h / 2] = parseInt(hex.substring(h, h + 2), 16);
        }
        combined.set(bin, offset);
        offset += bin.length;
      }
    }

    // Unzip
    const files = await unzipAsync(combined);
    const decode = (path: string) => {
      const f = files.get(path);
      return f ? utf8Decode(f) : "";
    };

    // Parse shared strings
    const ssXml = decode("xl/sharedStrings.xml");
    const sharedStrings = ssXml ? parseSharedStrings(ssXml) : [];

    // Find sheet path
    const wbXml = decode("xl/workbook.xml");
    const relsXml = decode("xl/_rels/workbook.xml.rels");
    const allSheets = getSheetPaths(wbXml, relsXml);
    const targetSheet = allSheets.find(s => s.name === sheetName);
    if (!targetSheet) {
      return {
        found: false,
        bytesPath: null,
        mapPath: mapValue,
        match: false,
        mismatchDetail: "Sheet '" + sheetName + "' not found in stored bytes",
      };
    }

    // Parse the target cell from the sheet XML
    const sheetXml = decode(targetSheet.path);
    const cellResult = readSingleCell(sheetXml, cellRef, sharedStrings);

    if (!cellResult) {
      return {
        found: false,
        bytesPath: null,
        mapPath: mapValue,
        match: mapValue === null, // both absent = match
        mismatchDetail: mapValue ? "Cell not found in bytes but exists in map" : null,
      };
    }

    const bytesValue = {
      valueRaw: cellResult.valueRaw,
      valueNum: cellResult.valueNum,
      valueType: cellResult.valueType,
      formula: cellResult.formula,
    };

    // --- Compare Path 1 vs Path 2 ---
    // For numeric cells, compare valueNum with exact match (no tolerance)
    // For text cells, compare valueRaw
    let match = false;
    let mismatchDetail: string | null = null;

    if (!mapValue) {
      match = false;
      mismatchDetail = "Cell found in bytes but not in map";
    } else if (cellResult.valueType === "number" && mapValue.valueType === "number") {
      // Numeric exact match — compare the raw float values
      match = cellResult.valueNum === mapValue.valueNum;
      if (!match) {
        mismatchDetail = `Numeric mismatch: bytes=${cellResult.valueNum}, map=${mapValue.valueNum}`;
      }
    } else {
      // Text / other — compare raw strings
      match = cellResult.valueRaw === mapValue.valueRaw;
      if (!match) {
        mismatchDetail = `Value mismatch: bytes="${cellResult.valueRaw}", map="${mapValue.valueRaw}"`;
      }
    }

    return {
      found: true,
      bytesPath: bytesValue,
      mapPath: mapValue,
      match,
      mismatchDetail,
    };
  },
});
