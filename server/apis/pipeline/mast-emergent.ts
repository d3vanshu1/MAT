/**
 * mast-emergent.ts
 *
 * Stage: emergent (single-shot, NOT in LOOP_STAGES)
 *
 * Four cross-document rules that surface propositions the deal depends
 * on but no single document states.  Pure code — no LLM anywhere.
 *
 *   E1 implied_renewal       — legal expiry year < forecast horizon
 *   E2 management_figure_adopted — numeric_exact reliance link to CIM
 *   E3 reference_trend_break — model rate outside historical range
 *   E4 future_terms_divergence — forward vs observed driver divergence
 */

import { z } from "@superblocksteam/sdk-api";
import type {
  StageContext,
  StageResult,
  StageHandler,
} from "./mast-contract.js";
import {
  resolveModelDocument,
  selectPeriodRow,
} from "./mast-register-model-drivers.js";
import { loadAllSheets } from "./mast-doc-tables.js";

const LOG_PREFIX = "[MAST-EMERGENT]";

// ── Shared schemas ──────────────────────────────────────────────────

const DocTableRow = z.object({
  id: z.string(),
  document_id: z.string(),
  sheet_or_page: z.string(),
  data: z.any(),
});

const ChunkRow = z.object({
  id: z.string(),
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  file_name: z.string(),
  content: z.string(),
});

const RelianceLinkRow = z.object({
  id: z.string(),
  from_doc_id: z.string(),
  from_locator: z.string().nullable(),
  from_label: z.string().nullable(),
  from_value: z.coerce.number().nullable(),
  to_doc_id: z.string(),
  to_locator: z.string().nullable(),
  to_label: z.string().nullable(),
  to_value: z.coerce.number().nullable(),
  match_method: z.string(),
});

const DriverRow = z.object({
  id: z.string(),
  proposition: z.string(),
  origin_locator: z.string().nullable(),
  verbatim: z.string().nullable(),
  value: z.coerce.number().nullable(),
  detector: z.string().nullable(),
});

const DocIdTagRow = z.object({
  id: z.string(),
  document_tag: z.string().nullable(),
});

// ── Helpers ─────────────────────────────────────────────────────────

const YEAR_RE = /\b(2[01]\d{2})\b/g;
const EXPIRY_TERMS = /expires|expiry|expiration|term\s+ends|termination\s+date|renewal\s+date|initial\s+term|contract\s+term/i;

/**
 * Parse the column index from an A1 address (e.g. "C23" → col 3).
 * Returns 0-based column index.
 */
function parseColFromA1(addr: string): number {
  const m = addr.match(/^([A-Z]+)/i);
  if (!m) return -1;
  const letters = m[1].toUpperCase();
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1; // 0-based
}

/**
 * Parse sheet name and A1 address from an origin_locator like "Sheet1!C23".
 */
function parseLocator(locator: string): { sheet: string; addr: string } | null {
  const bang = locator.indexOf("!");
  if (bang < 0) return null;
  return { sheet: locator.slice(0, bang), addr: locator.slice(bang + 1) };
}

/**
 * Normalize a label: lowercase, collapse non-alphanumeric to single spaces, trim.
 */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Truncate a string to maxLen, appending "…" if truncated.
 */
