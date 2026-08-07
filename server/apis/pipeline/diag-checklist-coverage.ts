/**
 * FP-D1 — Diagnose WHY the omission_audit checklist scan failed to catch
 * false-absence findings.
 *
 * For a set of known false-absence topics, reports:
 *  1. DOC PRESENCE: full-text search of document_chunks (same websearch_to_tsquery
 *     mechanism as runChecklistScan). How many chunks match, which file_names,
 *     whether any matching chunk comes from an IC memo document.
 *  2. CHECKLIST MAPPING: which DILIGENCE_CHECKLIST category(ies) correspond to
 *     the topic, or "NO CHECKLIST CATEGORY" if none.
 *  3. COVERAGE VERDICT: reconstructed status ("covered"/"not_found") using the
 *     same search logic the checklist scanner would produce.
 *
 * Read-only. No production change.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { DILIGENCE_CHECKLIST } from "./diligence-checklist.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_DEAL = "c46b4129-8a16-48ae-ad3a-1da061255445";

// The 8 known false-absence topics to investigate
const DEFAULT_TOPICS = [
  "NRR / net revenue retention",
  "M&A pipeline",
  "earn-out mechanics",
  "interest cover / leverage stress",
  "capex forecast",
  "recurring revenue",
  "Gamma single-supplier concentration",
  "vertical strategy risk",
];

// Manual mapping of topics → search queries (websearch_to_tsquery compatible)
// These represent what a human would expect to find if searching for the topic.
const TOPIC_SEARCH_QUERIES: Record<string, string[]> = {
  "NRR / net revenue retention": [
    "NRR OR net revenue retention",
    "GRR OR gross revenue retention",
    "logo retention OR net expansion",
  ],
  "M&A pipeline": [
    "M&A pipeline OR acquisition pipeline",
    "merger OR acquisition OR target OR bolt-on",
    "buy-and-build OR acquisition strategy",
  ],
  "earn-out mechanics": [
    "earn-out OR earnout OR deferred consideration",
    "contingent payment OR performance milestone",
    "seller earn-out OR completion accounts",
  ],
  "interest cover / leverage stress": [
    "interest cover OR interest coverage ratio",
    "leverage stress OR debt stress test",
    "debt service OR DSCR OR fixed charge coverage",
  ],
  "capex forecast": [
    "capex forecast OR capital expenditure forecast",
    "capex plan OR capex budget OR capex projection",
    "maintenance capex OR growth capex",
  ],
  "recurring revenue": [
    "recurring revenue OR ARR OR MRR",
    "subscription revenue OR contracted revenue",
    "revenue visibility OR revenue backlog",
  ],
  "Gamma single-supplier concentration": [
    "Gamma OR single supplier",
    "supplier concentration OR vendor dependency",
    "supply chain risk OR sole supplier",
  ],
  "vertical strategy risk": [
    "vertical strategy OR vertical integration",
    "market vertical OR sector strategy",
    "vertical risk OR sector concentration",
  ],
};

// IC memo file_name pattern — matches "IC Memo", "IC_Memo", "IC update"
const IC_MEMO_PATTERN = /IC[_ ]Memo|IC update/i;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ChunkMatchSchema = z.object({
  file_name: z.string(),
  chunk_index: z.coerce.number(),
  rank: z.coerce.number(),
});

const RunSelectSchema = z.object({
  id: z.string(),
  module_id: z.string(),
  finding_count: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

const TopicResultSchema = z.object({
  topic: z.string(),
  doc_presence: z.object({
    chunk_count: z.number(),
    file_names: z.array(z.string()),
    memo_chunk_matched: z.boolean(),
    memo_file_names: z.array(z.string()),
  }),
  checklist_category: z.object({
    mapped: z.boolean(),
    category_ids: z.array(z.string()),
    category_labels: z.array(z.string()),
  }),
  coverage_status: z.string(), // "covered" | "not_found" | "no_category"
  coverage_detail: z.string(), // Explanation of the verdict
});

const SummarySchema = z.object({
  run_id: z.string(),
  finding_count: z.number(),
  total_topics: z.number(),
  retrievable_from_memo: z.number(),
  has_checklist_category: z.number(),
  both_retrievable_and_categorized: z.number(),
  failure_modes: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "DiagChecklistCoverage",
  description: "Diagnoses why checklist scan missed false-absence findings.",

  integrations: {
    db: postgres(DB_ID),
  },

  input: z.object({
    topics: z.array(z.string()).nullable().optional(),
  }),

  output: z.object({
    summary: SummarySchema,
    topics: z.array(TopicResultSchema),
  }),

  async run(ctx, { topics }) {
    const topicList = topics && topics.length > 0 ? topics : DEFAULT_TOPICS;

    // 1. Auto-select OA run (largest finding count for the SCG deal)
    const runs = await ctx.integrations.db.query(
      `SELECT mr.id, mr.module_id,
              jsonb_array_length(mo.findings)::int AS finding_count
       FROM module_runs mr
       JOIN module_outputs mo ON mo.module_run_id = mr.id
       WHERE mr.deal_id = $1
         AND mr.module_id = 'omission_audit'
         AND mr.status = 'completed'
       ORDER BY finding_count DESC
       LIMIT 1`,
      RunSelectSchema,
      [SCG_DEAL],
      { label: "Select OA run with most findings" }
    );

    if (runs.length === 0) {
      throw new Error("No completed omission_audit run found for the SCG deal.");
    }

    const selectedRun = runs[0];

    // 2. Process each topic
    const results: z.infer<typeof TopicResultSchema>[] = [];

    for (const topic of topicList) {
      const queries = TOPIC_SEARCH_QUERIES[topic];
      if (!queries) {
        results.push({
          topic,
          doc_presence: { chunk_count: 0, file_names: [], memo_chunk_matched: false, memo_file_names: [] },
          checklist_category: { mapped: false, category_ids: [], category_labels: [] },
          coverage_status: "error",
          coverage_detail: `No search queries defined for topic "${topic}"`,
        });
        continue;
      }

      // 2a. DOC PRESENCE — run each query against document_chunks for the deal
      const allFileNames = new Set<string>();
      const memoFileNames = new Set<string>();
      let totalChunks = 0;

      for (const query of queries) {
        try {
          const hits = await ctx.integrations.db.query(
            `SELECT dc.file_name, dc.chunk_index,
                    ts_rank_cd(dc.tsv, q) AS rank
             FROM document_chunks dc,
                  websearch_to_tsquery('english', $2) q
             WHERE dc.deal_id = $1
               AND dc.tsv @@ q
             ORDER BY rank DESC
             LIMIT 50`,
            ChunkMatchSchema,
            [SCG_DEAL, query],
            { label: `Topic search: "${topic}" — query: "${query.slice(0, 50)}"` }
          );

          totalChunks += hits.length;
          for (const hit of hits) {
            allFileNames.add(hit.file_name);
            if (IC_MEMO_PATTERN.test(hit.file_name)) {
              memoFileNames.add(hit.file_name);
            }
          }
        } catch (err) {
          // Skip bad queries, log but continue
          console.warn(`[diag-checklist-coverage] Query failed for "${topic}": "${query}"`, err);
        }
      }

      const docPresence = {
        chunk_count: totalChunks,
        file_names: [...allFileNames].sort(),
        memo_chunk_matched: memoFileNames.size > 0,
        memo_file_names: [...memoFileNames].sort(),
      };

      // 2b. CHECKLIST MAPPING — find matching categories
      const matchedCategories: { id: string; label: string }[] = [];
      const topicLower = topic.toLowerCase();

      for (const cat of DILIGENCE_CHECKLIST) {
        // Check if any of the category's queries overlap with the topic's search terms
        // Also check if the category label/description mentions the topic
        const labelMatch =
          cat.label.toLowerCase().includes(topicLower) ||
          topicLower.includes(cat.label.toLowerCase());

        const queryOverlap = cat.queries.some((catQuery) => {
          const catTerms = catQuery.toLowerCase().split(/\s+OR\s+|\s+/);
          const topicTerms = queries
            .flatMap((q) => q.toLowerCase().split(/\s+OR\s+|\s+/))
            .filter((t) => t.length > 2);
          return catTerms.some(
            (ct) => topicTerms.includes(ct) || topicTerms.some((tt) => ct.includes(tt) || tt.includes(ct))
          );
        });

        const descMatch = cat.description.toLowerCase().includes(topicLower) ||
          queries.some((q) =>
            q
              .split(/\s+OR\s+/)
              .some((term) => cat.description.toLowerCase().includes(term.trim().toLowerCase()))
          );

        if (labelMatch || queryOverlap || descMatch) {
          matchedCategories.push({ id: cat.id, label: cat.label });
        }
      }

      const checklistCategory = {
        mapped: matchedCategories.length > 0,
        category_ids: matchedCategories.map((c) => c.id),
        category_labels: matchedCategories.map((c) => c.label),
      };

      // 2c. COVERAGE VERDICT — replay what the scanner would produce for the mapped categories
      let coverageStatus: string;
      let coverageDetail: string;

      if (matchedCategories.length === 0) {
        coverageStatus = "no_category";
        coverageDetail =
          "No DILIGENCE_CHECKLIST category maps to this topic. The checklist scan never searched for it.";
      } else {
        // Run the ACTUAL category queries (from DILIGENCE_CHECKLIST) to see what the scanner saw
        let categoryHitCount = 0;
        const categoryHitFiles = new Set<string>();

        for (const mc of matchedCategories) {
          const cat = DILIGENCE_CHECKLIST.find((c) => c.id === mc.id)!;
          for (const catQuery of cat.queries) {
            try {
              const hits = await ctx.integrations.db.query(
                `SELECT dc.file_name, dc.chunk_index,
                        ts_rank_cd(dc.tsv, q) AS rank
                 FROM document_chunks dc,
                      websearch_to_tsquery('english', $2) q
                 WHERE dc.deal_id = $1
                   AND dc.tsv @@ q
                 ORDER BY rank DESC
                 LIMIT 5`,
                ChunkMatchSchema,
                [SCG_DEAL, catQuery],
                { label: `Category replay: ${mc.id} — "${catQuery.slice(0, 50)}"` }
              );

              categoryHitCount += hits.length;
              for (const hit of hits) {
                categoryHitFiles.add(hit.file_name);
              }
            } catch {
              // swallow
            }
          }
        }

        if (categoryHitCount > 0) {
          coverageStatus = "covered";
          coverageDetail = `Checklist scan WOULD have marked this "covered" (${categoryHitCount} hits across ${categoryHitFiles.size} files: ${[...categoryHitFiles].slice(0, 5).join(", ")}). The scan DID find evidence — so the merge layer received a COVERED signal. The false-absence finding must have originated upstream (extraction/merge ignoring coverage map).`;
        } else {
          coverageStatus = "not_found";
          coverageDetail = `Checklist scan produced 0 hits for category queries. The merge layer would have received a NOT_FOUND signal — this is a genuine scan miss (queries too narrow for the actual document content).`;
        }
      }

      results.push({
        topic,
        doc_presence: docPresence,
        checklist_category: checklistCategory,
        coverage_status: coverageStatus,
        coverage_detail: coverageDetail,
      });
    }

    // 3. Build summary
    const retrievableFromMemo = results.filter((r) => r.doc_presence.memo_chunk_matched).length;
    const hasCategory = results.filter((r) => r.checklist_category.mapped).length;
    const both = results.filter(
      (r) => r.doc_presence.memo_chunk_matched && r.checklist_category.mapped
    ).length;

    // Identify failure modes
    const failureModes: string[] = [];
    const noCategoryTopics = results.filter((r) => !r.checklist_category.mapped);
    if (noCategoryTopics.length > 0) {
      failureModes.push(
        `${noCategoryTopics.length} topics have NO checklist category — scanner never searched for them: ${noCategoryTopics.map((r) => r.topic).join("; ")}`
      );
    }
    const coveredButFalseAbsence = results.filter(
      (r) => r.coverage_status === "covered" && r.doc_presence.memo_chunk_matched
    );
    if (coveredButFalseAbsence.length > 0) {
      failureModes.push(
        `${coveredButFalseAbsence.length} topics are both RETRIEVABLE from memos AND marked "covered" by the scanner — meaning the merge layer IGNORED the coverage map signal: ${coveredButFalseAbsence.map((r) => r.topic).join("; ")}`
      );
    }
    const notFoundButRetrievable = results.filter(
      (r) => r.coverage_status === "not_found" && r.doc_presence.chunk_count > 0
    );
    if (notFoundButRetrievable.length > 0) {
      failureModes.push(
        `${notFoundButRetrievable.length} topics are retrievable from docs but scanner returned NOT_FOUND — category queries are too narrow: ${notFoundButRetrievable.map((r) => r.topic).join("; ")}`
      );
    }

    return {
      summary: {
        run_id: selectedRun.id,
        finding_count: selectedRun.finding_count,
        total_topics: topicList.length,
        retrievable_from_memo: retrievableFromMemo,
        has_checklist_category: hasCategory,
        both_retrievable_and_categorized: both,
        failure_modes: failureModes,
      },
      topics: results,
    };
  },
});
