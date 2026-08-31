/**
 * mast-diag-retrieval-probe.ts
 *
 * Read-only diagnostic: measures retrieval quality against a fixed probe set.
 * Not a pipeline stage — not in STAGES or HANDLER_MAP.
 * Writes nothing to any table.
 *
 * MAST owns this API. No imports from OA, CC, BSS, ERO, or DCS.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Probe shape
// ---------------------------------------------------------------------------

export interface RetrievalProbe {
  /** Unique identifier for this probe. */
  id: string;
  /** The proposition we are searching support for. */
  proposition: string;
  /** The document_tag of the document that should contain the answer. */
  expectedDocTag: string;
  /** A distinctive phrase that appears in the passage which should be found. */
  expectedPhrase: string;
  /** Human-readable note describing what this probe tests. */
  note: string;
}

// ---------------------------------------------------------------------------
// PROBE SET INSERTION POINT
// ---------------------------------------------------------------------------
export const PROBES: RetrievalProbe[] = [
  {
    id: "P1_grr_basis",
    proposition: "Gross revenue retention is sustainable at current levels and supports the customer retention assumptions in the model",
    expectedDocTag: "consultant_report",
    expectedPhrase: "GRR has been calculated as the sum of Churn and Product",
    note: "FDD basis of preparation for retention metrics - a methodological judgment",
  },
  {
    id: "P2_flip_acquisition",
    proposition: "The Flip acquisition expanded the group's SME mobile capability in the South",
    expectedDocTag: "consultant_report",
    expectedPhrase: "Flip is a Hertfordshire-based unified communications provider offering voice, connectivity, IT, and mobile solutions to SMEs",
    note: "Expected easy hit - high lexical overlap",
  },
  {
    id: "P3_framework_termination",
    proposition: "Public sector framework contracts will remain in place across the hold period",
    expectedDocTag: "consultant_report",
    expectedPhrase: "the Trust may terminate the call-off agreement under RM6116",
    note: "Legal DD contract termination rights",
  },
  {
    id: "P4_restrictive_covenants",
    proposition: "Sellers of previously acquired businesses remain bound by non-compete restrictions",
    expectedDocTag: "consultant_report",
    expectedPhrase: "Restricted Period: 9 June 2022",
    note: "Low lexical overlap - the honest test",
  },
  {
    id: "P5_supplier_contracts",
    proposition: "The group's wholesale connectivity supply arrangements are long-standing and stable",
    expectedDocTag: "consultant_report",
    expectedPhrase: "BT Wholesale Ethernet Agreement Sept 2015",
    note: "Data room index entry - tests retrieval against list-shaped content",
  },
  {
    id: "P6_debt_security",
    proposition: "Existing group borrowings are secured against company assets",
    expectedDocTag: "consultant_report",
    expectedPhrase: "in favour of Ares Management Limited",
    note: "Low lexical overlap - debenture described without the word security",
  },
  {
    id: "P7_property_costs",
    proposition: "Property costs are fixed and the group carries no offsetting rights against rent",
    expectedDocTag: "consultant_report",
    expectedPhrase: "There is no right for the tenant deduct sums owing from the landlord from the rent",
    note: "Lease summary - memo language differs sharply from source",
  },
  {
    id: "P8_brand_protection",
    proposition: "The group's brand and trademarks are adequately protected",
    expectedDocTag: "consultant_report",
    expectedPhrase: "sporadically in its email marketing materials",
    note: "Trademark usage risk stated obliquely",
  },
  {
    id: "P9_legacy_migration",
    proposition: "Customers will migrate off legacy telephony onto hosted platforms on the forecast timeline",
    expectedDocTag: "consultant_report",
    expectedPhrase: "The primary factor is the legacy of ISDN",
    note: "CDD migration complexity - moderate overlap",
  },
  {
    id: "P10_teams_displacement",
    proposition: "Microsoft Teams adoption does not displace the group's telephony revenue",
    expectedDocTag: "consultant_report",
    expectedPhrase: "Customers often adopt hybrid setups",
    note: "CDD hybrid adoption - expected hit",
  },
];

// ---------------------------------------------------------------------------
// Normalization — lowercase, non-letter/digit/space → single space, collapse, trim
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ChunkHitRow = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  file_name: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
  rank: z.coerce.number(),
  document_tag: z.string().nullable(),
});

const ExistsRow = z.object({
  found: z.coerce.boolean(),
});

// ---------------------------------------------------------------------------
// Per-probe result schema
// ---------------------------------------------------------------------------

const ProbeResultSchema = z.object({
  id: z.string(),
  found_at_rank: z.number().nullable(),
  tag_match: z.boolean().nullable(),
  phrase_exists_in_corpus: z.boolean(),
  top_rank_tag: z.string().nullable(),
  chunks_returned: z.number(),
  verbose_chunks: z
    .array(
      z.object({
        file_name: z.string(),
        preview: z.string(),
      }),
    )
    .optional(),
});