function trunc(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

// ── Interface for rows to insert ────────────────────────────────────

interface EmergentRow {
  proposition: string;
  origin_doc_id: string;
  origin_locator: string | null;
  verbatim: string | null;
  quantified: boolean;
  value: number | null;
  detector: string;
  reliance_link_id: string | null;
}

// ── Forecast Horizon ────────────────────────────────────────────────

interface ParsedCell {
  r: number;
  c: number;
  value: unknown;
  type: string;
}

async function computeForecastHorizon(
  db: StageContext["db"],
  modelDocId: string,
): Promise<number | null> {
  const { sheets, skipped } = await loadAllSheets(db, modelDocId);

  if (skipped > 0) {
    console.log(`${LOG_PREFIX} ${skipped} sheet(s) skipped for model document due to size limit.`);
  }

  if (sheets.length === 0) {
    console.log(`${LOG_PREFIX} No doc_tables for model document — cannot determine horizon.`);
    return null;
  }

  let maxYear = -1;

  for (const sheet of sheets) {
    let cells: ParsedCell[];
    try {
      cells = Array.isArray(sheet.data) ? sheet.data : [];
    } catch {
      continue;
    }
    if (cells.length === 0) continue;

    // Build the map that detectPeriodHeaderRows would produce
    const headerRowMap = new Map<number, Map<number, string>>();
    for (const cell of cells) {
      if (cell.r > 5) continue;
      const nonEmpty =
        cell.type !== "empty" && cell.value !== null && cell.value !== "";
      if (!nonEmpty) continue;

      let colMap = headerRowMap.get(cell.r);
      if (!colMap) {
        colMap = new Map<number, string>();
        headerRowMap.set(cell.r, colMap);
      }
      colMap.set(cell.c, String(cell.value));
    }

    // Filter to rows where >50% of non-empty cells are dates/years
    const periodHeaders = new Map<number, Map<number, string>>();
    for (const [rowIdx, colMap] of headerRowMap) {
      let dateOrYearCount = 0;
      let total = 0;
      for (const val of colMap.values()) {
        total++;
        const num = Number(val);
        if (Number.isInteger(num) && num >= 2000 && num <= 2100) {
          dateOrYearCount++;
          continue;
        }
        if (!isNaN(Date.parse(val)) && /\d{4}/.test(val)) {
          dateOrYearCount++;
        }
      }
      if (total > 0 && dateOrYearCount > total / 2) {
        periodHeaders.set(rowIdx, colMap);
      }
    }

    const periodRow = selectPeriodRow(periodHeaders);
    if (!periodRow) continue;

    for (const val of periodRow.values()) {
      const num = Number(val);
      if (Number.isInteger(num) && num >= 2000 && num <= 2100 && num > maxYear) {
        maxYear = num;
      }
    }
  }

  if (maxYear < 2000) {
    console.log(`${LOG_PREFIX} No 4-digit year found in period headers — no horizon.`);
    return null;
  }

  console.log(`${LOG_PREFIX} Forecast horizon: ${maxYear}`);
  return maxYear;
}

// ── Rule E1: Implied Renewal ────────────────────────────────────────

async function ruleImpliedRenewal(
  db: StageContext["db"],
  dealId: string,
  forecastHorizon: number,
): Promise<EmergentRow[]> {
  // Find legal documents
  const legalDocs = await db.query(
    `SELECT id, document_tag
     FROM documents
     WHERE deal_id = $1::uuid AND document_tag = 'legal'`,
    DocIdTagRow,
    [dealId],
    { label: "EMERGENT-E1: find legal documents" },
  );

  if (legalDocs.length === 0) {
    console.log(`${LOG_PREFIX} E1: no legal documents — skipping.`);
    return [];
  }

  const legalDocIds = legalDocs.map((d) => d.id);

  // Load chunks for legal documents
  const chunks = await db.query(
    `SELECT id, document_id, chunk_index, file_name, content
     FROM document_chunks
     WHERE document_id = ANY($1::uuid[])
     ORDER BY document_id, chunk_index`,
    ChunkRow,
    [legalDocIds],
    { label: "EMERGENT-E1: load legal document chunks" },
  );

  if (chunks.length === 0) {
    console.log(`${LOG_PREFIX} E1: no chunks for legal documents — skipping.`);
    return [];
  }

  const dedupSet = new Set<string>();
  const rows: EmergentRow[] = [];

  for (const chunk of chunks) {
    const text = chunk.content;
    // Find all 4-digit years in the text
    YEAR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = YEAR_RE.exec(text)) !== null) {
      const year = parseInt(match[1], 10);
      if (year < 2000 || year > 2100) continue;
      if (year >= forecastHorizon) continue;

      // Check that the year appears within 200 chars of an expiry term
      const yearStart = match.index;
      const searchStart = Math.max(0, yearStart - 200);
      const searchEnd = Math.min(text.length, yearStart + match[0].length + 200);
      const window = text.slice(searchStart, searchEnd);

      if (!EXPIRY_TERMS.test(window)) continue;

      // Deduplicate on (chunk_index, year)
      const dedupKey = `${chunk.chunk_index}:${year}`;
      if (dedupSet.has(dedupKey)) continue;
      dedupSet.add(dedupKey);

      // Extract verbatim: 200 chars either side of the matched year, truncated to 500
      const verbStart = Math.max(0, yearStart - 200);
      const verbEnd = Math.min(text.length, yearStart + match[0].length + 200);
      const verbatim = trunc(text.slice(verbStart, verbEnd), 500);

      const originLocator = `${chunk.file_name} chunk ${chunk.chunk_index}`;

      const proposition =
        `Contract or term expires in ${year}, but the model forecasts revenue to ${forecastHorizon}. ` +
        `Revenue is projected beyond the stated expiry, therefore renewal or extension is assumed.`;

      rows.push({
        proposition,
        origin_doc_id: chunk.document_id,
        origin_locator: originLocator,
        verbatim,
        quantified: false,
        value: null,
        detector: "implied_renewal",
        reliance_link_id: null,
      });
    }
  }

  // Sort by year ascending (earliest expiry is most exposed)
  // The year is embedded in the proposition — sort rows by extracting it
  rows.sort((a, b) => {
    const ya = parseInt(a.proposition.match(/expires in (\d{4})/)?.[1] ?? "9999", 10);
    const yb = parseInt(b.proposition.match(/expires in (\d{4})/)?.[1] ?? "9999", 10);
    return ya - yb;
  });

  if (rows.length > 50) {
    console.log(
      `${LOG_PREFIX} E1: ${rows.length} implied_renewal hits — capping at 50, dropping ${rows.length - 50}.`,
    );
  }

  return rows.slice(0, 50);
}

