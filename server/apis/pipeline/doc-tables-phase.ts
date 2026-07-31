/**
 * Doc-Tables Phase — ensures doc_tables is populated for spreadsheet documents
 * before any numeric-dependent module runs.
 *
 * Same self-sufficiency pattern as extraction-phase.ts:
 * - Check if spreadsheet docs exist for the deal
 * - If doc_tables has rows for all of them, skip (no-op)
 * - If missing, parse the stored parsed_text and populate doc_tables
 *
 * This runs synchronously (no time-budget concept) because spreadsheet parsing
 * is pure CPU work with no LLM calls — it completes in seconds even for large deals.
 */
import { z } from "@superblocksteam/sdk-api";
import { computeContentHash } from "./extraction-prompt.js";
import { DOC_TABLES_PARSER_VERSION } from "./source-snapshot.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type DocTablesPhaseResult =
  | { needed: false }
  | { needed: true; populated: number; warnings: string[] };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const SpreadsheetDocSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  text_length: z.coerce.number(),
});

const DocTableCountSchema = z.object({
  document_id: z.string(),
  row_count: z.coerce.number(),
});

/** CORRECTIVE A: Generation manifest stored as a special row in doc_tables */
const GENERATION_MANIFEST_MARKER = "__generation_manifest__";

interface GenerationManifest {
  documentId: string;
  sourceHash: string;
  parserVersion: string;
  expectedTableCount: number;
  actualTableCount: number;
  status: "complete" | "partial" | "failed";
}

const ManifestRowSchema = z.object({
  document_id: z.string(),
  data: z.any(),
});

const TextSliceSchema = z.object({
  text_slice: z.string(),
});

// ---------------------------------------------------------------------------
// CSV Parsing (same logic as backfill-doc-tables-from-text.ts)
// ---------------------------------------------------------------------------
interface StructuredCell {
  r: number;
  c: number;
  value: number | string | null;
  type: "number" | "string" | "date" | "boolean" | "empty";
}

interface ParsedTable {
  sheetOrPage: string;
  caption: string;
  rowHeaders: string[];
  colHeaders: string[];
  cells: StructuredCell[];
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function classifyValue(text: string): { value: number | string | null; type: StructuredCell["type"] } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, type: "empty" };

  // Strip currency symbols (£, €, $) and thousands separators
  const cleaned = trimmed
    .replace(/[£€$,]/g, "")
    .replace(/^\((.+)\)$/, "-$1");
  const isPercent = trimmed.endsWith("%");
  const numStr = isPercent ? cleaned.replace(/%$/, "") : cleaned;

  // Handle magnitude suffixes: k (×1,000), m (×1,000,000), bn (×1,000,000,000)
  const magMatch = numStr.match(/^(-?[\d.]+)\s*(k|m|bn|b)$/i);
  if (magMatch) {
    const base = Number(magMatch[1]);
    if (!isNaN(base)) {
      const suffix = magMatch[2].toLowerCase();
      const multiplier = suffix === "k" ? 1_000
        : suffix === "m" ? 1_000_000
        : /* bn/b */ 1_000_000_000;
      return { value: base * multiplier, type: "number" };
    }
  }

  const num = Number(numStr);

  if (!isNaN(num) && numStr !== "") {
    return { value: isPercent ? num / 100 : num, type: "number" };
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return { value: trimmed, type: "date" };
  }

  // Log cells that look numeric but failed to parse (currency/magnitude residue)
  if (/[£€$]\s*[\d.]|[\d.]\s*(k|m|bn)\b/i.test(trimmed)) {
    console.log(`[DocTables] Unparseable numeric candidate: "${trimmed}"`);
  }

  return { value: trimmed, type: "string" };
}

function parsedTextToTables(parsedText: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const sheetPattern = /^--- Sheet: (.+?) ---$/gm;
  const sections: Array<{ sheetName: string; content: string }> = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sheetPattern.exec(parsedText)) !== null) {
    if (sections.length > 0) {
      sections[sections.length - 1].content = parsedText.slice(lastIndex, match.index).trim();
    }
    sections.push({ sheetName: match[1], content: "" });
    lastIndex = match.index + match[0].length;
  }

  if (sections.length > 0) {
    sections[sections.length - 1].content = parsedText.slice(lastIndex).trim();
  } else {
    sections.push({ sheetName: "Sheet1", content: parsedText.trim() });
  }

  for (const section of sections) {
    if (!section.content) continue;

    const lines = section.content.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;

    const titleLines: string[] = [];
    let dataStartIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        titleLines.push(lines[i].slice(2).trim());
        dataStartIdx = i + 1;
      } else {
        break;
      }
    }

    const caption = titleLines.length > 0 ? titleLines.join(" | ") : section.sheetName;
    const csvLines = lines.slice(dataStartIdx);
    if (csvLines.length === 0) continue;

    const colHeaders = parseCsvLine(csvLines[0]);
    const dataLines = csvLines.slice(1);

    const nonEmptyDataLines = dataLines.filter((line) => {
      const fields = parseCsvLine(line);
      return fields.some((f) => f.trim() !== "");
    });

    const rowHeaders: string[] = [];
    const cells: StructuredCell[] = [];

    for (let ri = 0; ri < nonEmptyDataLines.length; ri++) {
      const fields = parseCsvLine(nonEmptyDataLines[ri]);
      rowHeaders.push(fields[0]?.trim() || "");

      for (let ci = 0; ci < fields.length; ci++) {
        const text = fields[ci]?.trim() || "";
        if (text === "") continue;
        const { value, type } = classifyValue(text);
        cells.push({ r: ri, c: ci, value, type });
      }
    }

    tables.push({ sheetOrPage: section.sheetName, caption, rowHeaders, colHeaders, cells });
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Segmented text loading (same pattern as extraction-phase.ts)
// ---------------------------------------------------------------------------
const SEGMENT_SIZE = 2_000_000; // 2MB per substring read