const AggregatesSchema = z.object({
  total_probes: z.number(),
  found_any_rank: z.number(),
  found_rank_1_to_3: z.number(),
  phrase_in_corpus_but_not_retrieved: z.number(),
  mean_rank: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "MastDiagRetrievalProbe",
  description: "Measures retrieval quality against a fixed probe set",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
    verbose: z.boolean().optional().default(false),
  }),

  output: z.object({
    message: z.string().optional(),
    results: z.array(ProbeResultSchema).optional(),
    aggregates: AggregatesSchema.optional(),
  }),

  async run(ctx, { dealId, verbose }) {
    const db = ctx.integrations.ic_diligence_db;

    // ── Short-circuit if no probes supplied ─────────────────────────
    if (PROBES.length === 0) {
      return {
        message:
          "Probe set has not been supplied. Populate the PROBES array at the PROBE SET INSERTION POINT before running.",
      };
    }

    // ── Pre-fetch the set of excluded document IDs ──────────────────
    const excludedDocs = await db.query(
      `SELECT id FROM documents
       WHERE deal_id = $1::uuid
         AND document_tag IN ('financial_model', 'ic_memo')`,
      z.object({ id: z.string() }),
      [dealId],
      { label: "PROBE: get excluded doc IDs" },
    );
    const excludedIds =
      excludedDocs.length > 0
        ? excludedDocs.map((d) => d.id)
        : ["00000000-0000-0000-0000-000000000000"];

    // ── Run each probe ──────────────────────────────────────────────
    const results: z.infer<typeof ProbeResultSchema>[] = [];
    const ranksForMean: number[] = [];

    for (const probe of PROBES) {
      // 1. Retrieval: same FTS pattern the repo uses
      const hits = await db.query(
        `SELECT dc.id AS chunk_id,
                dc.document_id,
                dc.file_name,
                dc.chunk_index,
                dc.content,
                ts_rank_cd(dc.tsv, q) AS rank,
                d.document_tag
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         CROSS JOIN websearch_to_tsquery('english', $2) q
         WHERE dc.deal_id = $1::uuid
           AND dc.tsv @@ q
           AND dc.document_id != ALL($3::uuid[])
         ORDER BY rank DESC
         LIMIT 10`,
        ChunkHitRow,
        [dealId, probe.proposition, excludedIds],
        { label: `PROBE: retrieve for "${probe.id}"` },
      );

      // 2. Score: find expectedPhrase in returned chunks
      const normPhrase = normalize(probe.expectedPhrase);
      let foundAtRank: number | null = null;
      let tagMatch: boolean | null = null;

      for (let i = 0; i < hits.length; i++) {
        const normContent = normalize(hits[i].content);
        if (normContent.includes(normPhrase)) {
          foundAtRank = i + 1; // 1-based
          tagMatch = hits[i].document_tag === probe.expectedDocTag;
          break;
        }
      }

      if (foundAtRank != null) {
        ranksForMean.push(foundAtRank);
      }

      // 3. phrase_exists_in_corpus — independent search
      const existsRows = await db.query(
        `SELECT EXISTS (
           SELECT 1
           FROM document_chunks dc
           JOIN documents d ON d.id = dc.document_id
           WHERE dc.deal_id = $1::uuid
             AND d.document_tag NOT IN ('financial_model', 'ic_memo')
             AND dc.content ILIKE $2
         ) AS found`,
        ExistsRow,
        [dealId, `%${probe.expectedPhrase}%`],
        { label: `PROBE: phrase exists check for "${probe.id}"` },
      );
      const phraseExists = existsRows.length > 0 && existsRows[0].found;

      // 4. top_rank_tag
      const topRankTag =
        hits.length > 0 ? (hits[0].document_tag ?? null) : null;

      // 5. Verbose chunks
      let verboseChunks: { file_name: string; preview: string }[] | undefined;
      if (verbose) {
        verboseChunks = hits.slice(0, 3).map((h) => ({
          file_name: h.file_name,
          preview: h.content.slice(0, 200),
        }));
      }

      results.push({
        id: probe.id,
        found_at_rank: foundAtRank,
        tag_match: tagMatch,
        phrase_exists_in_corpus: phraseExists,
        top_rank_tag: topRankTag,
        chunks_returned: hits.length,
        ...(verboseChunks ? { verbose_chunks: verboseChunks } : {}),
      });
    }

    // ── Aggregates ──────────────────────────────────────────────────
    const totalProbes = PROBES.length;
    const foundAnyRank = results.filter((r) => r.found_at_rank != null).length;
    const foundRank1to3 = results.filter(
      (r) => r.found_at_rank != null && r.found_at_rank <= 3,
    ).length;
    const phraseInCorpusNotRetrieved = results.filter(
      (r) => r.phrase_exists_in_corpus && r.found_at_rank == null,
    ).length;
    const meanRank =
      ranksForMean.length > 0
        ? ranksForMean.reduce((a, b) => a + b, 0) / ranksForMean.length
        : null;

    return {
      results,
      aggregates: {
        total_probes: totalProbes,
        found_any_rank: foundAnyRank,
        found_rank_1_to_3: foundRank1to3,
        phrase_in_corpus_but_not_retrieved: phraseInCorpusNotRetrieved,
        mean_rank: meanRank,
      },
    };
  },
});