// ── Rule E2: Management Figure Adopted Unchanged ────────────────────

async function ruleManagementFigureAdopted(
  db: StageContext["db"],
  runId: string,
  dealId: string,
): Promise<EmergentRow[]> {
  // Find CIM documents
  const cimDocs = await db.query(
    `SELECT id, document_tag
     FROM documents
     WHERE deal_id = $1::uuid AND document_tag = 'cim'`,
    DocIdTagRow,
    [dealId],
    { label: "EMERGENT-E2: find CIM documents" },
  );

  if (cimDocs.length === 0) {
    console.log(`${LOG_PREFIX} E2: no CIM documents — skipping.`);
    return [];
  }

  const cimDocIds = cimDocs.map((d) => d.id);

  // Query reliance links where match_method = 'numeric_exact' and to_doc_id is a CIM
  const links = await db.query(
    `SELECT id, from_doc_id, from_locator, from_label, from_value,
            to_doc_id, to_locator, to_label, to_value, match_method
     FROM mast_reliance_links
     WHERE run_id = $1::uuid
       AND match_method = 'numeric_exact'
       AND to_doc_id = ANY($2::uuid[])`,
    RelianceLinkRow,
    [runId, cimDocIds],
    { label: "EMERGENT-E2: find numeric_exact links to CIM" },
  );

  if (links.length === 0) {
    console.log(`${LOG_PREFIX} E2: no numeric_exact reliance links to CIM — skipping.`);
    return [];
  }

  const rows: EmergentRow[] = [];

  for (const link of links) {
    const valStr = link.from_value != null ? String(link.from_value) : "N/A";
    const fromLabel = link.from_label ?? "unlabeled";
    const toLabel = link.to_label ?? "unlabeled";

    const proposition =
      `The deal team's figure "${fromLabel}" (${valStr}) matches the seller's figure "${toLabel}" exactly. ` +
      `No independent view is evidenced — the management figure is adopted unchanged.`;

    const verbatim = `${fromLabel} = ${valStr} matched against ${toLabel}`;

    const originLocator =
      `${link.from_locator ?? "unknown"} versus ${link.to_locator ?? "unknown"}`;

    rows.push({
      proposition,
      origin_doc_id: link.from_doc_id,
      origin_locator: originLocator,
      verbatim,
      quantified: true,
      value: link.from_value,
      detector: "management_figure_adopted",
      reliance_link_id: link.id,
    });
  }

  // Sort by absolute value descending
  rows.sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));

  if (rows.length > 100) {
    console.log(
      `${LOG_PREFIX} E2: ${rows.length} management_figure_adopted hits — capping at 100, dropping ${rows.length - 100}.`,
    );
  }

  return rows.slice(0, 100);
}

