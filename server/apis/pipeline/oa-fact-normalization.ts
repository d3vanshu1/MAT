/**
 * P2 STEP 1 — OA Fact Normalization
 *
 * Reads universal_extractions for a deal, derives oa_facts from the eligible
 * arrays (data_points, key_claims, flags, stated_risks, legal_regulatory,
 * customer_revenue), deduplicates, verifies chunk offsets via content_hash,
 * populates oa_chunk_map, and inserts into oa_facts.
 *
 * Key design decisions:
 * - char_start / char_end derived from chunk_index (N * CHUNK_CHARS, min((N+1)*CHUNK_CHARS, text_length))
 * - Offset derivation verified against stored content_hash (abort on mismatch)
 * - verbatim_snippet is always NULL (never synthesized)
 * - subject_entity per D3 semantics
 * - period derived from scope_qualifier via regex (D4)
 * - source_metadata JSONB per D5 definition
 * - stated_or_derived normalization per D6
 * - Dedup on (document_id, subject_entity, predicate, value, unit, period, scope_qualifier)
 * - Checkpoint per document in oa_stage_checkpoints
 * - NEVER emits from 'omissions' array
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { computeContentHash, CHUNK_CHARS } from "./extraction-prompt.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

// Page sizes for paginated reads
const EXTRACTION_PAGE_SIZE = 50;
const DOCUMENT_PAGE_SIZE = 20;

// Memo order derivation from file_name patterns
function deriveMemoOrder(fileName: string): number | null {
  const lower = fileName.toLowerCase();
  if (/screening/i.test(lower)) return 1;
  if (/2nd\s*ic|second\s*ic/i.test(lower)) return 2;
  if (/3rd\s*ic|third\s*ic/i.test(lower)) return 3;
  if (/ic\s*update|update\s*ic/i.test(lower)) return 4;
  // Generic IC memo without specific ordering indicator
  if (/ic\s*memo/i.test(lower) && !/(2nd|3rd|second|third|update|screening)/i.test(lower)) return 1;
  return null;
}

// Document role derivation
function deriveDocumentRole(documentTag: string): "subject" | "reference" {
  return documentTag === "ic_memo" ? "subject" : "reference";
}

// Period extraction from scope_qualifier (D4)
function derivePeriod(scopeQualifier: string): string | null {
  if (!scopeQualifier || scopeQualifier === "NONE_STATED" || scopeQualifier === "UNSCOPED_BY_NATURE") {
    return null;
  }
  // FY\d{2,4}
  const fyMatch = scopeQualifier.match(/FY\s?\d{2,4}/gi);
  if (fyMatch) return fyMatch.join(" / ").replace(/\s+/g, "");
  // Q[1-4] FY?\d{2}
  const qMatch = scopeQualifier.match(/Q[1-4]\s?(?:FY)?\d{2}/gi);
  if (qMatch) return qMatch.join(" / ");
  // LTM Mon-YY
  const ltmMatch = scopeQualifier.match(/LTM\s+\w{3}-\d{2}/i);
  if (ltmMatch) return ltmMatch[0];
  // L3Y, L\d+Y
  const lnyMatch = scopeQualifier.match(/L\d+Y/i);
  if (lnyMatch) return lnyMatch[0];
  // Mon-YY (e.g., Mar-26)
  const monYrMatch = scopeQualifier.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}\b/i);
  if (monYrMatch) return monYrMatch[0];
  // Full year 19xx or 20xx
  const yearMatch = scopeQualifier.match(/\b(19|20)\d{2}\b/g);
  if (yearMatch) return yearMatch.join(" / ");
  return null;
}

// stated_or_derived normalization (D6)
function normalizeStatedOrDerived(raw: string | undefined | null): "stated" | "derived" {
  if (!raw) return "stated";
  const lower = raw.toLowerCase().trim();
  if (lower === "derived") return "derived";
  if (["stated", "explicit", "explicitly_stated", "explicitly stated", "explicitly"].includes(lower)) return "stated";
  // Unrecognised — default to "stated" (logged by caller)
  return "stated";
}

// adviser_severity normalization — only allow high/medium/low
function normalizeAdviserSeverity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (["high", "medium", "low"].includes(lower)) return lower;
  // Map extraction severity terms to the 3-tier
  if (lower === "critical") return "high";
  if (lower === "moderate") return "medium";
  return null;
}

// ─── Fact emission functions per array type ─────────────────────────────────

interface RawFact {
  fact_type: string;
  subject_entity: string | null;
  predicate: string | null;
  value: string | null;
  unit: string | null;
  period: string | null;
  scope_qualifier: string;
  verbatim_snippet: null;
  adviser_severity: string | null;
  adviser_disposition: string | null;
  stated_or_derived: "stated" | "derived";
  source_metadata: Record<string, unknown> | null;
}

function emitFromDataPoints(items: any[]): RawFact[] {
  return (items || []).map((dp: any) => ({
    fact_type: "data_point",
    subject_entity: null, // D3
    predicate: dp.metric || null,
    value: dp.value || null,
    unit: null,
    period: derivePeriod(dp.scope_qualifier || "NONE_STATED"),
    scope_qualifier: dp.scope_qualifier || "NONE_STATED",
    verbatim_snippet: null,
    adviser_severity: null,
    adviser_disposition: null,
    stated_or_derived: normalizeStatedOrDerived(dp.stated_or_derived),
    source_metadata: {
      context: dp.context || null,
      category: dp.category || null,
      perspective: dp.perspective || null,
    },
  }));
}

function emitFromKeyClaims(items: any[]): RawFact[] {
  return (items || []).map((kc: any) => ({
    fact_type: "key_claim",
    subject_entity: null, // D3
    predicate: kc.claim || null,
    value: null,
    unit: null,
    period: null,
    scope_qualifier: "UNSCOPED_BY_NATURE",
    verbatim_snippet: null,
    adviser_severity: null,
    adviser_disposition: null,
    stated_or_derived: "stated",
    source_metadata: {
      claim_type: kc.claim_type || null,
      dimension: kc.dimension || null,
      source_type: kc.source_type || null,
      location: kc.location || null,
      confidence: kc.confidence || null,
    },
  }));
}

function emitFromFlags(items: any[]): RawFact[] {
  return (items || []).map((f: any) => ({
    fact_type: "flag",
    subject_entity: null, // D3
    predicate: f.description || null,
    value: null,
    unit: null,
    period: null,
    scope_qualifier: "NONE_STATED",
    verbatim_snippet: null,
    adviser_severity: normalizeAdviserSeverity(f.adviser_severity ?? null),
    adviser_disposition: f.adviser_disposition || null,
    stated_or_derived: "stated",
    source_metadata: {
      type: f.type || null,
      severity: f.severity || null,
    },
  }));
}

function emitFromStatedRisks(items: any[]): RawFact[] {
  return (items || []).map((r: any) => ({
    fact_type: "stated_risk",
    subject_entity: null, // D3
    predicate: r.risk || null,
    value: null,
    unit: null,
    period: null,
    scope_qualifier: "NONE_STATED",
    verbatim_snippet: null,
    adviser_severity: null,
    adviser_disposition: null,
    stated_or_derived: "stated",
    source_metadata: {
      mitigant_offered: r.mitigant_offered || null,
    },
  }));
}

function emitFromLegalRegulatory(items: any[]): RawFact[] {
  return (items || []).map((lr: any) => ({
    fact_type: "legal_regulatory",
    subject_entity: lr.topic || null, // D3: topic is the entity
    predicate: lr.detail || null,
    value: null,
    unit: null,
    period: null,
    scope_qualifier: "NONE_STATED",
    verbatim_snippet: null,
    adviser_severity: null,
    adviser_disposition: null,
    stated_or_derived: "stated",
    source_metadata: {},
  }));
}

function emitFromCustomerRevenue(items: any[]): RawFact[] {
  return (items || []).map((cr: any) => ({
    fact_type: "customer_revenue",
    subject_entity: cr.customer || null, // D3: customer is the entity
    predicate: cr.metric_cited || cr.revenue_share || null,
    value: cr.revenue_share || null,
    unit: null,
    period: null,
    scope_qualifier: "NONE_STATED",
    verbatim_snippet: null,
    adviser_severity: null,
    adviser_disposition: null,
    stated_or_derived: "stated",
    source_metadata: {
      contract_detail: cr.contract_detail || null,
    },
  }));
}

// ─── Dedup key ──────────────────────────────────────────────────────────────

function dedupKey(docId: string, f: RawFact): string {
  return [
    docId,
    f.subject_entity ?? "",
    f.predicate ?? "",
    f.value ?? "",
    f.unit ?? "",
    f.period ?? "",
    f.scope_qualifier,
  ].join("|##|");
}

// ─── Main API ───────────────────────────────────────────────────────────────

const DocumentRow = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string(),
  text_length: z.number(),
});

const ExtractionRow = z.object({
  document_id: z.string(),
  chunk_index: z.number(),
  extraction_json: z.any(),
  content_hash: z.string().nullable(),
});

const ParsedTextRow = z.object({
  parsed_text: z.string(),
});

export default api({
  name: "OaFactNormalization",
  description: "Normalizes universal_extractions into oa_facts with offset verification and oa_chunk_map population.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    dealId: z.string(),
    dryRun: z.boolean().optional(),
    reset: z.boolean().optional(),
    documentId: z.string().optional(),
  }),
  output: z.object({
    documents: z.array(z.object({
      document_id: z.string(),
      document_name: z.string(),
      chunks_processed: z.number(),
      facts_emitted: z.number(),
      facts_after_dedup: z.number(),
      chunk_offset_verified: z.number(),
      chunk_offset_mismatch: z.number(),
    })),
    totals: z.object({
      total_facts_emitted: z.number(),
      total_facts_after_dedup: z.number(),
      total_chunks_verified: z.number(),
      total_mismatches: z.number(),
      chunk_map_rows_inserted: z.number(),
    }),
    warnings: z.array(z.string()),
    stated_or_derived_warnings: z.array(z.string()),
  }),
  async run(ctx, { dealId, dryRun, reset, documentId }) {
    const isDryRun = dryRun ?? false;
    const warnings: string[] = [];
    const statedOrDerivedWarnings: string[] = [];

    // Reset: clear previous run state if requested
    if (reset && !isDryRun) {
      await ctx.integrations.db.execute(
        `DELETE FROM oa_facts WHERE deal_id = $1::uuid`,
        [dealId],
        { label: "Reset: clear oa_facts" }
      );
      await ctx.integrations.db.execute(
        `DELETE FROM oa_chunk_map WHERE deal_id = $1::uuid`,
        [dealId],
        { label: "Reset: clear oa_chunk_map" }
      );
      await ctx.integrations.db.execute(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'fact_normalization'`,
        [dealId],
        { label: "Reset: clear fact_normalization checkpoints" }
      );
      warnings.push("RESET: cleared existing oa_facts, oa_chunk_map, and checkpoints");
    }

    // 1. Load documents for this deal (optionally filtered by documentId)
    const docQuery = documentId
      ? `SELECT id, file_name, document_tag, LENGTH(parsed_text) as text_length
         FROM documents
         WHERE deal_id = $1 AND parsed_text IS NOT NULL AND id = $2
         ORDER BY file_name`
      : `SELECT id, file_name, document_tag, LENGTH(parsed_text) as text_length
         FROM documents
         WHERE deal_id = $1 AND parsed_text IS NOT NULL
         ORDER BY file_name`;
    const docParams = documentId ? [dealId, documentId] : [dealId];
    const documents = await ctx.integrations.db.query(
      docQuery,
      DocumentRow,
      docParams,
      { label: "Load deal documents" }
    );

    const results: Array<{
      document_id: string;
      document_name: string;
      chunks_processed: number;
      facts_emitted: number;
      facts_after_dedup: number;
      chunk_offset_verified: number;
      chunk_offset_mismatch: number;
    }> = [];

    let totalChunkMapRows = 0;

    // 2. Process each document
    for (const doc of documents) {
      // Check if already processed (checkpoint)
      const existingCheckpoint = await ctx.integrations.db.query(
        `SELECT status FROM oa_stage_checkpoints
         WHERE run_id = $1::uuid AND stage = 'fact_normalization' AND unit_key = $2
         LIMIT 1`,
        z.object({ status: z.string() }),
        [dealId, doc.id],
        { label: `Check checkpoint: ${doc.file_name}` }
      );
      if (existingCheckpoint.length > 0 && existingCheckpoint[0].status === "complete") {
        warnings.push(`Skipping ${doc.file_name}: already checkpointed as complete`);
        continue;
      }

      // Load extractions for this document (paginated)
      const docExtractions: Array<z.infer<typeof ExtractionRow>> = [];
      let offset = 0;
      while (true) {
        const page = await ctx.integrations.db.query(
          `SELECT document_id, chunk_index, extraction_json, content_hash
           FROM universal_extractions
           WHERE deal_id = $1 AND document_id = $2
           ORDER BY chunk_index
           LIMIT ${EXTRACTION_PAGE_SIZE} OFFSET ${offset}`,
          ExtractionRow,
          [dealId, doc.id],
          { label: `Load extractions: ${doc.file_name} offset=${offset}` }
        );
        docExtractions.push(...page);
        if (page.length < EXTRACTION_PAGE_SIZE) break;
        offset += EXTRACTION_PAGE_SIZE;
      }

      if (docExtractions.length === 0) {
        warnings.push(`Skipping ${doc.file_name}: no extractions found`);
        // Checkpoint as skipped
        if (!isDryRun) {
          await ctx.integrations.db.execute(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, reason)
             VALUES ($1::uuid, 'fact_normalization', $2, 'skipped', 'no extractions')
             ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET status = 'skipped', reason = 'no extractions', updated_at = now()`,
            [dealId, doc.id],
            { label: `Checkpoint skip: ${doc.file_name}` }
          );
        }
        continue;
      }

      // ─── Offset verification: load parsed_text and verify content_hash ───
      const textRows = await ctx.integrations.db.query(
        `SELECT parsed_text FROM documents WHERE id = $1`,
        ParsedTextRow,
        [doc.id],
        { label: `Load parsed_text: ${doc.file_name}` }
      );
      const parsedText = textRows.length > 0 ? textRows[0].parsed_text : "";
      const textLength = parsedText.length;

      let chunksVerified = 0;
      let chunksMismatched = 0;
      const chunkMapInserts: Array<{ chunk_index: number; char_start: number; char_end: number; content_hash: string }> = [];

      for (const ext of docExtractions) {
        const charStart = ext.chunk_index * CHUNK_CHARS;
        const charEnd = Math.min((ext.chunk_index + 1) * CHUNK_CHARS, textLength);
        const slice = parsedText.slice(charStart, charEnd);
        const computedHash = computeContentHash(slice);

        if (ext.content_hash && computedHash !== ext.content_hash) {
          chunksMismatched++;
          warnings.push(
            `HASH MISMATCH: ${doc.file_name} chunk ${ext.chunk_index}: ` +
            `computed=${computedHash}, stored=${ext.content_hash}`
          );
        } else {
          chunksVerified++;
        }

        chunkMapInserts.push({
          chunk_index: ext.chunk_index,
          char_start: charStart,
          char_end: charEnd,
          content_hash: computedHash,
        });
      }

      // STOP if any mismatches for this document
      if (chunksMismatched > 0) {
        warnings.push(`ABORTING ${doc.file_name}: ${chunksMismatched} hash mismatches. Offsets unverified.`);
        if (!isDryRun) {
          await ctx.integrations.db.execute(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, reason)
             VALUES ($1::uuid, 'fact_normalization', $2, 'failed', $3)
             ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET status = 'failed', reason = $3, updated_at = now()`,
            [dealId, doc.id, `${chunksMismatched} content_hash mismatches`],
            { label: `Checkpoint fail: ${doc.file_name}` }
          );
        }
        results.push({
          document_id: doc.id,
          document_name: doc.file_name,
          chunks_processed: docExtractions.length,
          facts_emitted: 0,
          facts_after_dedup: 0,
          chunk_offset_verified: chunksVerified,
          chunk_offset_mismatch: chunksMismatched,
        });
        continue;
      }

      // ─── Populate oa_chunk_map for this document (batched) ────────────────
      if (!isDryRun) {
        const CM_BATCH = 50;
        for (let ci = 0; ci < chunkMapInserts.length; ci += CM_BATCH) {
          const cmBatch = chunkMapInserts.slice(ci, ci + CM_BATCH);
          const cmValues: string[] = [];
          const cmParams: any[] = [];
          let pi = 1;
          for (const cm of cmBatch) {
            cmValues.push(`($${pi}::uuid, $${pi+1}::uuid, $${pi+2}, $${pi+3}, $${pi+4}, $${pi+5})`);
            cmParams.push(dealId, doc.id, cm.chunk_index, cm.char_start, cm.char_end, cm.content_hash);
            pi += 6;
          }
          await ctx.integrations.db.execute(
            `INSERT INTO oa_chunk_map (deal_id, document_id, chunk_index, char_start, char_end, content_hash)
             VALUES ${cmValues.join(", ")}
             ON CONFLICT (document_id, chunk_index) DO UPDATE
               SET char_start = EXCLUDED.char_start, char_end = EXCLUDED.char_end, content_hash = EXCLUDED.content_hash`,
            cmParams,
            { label: `Insert chunk_map batch: ${doc.file_name} [${ci}..${ci + cmBatch.length}]` }
          );
        }
        totalChunkMapRows += chunkMapInserts.length;
      }

      // ─── Emit facts from eligible arrays ──────────────────────────────────
      const documentRole = deriveDocumentRole(doc.document_tag);
      const memoOrder = deriveMemoOrder(doc.file_name);
      const allFactsRaw: Array<RawFact & { chunk_index: number }> = [];

      for (const ext of docExtractions) {
        const wrapper = typeof ext.extraction_json === "string"
          ? JSON.parse(ext.extraction_json)
          : ext.extraction_json;

        // Skip failed extractions
        if (wrapper?.failed || wrapper?.error || wrapper?.__failed) continue;

        // The actual extraction content is in wrapper.extraction as a string with sanitized braces
        const rawExtractionStr = wrapper?.extraction;
        if (!rawExtractionStr || typeof rawExtractionStr !== "string") continue;

        // Desanitize braces: ﹛ (U+FE5B) → { and ﹜ (U+FE5C) → }
        const desanitized = rawExtractionStr.replace(/\uFE5B/g, "{").replace(/\uFE5C/g, "}");
        
        // Find first { to start parsing (skip any preamble)
        const jsonStart = desanitized.indexOf("{");
        if (jsonStart === -1) continue;
        
        let extraction: any;
        try {
          extraction = JSON.parse(desanitized.slice(jsonStart));
        } catch {
          warnings.push(`JSON parse failed: ${doc.file_name} chunk ${ext.chunk_index}`);
          continue;
        }

        const fromDataPoints = emitFromDataPoints(extraction.data_points);
        const fromKeyClaims = emitFromKeyClaims(extraction.key_claims);
        const fromFlags = emitFromFlags(extraction.flags);
        const fromStatedRisks = emitFromStatedRisks(extraction.stated_risks);
        const fromLegalReg = emitFromLegalRegulatory(extraction.legal_regulatory);
        const fromCustRev = emitFromCustomerRevenue(extraction.customer_revenue);

        // Check stated_or_derived for unrecognised values
        for (const dp of (extraction.data_points || [])) {
          const raw = dp.stated_or_derived;
          if (raw && !["stated", "derived", "explicit", "explicitly_stated", "explicitly stated", "explicitly"].includes(
            (raw as string).toLowerCase().trim()
          )) {
            statedOrDerivedWarnings.push(`Unrecognised stated_or_derived="${raw}" in ${doc.file_name} chunk ${ext.chunk_index}`);
          }
        }

        const chunkFacts = [
          ...fromDataPoints,
          ...fromKeyClaims,
          ...fromFlags,
          ...fromStatedRisks,
          ...fromLegalReg,
          ...fromCustRev,
        ];
        for (const f of chunkFacts) {
          allFactsRaw.push({ ...f, chunk_index: ext.chunk_index });
        }
      }

      // ─── Deduplicate ──────────────────────────────────────────────────────
      const seen = new Set<string>();
      const dedupedFacts: Array<RawFact & { chunk_index: number }> = [];
      for (const f of allFactsRaw) {
        const key = dedupKey(doc.id, f);
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedFacts.push(f);
      }

      // ─── Insert into oa_facts (with source_metadata) ─────────────────────
      if (!isDryRun && dedupedFacts.length > 0) {
        // Batch insert in groups of 50 (21 params each = 1050 params max, within PG limit)
        const BATCH_SIZE = 50;
        for (let i = 0; i < dedupedFacts.length; i += BATCH_SIZE) {
          const batch = dedupedFacts.slice(i, i + BATCH_SIZE);
          const values: string[] = [];
          const params: any[] = [];
          let paramIdx = 1;

          for (let bi = 0; bi < batch.length; bi++) {
            const f = batch[bi];
            const charStart = f.chunk_index * CHUNK_CHARS;
            const charEnd = Math.min((f.chunk_index + 1) * CHUNK_CHARS, textLength);
            const claimId = `${doc.id}:${f.chunk_index}:${i + bi}`;

            values.push(
              `($${paramIdx}::uuid, $${paramIdx + 1}, $${paramIdx + 2}::uuid, $${paramIdx + 3}, $${paramIdx + 4}, ` +
              `$${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9}, ` +
              `$${paramIdx + 10}, $${paramIdx + 11}, $${paramIdx + 12}, $${paramIdx + 13}, $${paramIdx + 14}, ` +
              `$${paramIdx + 15}, $${paramIdx + 16}, $${paramIdx + 17}, $${paramIdx + 18}, $${paramIdx + 19}, $${paramIdx + 20}::jsonb)`
            );
            params.push(
              dealId,                           // deal_id
              claimId,                          // claim_id
              doc.id,                           // document_id
              doc.file_name,                    // document_name
              documentRole,                     // document_role
              doc.document_tag,                 // document_tag
              f.chunk_index,                    // chunk_index
              charStart,                        // char_start
              charEnd,                          // char_end
              f.fact_type,                      // fact_type
              f.subject_entity,                 // subject_entity
              f.predicate,                      // predicate
              f.value,                          // value
              f.unit,                           // unit
              f.period,                         // period
              f.scope_qualifier,                // scope_qualifier
              f.adviser_severity,               // adviser_severity
              f.adviser_disposition,            // adviser_disposition
              f.stated_or_derived,              // stated_or_derived
              memoOrder,                        // memo_order
              (f.source_metadata && Object.keys(f.source_metadata).length > 0)
                ? JSON.stringify(f.source_metadata)
                : null,                         // source_metadata
            );
            paramIdx += 21;
          }

          await ctx.integrations.db.execute(
            `INSERT INTO oa_facts (
              deal_id, claim_id, document_id, document_name, document_role,
              document_tag, chunk_index, char_start, char_end, fact_type,
              subject_entity, predicate, value, unit, period,
              scope_qualifier, adviser_severity, adviser_disposition, stated_or_derived, memo_order, source_metadata
            ) VALUES ${values.join(", ")}`,
            params,
            { label: `Insert oa_facts batch: ${doc.file_name} [${i}..${i + batch.length}]` }
          );
        }
      }

      // ─── Checkpoint complete ──────────────────────────────────────────────
      if (!isDryRun) {
        await ctx.integrations.db.execute(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
           VALUES ($1::uuid, 'fact_normalization', $2, 'complete', $3::jsonb)
           ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET status = 'complete', payload_json = $3::jsonb, updated_at = now()`,
          [dealId, doc.id, JSON.stringify({
            facts_emitted: allFactsRaw.length,
            facts_after_dedup: dedupedFacts.length,
            chunks_processed: docExtractions.length,
          })],
          { label: `Checkpoint complete: ${doc.file_name}` }
        );
      }

      results.push({
        document_id: doc.id,
        document_name: doc.file_name,
        chunks_processed: docExtractions.length,
        facts_emitted: allFactsRaw.length,
        facts_after_dedup: dedupedFacts.length,
        chunk_offset_verified: chunksVerified,
        chunk_offset_mismatch: chunksMismatched,
      });
    }

    return {
      documents: results,
      totals: {
        total_facts_emitted: results.reduce((s, r) => s + r.facts_emitted, 0),
        total_facts_after_dedup: results.reduce((s, r) => s + r.facts_after_dedup, 0),
        total_chunks_verified: results.reduce((s, r) => s + r.chunk_offset_verified, 0),
        total_mismatches: results.reduce((s, r) => s + r.chunk_offset_mismatch, 0),
        chunk_map_rows_inserted: totalChunkMapRows,
      },
      warnings,
      stated_or_derived_warnings: statedOrDerivedWarnings,
    };
  },
});