async function loadParsedText(
  db: { query: (...args: any[]) => Promise<any[]> },
  docId: string,
  textLength: number
): Promise<string> {
  if (textLength <= SEGMENT_SIZE) {
    const rows = await db.query(
      `SELECT parsed_text AS text_slice FROM documents WHERE id = $1`,
      TextSliceSchema,
      [docId],
      { label: `DocTablesPhase: load text ${docId.slice(0, 8)}` }
    );
    return rows[0]?.text_slice ?? "";
  }

  // Large document — load in segments
  const slices: string[] = [];
  let offset = 1; // PostgreSQL substring is 1-indexed
  const totalSlices = Math.ceil(textLength / SEGMENT_SIZE);

  for (let i = 0; i < totalSlices; i++) {
    const rows = await db.query(
      `SELECT substring(parsed_text FROM ${offset} FOR ${SEGMENT_SIZE}) AS text_slice
       FROM documents WHERE id = $1`,
      TextSliceSchema,
      [docId],
      { label: `DocTablesPhase: text slice ${i + 1}/${totalSlices} for ${docId.slice(0, 8)}` }
    );
    const slice = rows[0]?.text_slice ?? "";
    if (slice.length === 0) break;
    slices.push(slice);
    offset += SEGMENT_SIZE;
  }

  return slices.join("");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function runDocTablesPhase(
  ctx: { integrations: { db: { query: (...args: any[]) => Promise<any[]>; execute: (...args: any[]) => Promise<any> } } },
  dealId: string
): Promise<DocTablesPhaseResult> {
  // Step A: Find spreadsheet documents for this deal
  const spreadsheetDocs = await ctx.integrations.db.query(
    `SELECT id, file_name, COALESCE(length(parsed_text), 0) AS text_length
     FROM documents
     WHERE deal_id = $1
       AND parsed_text IS NOT NULL
       AND parsed_text != ''
       AND (file_type LIKE '%spreadsheet%' OR file_type LIKE '%excel%' OR file_type LIKE '%csv%'
            OR file_name LIKE '%.xlsx' OR file_name LIKE '%.xls' OR file_name LIKE '%.csv')
     ORDER BY uploaded_at
     LIMIT 50`,
    SpreadsheetDocSchema,
    [dealId],
    { label: "DocTablesPhase: find spreadsheet docs" }
  );

  if (spreadsheetDocs.length === 0) {
    return { needed: false };
  }

  // Step B: Check which docs have a valid completed generation manifest
  // CORRECTIVE A: Do not accept mere row presence — require a manifest with
  // status=complete, matching source hash and parser version.
  const manifestRows = await ctx.integrations.db.query(
    `SELECT document_id, data
     FROM doc_tables
     WHERE document_id = ANY($1::uuid[])
       AND sheet_or_page = $2`,
    ManifestRowSchema,
    [spreadsheetDocs.map((d) => d.id), GENERATION_MANIFEST_MARKER],
    { label: "DocTablesPhase: load generation manifests" }
  );

  const manifestMap = new Map<string, GenerationManifest>();
  for (const row of manifestRows) {
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (data && data.status === "complete" && data.parserVersion === DOC_TABLES_PARSER_VERSION) {
      manifestMap.set(row.document_id, data as GenerationManifest);
    }
  }

  // A doc needs regeneration if: no manifest, parser version mismatch, or source hash changed.
  // Source hash validation is deferred to Step C since it requires loading parsed_text.
  // Here we only check for manifest existence and parser version.
  const missingDocs: Array<{ id: string; file_name: string; text_length: number }> = [];
  const docsNeedingHashValidation: Array<{ id: string; file_name: string; text_length: number; manifest: GenerationManifest }> = [];
  for (const doc of spreadsheetDocs) {
    const manifest = manifestMap.get(doc.id);
    if (manifest) {
      // Has a valid-version complete manifest — still need source hash validation
      docsNeedingHashValidation.push({ ...doc, manifest });
      continue;
    }
    missingDocs.push(doc);
  }

  // Step B.2: Validate source hashes for docs with existing manifests
  // Load parsed_text hashes to verify source hasn't changed
  for (const { id, file_name, text_length, manifest } of docsNeedingHashValidation) {
    const parsedText = await loadParsedText(ctx.integrations.db, id, text_length);
    if (!parsedText) {
      missingDocs.push({ id, file_name, text_length });
      continue;
    }
    const currentHash = computeContentHash(parsedText);
    if (currentHash !== manifest.sourceHash) {
      // Source changed — regeneration needed
      missingDocs.push({ id, file_name, text_length });
    }
    // else: source unchanged + manifest complete + parser version matches → skip
  }

  if (missingDocs.length === 0) {
    return { needed: false };
  }

  // Step C: Backfill missing doc_tables
  const warnings: string[] = [];
  let totalPopulated = 0;

  for (const doc of missingDocs) {
    try {
      const parsedText = await loadParsedText(ctx.integrations.db, doc.id, doc.text_length);

      if (!parsedText || parsedText.trim().length === 0) {
        warnings.push(`${doc.file_name}: empty parsed_text`);
        continue;
      }

      // CORRECTIVE A: Compute source hash for this document's text
      const sourceHash = computeContentHash(parsedText);

      // Check if a manifest exists with matching source hash (source hash validation for
      // docs that had a manifest but parser version changed — handled above)
      const existingManifest = manifestMap.get(doc.id);
      if (existingManifest && existingManifest.sourceHash === sourceHash) {
        // Source unchanged but manifest was filtered (parser version mismatch) — re-parse
      }

      // Clear ALL existing rows for this document (data + manifest) — atomic replacement
      await ctx.integrations.db.execute(
        `DELETE FROM doc_tables WHERE document_id = $1`,
        [doc.id],
        { label: `DocTablesPhase: clear stale rows for ${doc.file_name}` }
      );

      const tables = parsedTextToTables(parsedText);
      const expectedTableCount = tables.length;

      if (tables.length === 0) {
        // Write a manifest recording "complete with 0 tables" so we don't re-scan
        await ctx.integrations.db.execute(
          `INSERT INTO doc_tables (document_id, sheet_or_page, caption, data)
           VALUES ($1, $2, $3, $4)`,
          [doc.id, GENERATION_MANIFEST_MARKER, "generation_manifest",
           JSON.stringify({ documentId: doc.id, sourceHash, parserVersion: DOC_TABLES_PARSER_VERSION, expectedTableCount: 0, actualTableCount: 0, status: "complete" })],
          { label: `DocTablesPhase: save empty manifest for ${doc.file_name}` }
        );
        warnings.push(`${doc.file_name}: no parseable tables found in text`);
        continue;
      }

      // Insert table rows one by one
      let insertedCount = 0;
      for (const table of tables) {
        await ctx.integrations.db.execute(
          `INSERT INTO doc_tables (document_id, sheet_or_page, caption, data)
           VALUES ($1, $2, $3, $4)`,
          [
            doc.id,
            table.sheetOrPage,
            table.caption,
            JSON.stringify({
              row_headers: table.rowHeaders,
              col_headers: table.colHeaders,
              cells: table.cells,
            }),
          ],
          { label: `DocTablesPhase: save ${doc.file_name} / ${table.sheetOrPage}` }
        );
        insertedCount++;
      }

      // CORRECTIVE A: Only write manifest after ALL rows inserted successfully.
      // Partial insertion (exception mid-loop) will NOT have a manifest → retry next run.
      const manifestStatus: GenerationManifest["status"] = insertedCount === expectedTableCount ? "complete" : "partial";
      await ctx.integrations.db.execute(
        `INSERT INTO doc_tables (document_id, sheet_or_page, caption, data)
         VALUES ($1, $2, $3, $4)`,
        [doc.id, GENERATION_MANIFEST_MARKER, "generation_manifest",
         JSON.stringify({ documentId: doc.id, sourceHash, parserVersion: DOC_TABLES_PARSER_VERSION, expectedTableCount, actualTableCount: insertedCount, status: manifestStatus })],
        { label: `DocTablesPhase: save manifest for ${doc.file_name}` }
      );

      if (manifestStatus === "complete") {
        totalPopulated += insertedCount;
      } else {
        warnings.push(`${doc.file_name}: partial insertion (${insertedCount}/${expectedTableCount})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`${doc.file_name}: FAILED — ${msg}`);
      // No manifest written → will retry on next invocation
    }
  }

  return { needed: true, populated: totalPopulated, warnings };
}