// ── Rule E3: Reference Trend Break ──────────────────────────────────

async function ruleReferenceTrendBreak(
  db: StageContext["db"],
  runId: string,
  dealId: string,
  forecastHorizon: number,
  modelDocId: string,
): Promise<EmergentRow[]> {
  // Find reference documents (not financial_model, not ic_memo) that have doc_tables rows
  const refDocs = await db.query(
    `SELECT DISTINCT d.id, d.file_name, d.document_tag
     FROM documents d
     JOIN doc_tables dt ON dt.document_id = d.id
     WHERE d.deal_id = $1::uuid
       AND d.document_tag IS NOT NULL
       AND d.document_tag NOT IN ('financial_model', 'ic_memo')`,
    z.object({ id: z.string(), file_name: z.string(), document_tag: z.string().nullable() }),
    [dealId],
    { label: "EMERGENT-E3: find reference documents with tables" },
  );

  if (refDocs.length === 0) {
    console.log(`${LOG_PREFIX} E3: no reference documents with doc_tables — skipping.`);
    return [];
  }

  // Load model_explicit drivers for this run
  const drivers = await db.query(
    `SELECT id, proposition, origin_locator, verbatim, value, detector
     FROM mast_assumptions
     WHERE run_id = $1::uuid
       AND origin_type = 'model_explicit'`,
    DriverRow,
    [runId],
    { label: "EMERGENT-E3: load model_explicit drivers" },
  );

  if (drivers.length === 0) {
    console.log(`${LOG_PREFIX} E3: no model_explicit drivers in register — skipping.`);
    return [];
  }

  // Build driver lookup by normalized label → driver
  const driverByLabel = new Map<string, typeof drivers[number]>();
  for (const d of drivers) {
    // Extract label from proposition: "Label = Value" or "Label = Value (Period)"
    const labelMatch = d.proposition.match(/^(.+?)\s*=\s*/);
    if (!labelMatch) continue;
    const rawLabel = labelMatch[1].trim();
    if (!rawLabel) continue;
    const normLabel = normalizeLabel(rawLabel);
    // Keep first occurrence (higher refCount since they were ordered)
    if (!driverByLabel.has(normLabel)) {
      driverByLabel.set(normLabel, d);
    }
  }

  const rows: EmergentRow[] = [];

  for (const refDoc of refDocs) {
    // Load sheets for this reference document
    const { sheets } = await loadAllSheets(db, refDoc.id);

    for (const sheet of sheets) {
      let cells: ParsedCell[];
      try {
        cells = Array.isArray(sheet.data) ? sheet.data : [];
      } catch {
        continue;
      }
      if (cells.length === 0) continue;

      // Group cells by row
      const cellsByRow = new Map<number, ParsedCell[]>();
      for (const cell of cells) {
        let arr = cellsByRow.get(cell.r);
        if (!arr) {
          arr = [];
          cellsByRow.set(cell.r, arr);
        }
        arr.push(cell);
      }

      for (const [rowIdx, rowCells] of cellsByRow) {
        // Find left label (leftmost non-numeric cell in the row)
        let leftLabel = "";
        let numericCells: { col: number; value: number }[] = [];

        // Sort cells by column
        const sorted = [...rowCells].sort((a, b) => a.c - b.c);

        for (const cell of sorted) {
          const valStr = String(cell.value ?? "").trim();
          if (!valStr) continue;

          const num = Number(valStr);
          if (!isNaN(num) && valStr !== "") {
            numericCells.push({ col: cell.c, value: num });
          } else if (!leftLabel) {
            leftLabel = valStr;
          }
        }

        // Need at least 3 numeric cells and a non-empty left label
        if (numericCells.length < 3 || !leftLabel) continue;

        // Sort numeric cells by column
        numericCells.sort((a, b) => a.col - b.col);

        // Compute period-over-period change rates
        const rates: number[] = [];
        let skipRow = false;
        for (let i = 1; i < numericCells.length; i++) {
          const denom = numericCells[i - 1].value;
          if (Math.abs(denom) < 1000) {
            skipRow = true;
            break;
          }
          rates.push((numericCells[i].value - denom) / denom);
        }
        if (skipRow || rates.length < 2) continue;

        const minRate = Math.min(...rates);
        const maxRate = Math.max(...rates);

        // Find matching driver by normalized label
        const normRefLabel = normalizeLabel(leftLabel);
        const matchedDriver = driverByLabel.get(normRefLabel);
        if (!matchedDriver || matchedDriver.value == null) continue;

        // Compute rate from reference last value into driver value
        const lastRefValue = numericCells[numericCells.length - 1].value;
        if (Math.abs(lastRefValue) < 1000) continue;
        const modelRate = (matchedDriver.value - lastRefValue) / lastRefValue;

        // Emit when model rate falls outside [minRate, maxRate]
        if (modelRate >= minRate && modelRate <= maxRate) continue;

        const gap = modelRate < minRate
          ? Math.abs(modelRate - minRate)
          : Math.abs(modelRate - maxRate);

        const refValues = numericCells.map((c) => c.value).join(", ");
        const verbatim = trunc(`${leftLabel}: ${refValues}`, 500);

        // Build A1-style address for the reference row
        const firstCol = numericCells[0].col;
        const colLetter = String.fromCharCode(65 + Math.min(firstCol, 25));
        const refA1 = `${sheet.sheet_or_page}!${colLetter}${rowIdx + 1}`;

        const driverLocator = matchedDriver.origin_locator ?? "unknown";
        const originLocator = `${driverLocator} versus ${refA1}`;

        const proposition =
          `"${leftLabel}" in reference document "${refDoc.file_name}" has historical growth rates ` +
          `ranging from ${(minRate * 100).toFixed(1)}% to ${(maxRate * 100).toFixed(1)}%, ` +
          `but the model implies a rate of ${(modelRate * 100).toFixed(1)}%. ` +
          `The forecast breaks the historical series.`;

        rows.push({
          proposition,
          origin_doc_id: refDoc.id,
          origin_locator: originLocator,
          verbatim,
          quantified: true,
          value: matchedDriver.value,
          detector: "reference_trend_break",
          reliance_link_id: null,
        });
      }
    }
  }

  // Sort by absolute gap descending
  rows.sort((a, b) => {
    // Re-extract gap from the proposition rates — instead, store gap on object
    // We'll use a secondary sort key extracted from proposition
    return 0; // placeholder, replaced below
  });

  // Re-sort properly: extract model rate and nearest bound from proposition
  // Simpler: tag rows with gap during construction. Refactor using a wrapper.
  // Since we have the gap data available, let's use a different approach:
  // build an array of { row, gap } and sort that.
  interface TaggedRow extends EmergentRow {
    _gap: number;
  }

  const taggedRows: TaggedRow[] = [];
  // Rebuild — we need the gap. Rather than re-parse, let's just redo with a map.
  // Actually, we have the rows but not the gap. The cleanest fix is to store gap during generation.
  // Let's take a simpler approach: re-sort by parsing from the proposition.

  for (const row of rows) {
    const rateMatch = row.proposition.match(
      /ranging from ([-\d.]+)% to ([-\d.]+)%, but the model implies a rate of ([-\d.]+)%/,
    );
    if (!rateMatch) {
      taggedRows.push({ ...row, _gap: 0 });
      continue;
    }
    const minR = parseFloat(rateMatch[1]) / 100;
    const maxR = parseFloat(rateMatch[2]) / 100;
    const modelR = parseFloat(rateMatch[3]) / 100;
    const gap = modelR < minR
      ? Math.abs(modelR - minR)
      : Math.abs(modelR - maxR);
    taggedRows.push({ ...row, _gap: gap });
  }

  taggedRows.sort((a, b) => b._gap - a._gap);

  if (taggedRows.length > 100) {
    console.log(
      `${LOG_PREFIX} E3: ${taggedRows.length} reference_trend_break hits — capping at 100, dropping ${taggedRows.length - 100}.`,
    );
  }

  return taggedRows.slice(0, 100);
}

