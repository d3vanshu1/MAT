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
// Stopwords — common English function words + deal-generic low-signal terms
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // Function words
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "also", "that", "this", "with", "from", "into",
  "does", "each", "which", "their", "will", "would", "there", "what", "about",
  "when", "make", "like", "been", "more", "other", "could", "after", "should",
  "being", "those", "still", "between", "these", "such",
  // Deal-generic low-signal terms
  "group", "company", "business", "deal", "model", "assume", "assumed",
  "assumption", "forecast", "current", "level", "support", "remain",
  "within", "across", "period",
]);

// ---------------------------------------------------------------------------
// propositionToQuery — extract discriminating terms from a proposition
// ---------------------------------------------------------------------------

export function propositionToQuery(proposition: string): string {
  const tokens = proposition
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }

  return unique.join(" ");
}

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
// Sanitise a single term for to_tsquery — only letters and digits
// ---------------------------------------------------------------------------

function sanitiseTerm(t: string): string {
  return t.replace(/[^a-z0-9]/g, "");
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

const CorpusChunkRow = z.object({
  chunk_index: z.coerce.number(),
  file_name: z.string(),
  content: z.string(),
});

// ---------------------------------------------------------------------------
// Retrieval mode names
// ---------------------------------------------------------------------------

const MODES = ["mode_a", "mode_b", "mode_c", "mode_d", "mode_e"] as const;
type ModeName = (typeof MODES)[number];

// ---------------------------------------------------------------------------
// Per-mode result
// ---------------------------------------------------------------------------

const ModeResultSchema = z.object({
  found_at_rank: z.number().nullable(),
  tag_match: z.boolean().nullable(),
  top_rank_tag: z.string().nullable(),
  chunks_returned: z.number(),
  skipped: z.boolean().optional(),
  tag_distribution: z.record(z.string(), z.number()).optional(),
});

// ---------------------------------------------------------------------------
// Per-probe result schema
// ---------------------------------------------------------------------------

const PhraseLocationSchema = z.object({
  chunk_index: z.number(),
  file_name: z.string(),
}).nullable();

const ProbeResultSchema = z.object({
  id: z.string(),
  extracted_query: z.string(),
  phrase_exists_in_corpus: z.boolean(),
  phrase_location: PhraseLocationSchema,
  mode_a: ModeResultSchema,
  mode_b: ModeResultSchema,
  mode_c: ModeResultSchema,
  mode_d: ModeResultSchema,
  mode_e: ModeResultSchema,
  verbose_chunks: z
    .record(
      z.string(),
      z.array(
        z.object({
          file_name: z.string(),
          preview: z.string(),
        }),
      ),
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
// Batch size for corpus phrase check
// ---------------------------------------------------------------------------

const CORPUS_BATCH = 500;

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
    aggregates: z.record(z.string(), AggregatesSchema).optional(),
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

    // ── Count total in-scope chunks for batched phrase check ────────
    const countRows = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.deal_id = $1::uuid
         AND d.document_tag NOT IN ('financial_model', 'ic_memo')`,
      z.object({ cnt: z.coerce.number() }),
      [dealId],
      { label: "PROBE: count in-scope chunks" },
    );
    const totalChunks = countRows.length > 0 ? countRows[0].cnt : 0;

    // ── Helper: retrieve with custom ranking SQL ────────────────────
    async function retrieveRanked(
      tsqueryExpr: string,
      rankExpr: string,
      params: unknown[],
      label: string,
    ): Promise<z.infer<typeof ChunkHitRow>[]> {
      return db.query(
        `SELECT dc.id AS chunk_id,
                dc.document_id,
                dc.file_name,
                dc.chunk_index,
                dc.content,
                ${rankExpr} AS rank,
                d.document_tag
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         CROSS JOIN ${tsqueryExpr} q
         WHERE dc.deal_id = $1::uuid
           AND dc.tsv @@ q
           AND dc.document_id != ALL($3::uuid[])
         ORDER BY rank DESC
         LIMIT 10`,
        ChunkHitRow,
        params,
        { label },
      );
    }

    // ── Convenience: standard retrieve (ts_rank_cd default) ─────────
    async function retrieve(
      tsqueryExpr: string,
      params: unknown[],
      label: string,
    ): Promise<z.infer<typeof ChunkHitRow>[]> {
      return retrieveRanked(tsqueryExpr, "ts_rank_cd(dc.tsv, q)", params, label);
    }

    // ── Helper: score hits against a probe ───────────────────────────
    function scoreHits(
      hits: z.infer<typeof ChunkHitRow>[],
      normPhrase: string,
      expectedDocTag: string,
    ): z.infer<typeof ModeResultSchema> {
      let foundAtRank: number | null = null;
      let tagMatch: boolean | null = null;

      for (let i = 0; i < hits.length; i++) {
        const normContent = normalize(hits[i].content);
        if (normContent.includes(normPhrase)) {
          foundAtRank = i + 1;
          tagMatch = hits[i].document_tag === expectedDocTag;
          break;
        }
      }

      // Tag distribution
      const tagDist: Record<string, number> = {};
      for (const h of hits) {
        const tag = h.document_tag ?? "null";
        tagDist[tag] = (tagDist[tag] ?? 0) + 1;
      }

      return {
        found_at_rank: foundAtRank,
        tag_match: tagMatch,
        top_rank_tag: hits.length > 0 ? (hits[0].document_tag ?? null) : null,
        chunks_returned: hits.length,
        tag_distribution: tagDist,
      };
    }

    // ── Helper: skipped mode result ─────────────────────────────────
    function skippedMode(): z.infer<typeof ModeResultSchema> {
      return {
        found_at_rank: null,
        tag_match: null,
        top_rank_tag: null,
        chunks_returned: 0,
        skipped: true,
      };
    }

    // ── Run each probe ──────────────────────────────────────────────
    const results: z.infer<typeof ProbeResultSchema>[] = [];

    for (const probe of PROBES) {
      const normPhrase = normalize(probe.expectedPhrase);
      const extracted = propositionToQuery(probe.proposition);
      const sanitisedTerms = extracted
        .split(" ")
        .map(sanitiseTerm)
        .filter((t) => t.length > 0);
      const hasTerms = sanitisedTerms.length > 0;
      const orExpr = hasTerms ? sanitisedTerms.join(" | ") : "";

      // ── Mode A: websearch_to_tsquery (original, control) ───────────
      const hitsA = await retrieve(
        `websearch_to_tsquery('english', $2)`,
        [dealId, probe.proposition, excludedIds],
        `PROBE-A: "${probe.id}"`,
      );
      const modeA = scoreHits(hitsA, normPhrase, probe.expectedDocTag);

      // ── Mode B: to_tsquery OR (ts_rank_cd default) ─────────────────
      let modeB: z.infer<typeof ModeResultSchema>;
      let hitsB: z.infer<typeof ChunkHitRow>[] = [];
      if (hasTerms) {
        hitsB = await retrieve(
          `to_tsquery('english', $2)`,
          [dealId, orExpr, excludedIds],
          `PROBE-B: "${probe.id}"`,
        );
        modeB = scoreHits(hitsB, normPhrase, probe.expectedDocTag);
      } else {
        modeB = skippedMode();
      }

      // ── Mode C: plainto_tsquery AND ────────────────────────────────
      let modeC: z.infer<typeof ModeResultSchema>;
      let hitsC: z.infer<typeof ChunkHitRow>[] = [];
      if (hasTerms) {
        hitsC = await retrieve(
          `plainto_tsquery('english', $2)`,
          [dealId, extracted, excludedIds],
          `PROBE-C: "${probe.id}"`,
        );
        modeC = scoreHits(hitsC, normPhrase, probe.expectedDocTag);
      } else {
        modeC = skippedMode();
      }

      // ── Mode D: to_tsquery OR, ts_rank_cd with normalization 32 ────
      let modeD: z.infer<typeof ModeResultSchema>;
      let hitsD: z.infer<typeof ChunkHitRow>[] = [];
      if (hasTerms) {
        hitsD = await retrieveRanked(
          `to_tsquery('english', $2)`,
          "ts_rank_cd(dc.tsv, q, 32)",
          [dealId, orExpr, excludedIds],
          `PROBE-D: "${probe.id}"`,
        );
        modeD = scoreHits(hitsD, normPhrase, probe.expectedDocTag);
      } else {
        modeD = skippedMode();
      }

      // ── Mode E: to_tsquery OR, rank by distinct term count, ────────
      //    tiebreak by ts_rank_cd
      let modeE: z.infer<typeof ModeResultSchema>;
      let hitsE: z.infer<typeof ChunkHitRow>[] = [];
      if (hasTerms) {
        // Build individual tsquery checks to count distinct matching terms
        const termCountParts = sanitisedTerms.map(
          (t) => `CASE WHEN dc.tsv @@ to_tsquery('english', '${t}') THEN 1 ELSE 0 END`,
        );
        const termCountExpr = termCountParts.join(" + ");
        const rankExpr = `(${termCountExpr})::float + ts_rank_cd(dc.tsv, q) * 0.001`;

        hitsE = await retrieveRanked(
          `to_tsquery('english', $2)`,
          rankExpr,
          [dealId, orExpr, excludedIds],
          `PROBE-E: "${probe.id}"`,
        );
        modeE = scoreHits(hitsE, normPhrase, probe.expectedDocTag);
      } else {
        modeE = skippedMode();
      }

      // ── phrase_exists_in_corpus — batched normalized scan ───────────
      let phraseExists = false;
      let phraseLocation: z.infer<typeof PhraseLocationSchema> = null;

      for (let offset = 0; offset < totalChunks; offset += CORPUS_BATCH) {
        const batch = await db.query(
          `SELECT dc.chunk_index, dc.file_name, dc.content
           FROM document_chunks dc
           JOIN documents d ON d.id = dc.document_id
           WHERE dc.deal_id = $1::uuid
             AND d.document_tag NOT IN ('financial_model', 'ic_memo')
           ORDER BY dc.document_id, dc.chunk_index
           LIMIT $2 OFFSET $3`,
          CorpusChunkRow,
          [dealId, CORPUS_BATCH, offset],
          { label: `PROBE: corpus scan batch ${offset} for "${probe.id}"` },
        );

        for (const row of batch) {
          if (normalize(row.content).includes(normPhrase)) {
            phraseExists = true;
            phraseLocation = {
              chunk_index: row.chunk_index,
              file_name: row.file_name,
            };
            break;
          }
        }

        if (phraseExists) break;
        if (batch.length < CORPUS_BATCH) break;
      }

      // ── Verbose ────────────────────────────────────────────────────
      let verboseChunks:
        | Record<string, { file_name: string; preview: string }[]>
        | undefined;
      if (verbose) {
        verboseChunks = {};
        for (const [mode, hits] of [
          ["mode_a", hitsA],
          ["mode_b", hitsB],
          ["mode_c", hitsC],
          ["mode_d", hitsD],
          ["mode_e", hitsE],
        ] as const) {
          verboseChunks[mode] = hits.slice(0, 3).map((h) => ({
            file_name: h.file_name,
            preview: h.content.slice(0, 200),
          }));
        }
      }

      results.push({
        id: probe.id,
        extracted_query: extracted,
        phrase_exists_in_corpus: phraseExists,
        phrase_location: phraseLocation,
        mode_a: modeA,
        mode_b: modeB,
        mode_c: modeC,
        mode_d: modeD,
        mode_e: modeE,
        ...(verboseChunks ? { verbose_chunks: verboseChunks } : {}),
      });
    }

    // ── Per-mode aggregates ─────────────────────────────────────────
    const aggregates: Record<string, z.infer<typeof AggregatesSchema>> = {};

    for (const mode of MODES) {
      const ranks: number[] = [];
      let foundAny = 0;
      let found1to3 = 0;
      let phraseNotRetrieved = 0;

      for (const r of results) {
        const mr = r[mode];
        if (mr.skipped) continue;
        if (mr.found_at_rank != null) {
          foundAny++;
          ranks.push(mr.found_at_rank);
          if (mr.found_at_rank <= 3) found1to3++;
        } else if (r.phrase_exists_in_corpus) {
          phraseNotRetrieved++;
        }
      }

      aggregates[mode] = {
        total_probes: PROBES.length,
        found_any_rank: foundAny,
        found_rank_1_to_3: found1to3,
        phrase_in_corpus_but_not_retrieved: phraseNotRetrieved,
        mean_rank:
          ranks.length > 0
            ? ranks.reduce((a, b) => a + b, 0) / ranks.length
            : null,
      };
    }

    return { results, aggregates };
  },
});
