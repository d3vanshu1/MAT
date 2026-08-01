/**
 * ExportReplayEvidence — Full 273-row export of the disposition ledger
 * with complete finding content.
 *
 * Reads the disposition ledger (tree_level=97) and the original findings
 * (tree_level=98), joins them, and returns separate arrays by class plus
 * the complete 273-row mapping.
 *
 * Returns chunked base64 output for large payloads.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// Full record schema for each row in the ledger
const ExportRecordSchema = z.object({
  corpus_index: z.number(),
  finding_id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  full_analysis: z.string().nullable(),
  severity: z.string().nullable(),
  finding_kind: z.string().nullable(),
  category: z.string().nullable(),
  issue_key: z.string().nullable(),
  source_docs: z.array(z.string()).nullable(),
  source_document_ids: z.array(z.string()).nullable(),
  claim_ids: z.array(z.string()).nullable(),
  originating_claim_id: z.string().nullable(),
  source_tag: z.string().nullable(),
  disposition: z.string(),
  classification_reason: z.string(),
  l3_node: z.number(),
});

type ExportRecord = z.infer<typeof ExportRecordSchema>;

export default api({
  name: "ExportReplayEvidence",
  description: "Exports full 273-row disposition ledger with finding content, by class",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    chunkIndex: z.number().default(0),
    chunkSize: z.number().default(50),
  }),

  output: z.object({
    total_findings: z.number(),
    chunk_index: z.number(),
    chunk_size: z.number(),
    total_chunks: z.number(),
    records: z.array(ExportRecordSchema),
    // Summary counts (always returned, even in chunked mode)
    counts: z.object({
      retained_as_contradiction_candidate: z.number(),
      excluded_wrong_module: z.number(),
      supporting_evidence: z.number(),
      confirmed_claim: z.number(),
      process_diagnostic: z.number(),
      source_recommendation: z.number(),
      scope_limitation: z.number(),
    }),
  }),

  async run(ctx, { runId, chunkIndex, chunkSize }) {
    // Load the disposition ledger (tree_level=97)
    const LedgerRow = z.object({
      merged_json: z.any(),
    });
    const ledgerRows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 97 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      LedgerRow,
      [runId],
      { label: "Load disposition ledger (tree_level=97)" }
    );

    if (ledgerRows.length === 0) {
      throw new Error(`No disposition ledger found for run ${runId} at tree_level=97`);
    }

    const rawLedger = ledgerRows[0].merged_json;
    const ledgerParsed = typeof rawLedger === "string" ? JSON.parse(rawLedger) : rawLedger;
    const ledger = (ledgerParsed.ledger || ledgerParsed) as Array<{
      corpus_index: number;
      finding_id: string;
      disposition: string;
      reason: string;
      source_tag: string | null;
      severity: string | null;
      title: string;
      has_originating_claim: boolean;
      category: string | null;
      l3_node: number;
    }>;

    // Load the original findings corpus (tree_level=98)
    const CorpusRow = z.object({
      merged_json: z.any(),
      node_index: z.number(),
    });
    const corpusRows = await ctx.integrations.db.query(
      `SELECT merged_json, node_index FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98
       ORDER BY node_index ASC`,
      CorpusRow,
      [runId],
      { label: "Load original findings corpus (tree_level=98)" }
    );

    if (corpusRows.length === 0) {
      throw new Error(`No findings corpus found for run ${runId} at tree_level=98`);
    }

    // Also load original L3 nodes (tree_level=3) for full detail/analysis content
    const l3Rows = await ctx.integrations.db.query(
      `SELECT merged_json, node_index FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 3 AND status = 'complete'
       ORDER BY node_index ASC`,
      CorpusRow,
      [runId],
      { label: "Load original L3 nodes for full finding content" }
    );

    // Parse all findings from corpus nodes
    interface RawFinding {
      finding_id?: string;
      id?: string;
      title: string;
      detail?: string;
      full_analysis?: string;
      evidence?: string;
      severity?: string;
      finding_kind?: string;
      category?: string;
      issue_key?: string;
      source_docs?: string[];
      source_document_ids?: string[];
      claim_ids?: string[];
      originating_claim_id?: string;
      source_tag?: string;
      _l3_node_index?: number;
      l3_node?: number;
    }

    const findingsMap = new Map<string, RawFinding & { l3_node: number }>();

    // Helper: get the canonical ID from a finding
    function getFindingId(f: RawFinding): string | null {
      return f.finding_id || f.id || null;
    }

    // First load L3 data (has full detail/analysis/evidence)
    for (const row of l3Rows) {
      const rawJson = row.merged_json;
      const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
      const findings: RawFinding[] = parsed.findings || (Array.isArray(parsed) ? parsed : []);
      for (const f of findings) {
        const fid = getFindingId(f);
        if (fid) {
          findingsMap.set(fid, { ...f, l3_node: f._l3_node_index ?? row.node_index });
        }
      }
    }

    // Then overlay tree_level=98 data (may have normalized fields + _l3_node_index)
    for (const row of corpusRows) {
      const rawJson = row.merged_json;
      const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
      const findings: RawFinding[] = parsed.findings || (Array.isArray(parsed) ? parsed : []);
      for (const f of findings) {
        const fid = getFindingId(f);
        if (!fid) continue;
        const existing = findingsMap.get(fid);
        if (existing) {
          // Keep L3 detail/analysis if tree_level=98 doesn't have it
          findingsMap.set(fid, {
            ...existing,
            ...f,
            detail: f.detail || existing.detail,
            full_analysis: f.full_analysis || existing.full_analysis,
            evidence: f.evidence || existing.evidence,
            l3_node: f._l3_node_index ?? existing.l3_node,
          });
        } else {
          findingsMap.set(fid, { ...f, l3_node: f._l3_node_index ?? row.node_index });
        }
      }
    }

    // Join ledger with findings
    const allRecords: ExportRecord[] = [];
    const counts = {
      retained_as_contradiction_candidate: 0,
      excluded_wrong_module: 0,
      supporting_evidence: 0,
      confirmed_claim: 0,
      process_diagnostic: 0,
      source_recommendation: 0,
      scope_limitation: 0,
    };

    for (const entry of ledger) {
      const finding = findingsMap.get(entry.finding_id);
      const record: ExportRecord = {
        corpus_index: entry.corpus_index,
        finding_id: entry.finding_id,
        title: entry.title || finding?.title || "UNKNOWN",
        detail: finding?.detail || finding?.evidence || null,
        full_analysis: finding?.full_analysis || finding?.evidence || null,
        severity: entry.severity || finding?.severity || null,
        finding_kind: finding?.finding_kind || null,
        category: entry.category || finding?.category || null,
        issue_key: finding?.issue_key || null,
        source_docs: finding?.source_docs || null,
        source_document_ids: finding?.source_document_ids || null,
        claim_ids: finding?.claim_ids || null,
        originating_claim_id: finding?.originating_claim_id || null,
        source_tag: entry.source_tag || finding?.source_tag || null,
        disposition: entry.disposition,
        classification_reason: entry.reason,
        l3_node: entry.l3_node ?? finding?.l3_node ?? -1,
      };
      allRecords.push(record);

      // Count
      if (record.disposition in counts) {
        counts[record.disposition as keyof typeof counts]++;
      }
    }

    // Sort by corpus_index
    allRecords.sort((a, b) => a.corpus_index - b.corpus_index);

    // Chunk output
    const totalChunks = Math.ceil(allRecords.length / chunkSize);
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, allRecords.length);
    const records = allRecords.slice(start, end);

    return {
      total_findings: allRecords.length,
      chunk_index: chunkIndex,
      chunk_size: chunkSize,
      total_chunks: totalChunks,
      records,
      counts,
    };
  },
});