// ── Rule E4: Future Terms Divergence ────────────────────────────────

const FORWARD_TOKENS = /future|prospective|planned|remaining/i;

async function ruleFutureTermsDivergence(
  db: StageContext["db"],
  runId: string,
  modelDocId: string,
): Promise<EmergentRow[]> {
  // Load model_explicit drivers for this run
  const drivers = await db.query(
    `SELECT id, proposition, origin_locator, verbatim, value, detector
     FROM mast_assumptions
     WHERE run_id = $1::uuid
       AND origin_type = 'model_explicit'`,
    DriverRow,
    [runId],
    { label: "EMERGENT-E4: load model_explicit drivers" },
  );

  if (drivers.length === 0) {
    console.log(`${LOG_PREFIX} E4: no model_explicit drivers — skipping.`);
    return [];
  }

  // Parse label from proposition and group by (sheet, column index)
  interface DriverEntry {
    driver: typeof drivers[number];
    label: string;
    sheet: string;
    colIdx: number;
    isForward: boolean;
  }

  const entries: DriverEntry[] = [];
  for (const d of drivers) {
    if (!d.origin_locator) continue;
    const loc = parseLocator(d.origin_locator);
    if (!loc) continue;

    const colIdx = parseColFromA1(loc.addr);
    if (colIdx < 0) continue;

    // Extract label from proposition
    const labelMatch = d.proposition.match(/^(.+?)\s*=\s*/);
    if (!labelMatch) continue;
    const label = labelMatch[1].trim();
    if (!label) continue;

    const isForward = FORWARD_TOKENS.test(label);

    entries.push({
      driver: d,
      label,
      sheet: loc.sheet,
      colIdx,
      isForward,
    });
  }

  // Group by (sheet, colIdx)
  const groupKey = (e: DriverEntry) => `${e.sheet}\0${e.colIdx}`;
  const groups = new Map<string, DriverEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(entry);
  }

  const rows: EmergentRow[] = [];

  for (const [, group] of groups) {
    const forwardEntries = group.filter((e) => e.isForward);
    const observedEntries = group.filter((e) => !e.isForward);

    if (forwardEntries.length === 0 || observedEntries.length === 0) continue;

    for (const fwd of forwardEntries) {
      for (const obs of observedEntries) {
        const fwdVal = fwd.driver.value;
        const obsVal = obs.driver.value;
        if (fwdVal == null || obsVal == null) continue;

        const larger = Math.max(Math.abs(fwdVal), Math.abs(obsVal));
        if (larger === 0) continue;

        const relDiff = Math.abs(fwdVal - obsVal) / larger;
        if (relDiff <= 0.10) continue;

        const sheetName = fwd.sheet;

        const proposition =
          `The model assumes different terms for future instances than for those already observed. ` +
          `"${fwd.label}" (${fwdVal}) differs from "${obs.label}" (${obsVal}) ` +
          `by ${(relDiff * 100).toFixed(1)}% on sheet "${sheetName}".`;

        const verbatim = `${fwd.label}: ${fwdVal}, ${obs.label}: ${obsVal}`;

        const originLocator =
          `${fwd.driver.origin_locator ?? "unknown"} versus ${obs.driver.origin_locator ?? "unknown"}`;

        rows.push({
          proposition,
          origin_doc_id: modelDocId,
          origin_locator: originLocator,
          verbatim,
          quantified: true,
          value: fwdVal,
          detector: "future_terms_divergence",
          reliance_link_id: null,
        });
      }
    }
  }

  // Sort by relative difference descending — extract from proposition
  rows.sort((a, b) => {
    const da = parseFloat(a.proposition.match(/by ([\d.]+)%/)?.[1] ?? "0");
    const db_ = parseFloat(b.proposition.match(/by ([\d.]+)%/)?.[1] ?? "0");
    return db_ - da;
  });

  if (rows.length > 100) {
    console.log(
      `${LOG_PREFIX} E4: ${rows.length} future_terms_divergence hits — capping at 100, dropping ${rows.length - 100}.`,
    );
  }

  return rows.slice(0, 100);
}

// ── Write rows to mast_assumptions ──────────────────────────────────

async function writeEmergentRows(
  db: StageContext["db"],
  runId: string,
  dealId: string,
  rows: EmergentRow[],
): Promise<void> {
  for (const row of rows) {
    await db.execute(
      `INSERT INTO mast_assumptions (
         run_id, deal_id, proposition, origin_type, origin_doc_id,
         origin_locator, verbatim, quantified, value, unit, period,
         detector, reliance_link_id, recursion_depth, dedup_group_id
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'emergent', $4::uuid,
         $5, $6, $7, $8, NULL, NULL,
         $9, $10::uuid, 0, NULL
       )`,
      [
        runId,
        dealId,
        row.proposition,
        row.origin_doc_id,
        row.origin_locator,
        row.verbatim,
        row.quantified,
        row.value,
        row.detector,
        row.reliance_link_id,
      ],
      { label: `EMERGENT: insert ${row.detector}` },
    );
  }
}

// ── Stage handler ───────────────────────────────────────────────────

const emergentHandler: StageHandler = async (ctx: StageContext) => {
  const { db, runId, dealId } = ctx;

  console.log(`${LOG_PREFIX} Starting emergent assumptions stage.`);

  // ── Idempotency: delete previous emergent rows ────────────────────
  await db.execute(
    `DELETE FROM mast_assumptions
     WHERE run_id = $1::uuid AND origin_type = 'emergent'`,
    [runId],
    { label: "EMERGENT: idempotent delete" },
  );

  // ── Resolve model document (fail-closed if missing) ───────────────
  const modelDoc = await resolveModelDocument(db, dealId);
  if (!modelDoc) {
    throw new Error(
      `${LOG_PREFIX} Cannot resolve financial model document for deal ${dealId}. ` +
      `Three of four emergent rules depend on it — aborting.`,
    );
  }

  // ── Compute forecast horizon ──────────────────────────────────────
  const forecastHorizon = await computeForecastHorizon(db, modelDoc.id);

  const skipReasons: string[] = [];
  let e1Count = 0;
  let e2Count = 0;
  let e3Count = 0;
  let e4Count = 0;

  // ── E1: Implied Renewal ───────────────────────────────────────────
  if (forecastHorizon == null) {
    skipReasons.push("E1 skipped: no forecast horizon");
  } else {
    const e1Rows = await ruleImpliedRenewal(db, dealId, forecastHorizon);
    if (e1Rows.length > 0) {
      await writeEmergentRows(db, runId, dealId, e1Rows);
    }
    e1Count = e1Rows.length;
  }

  // ── E2: Management Figure Adopted ─────────────────────────────────
  const e2Rows = await ruleManagementFigureAdopted(db, runId, dealId);
  if (e2Rows.length > 0) {
    await writeEmergentRows(db, runId, dealId, e2Rows);
  }
  e2Count = e2Rows.length;

  // ── E3: Reference Trend Break ─────────────────────────────────────
  if (forecastHorizon == null) {
    skipReasons.push("E3 skipped: no forecast horizon");
  } else {
    const e3Rows = await ruleReferenceTrendBreak(
      db, runId, dealId, forecastHorizon, modelDoc.id,
    );
    if (e3Rows.length > 0) {
      await writeEmergentRows(db, runId, dealId, e3Rows);
    }
    e3Count = e3Rows.length;
  }

  // ── E4: Future Terms Divergence ───────────────────────────────────
  const e4Rows = await ruleFutureTermsDivergence(db, runId, modelDoc.id);
  if (e4Rows.length > 0) {
    await writeEmergentRows(db, runId, dealId, e4Rows);
  }
  e4Count = e4Rows.length;

  // ── Summary ───────────────────────────────────────────────────────
  const total = e1Count + e2Count + e3Count + e4Count;
  console.log(
    `${LOG_PREFIX} emergent complete: ${total} rows total — ` +
    `E1(implied_renewal)=${e1Count}, E2(management_figure_adopted)=${e2Count}, ` +
    `E3(reference_trend_break)=${e3Count}, E4(future_terms_divergence)=${e4Count}` +
    (skipReasons.length > 0 ? `. Skips: ${skipReasons.join("; ")}` : ""),
  );

  // ── Persist stage payload ───────────────────────────────────────────
  const emergentPayload = {
    e1Count,
    e2Count,
    e3Count,
    e4Count,
    total,
    skipReasons,
  };
  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, "emergent", JSON.stringify(emergentPayload)],
      { label: `${LOG_PREFIX} persist stage summary` },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }

  return {
    complete: true,
    itemsDone: total,
    itemsTotal: total,
    resumePosition: 0,
  };
};

export default emergentHandler;
