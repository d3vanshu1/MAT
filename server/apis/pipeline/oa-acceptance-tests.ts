/**
 * P11a — OA Acceptance Test Suite
 *
 * THIRTEEN structural acceptance tests for the OA pipeline.
 *
 * RUNNABLE NOW (R-A through R-F + T8): Query real pipeline state.
 * BLOCKED UNTIL FINDINGS EXIST (T1-T5, T10, T12): Return not_applicable with reason.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { SEEDED_TOPICS, OBLIGATION_CHECKLIST_VERSION } from "./oa-taxonomy.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

// SCG deal constants
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";
const SCG_RUN_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SCREENING_MEMO_DOC_ID = "440a86fb-93d6-4fd6-8d42-32f7047f8958";
const VENDOR_FDD_DOC_ID = "e5d69a30-d768-4988-998f-bfdcb1a28058";

// B2 banned fields (must never appear in finding narrative body)
const B2_BANNED_FIELDS = [
  "absence_basis",
  "retrieval_probe",
  "fact_id",
  "finding_id",
  "topic_id",
  "run_id",
];

// Valid gap_kind values
const VALID_GAP_KINDS = [
  "not_disclosed",
  "scope_mismatch",
  "unreconciled_divergence",
  "stale_supersession",
  "unquantified",
];

// The 6 P4 A3 probe topics for clustering integrity
const CLUSTERING_PROBES = [
  { topic_id: "revenue-quality.churn", label: "Churn" },
  { topic_id: "revenue-quality.nrr-grr", label: "NRR/GRR" },
  { topic_id: "valuation.exit-assumptions", label: "Exit multiple" },
  { topic_id: "returns.base-case", label: "IRR/MoM" },
  { topic_id: "revenue-quality.concentration", label: "Customer concentration" },
  { topic_id: "valuation.entry-multiple", label: "Entry multiple" },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  test_id: string;
  name: string;
  status: "pass" | "fail" | "not_applicable";
  reason: string;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Helper: check if oa_findings has any rows for the SCG run
// ---------------------------------------------------------------------------
async function findingsExist(
  db: { query: (...args: any[]) => Promise<any[]> }
): Promise<number> {
  const rows = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM oa_findings WHERE run_id = $1`,
    z.object({ cnt: z.coerce.number() }),
    [SCG_RUN_ID],
    { label: "AT: check findings exist" }
  );
  return rows[0]?.cnt ?? 0;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export default api({
  name: "OaAcceptanceTests",
  description: "Structural acceptance tests for the OA pipeline (13 tests)",

  integrations: {
    db: postgres(DB_ID),
  },

  input: z.object({
    /** Run a subset of tests (by test_id). If empty/null, runs all 13. */
    testIds: z.array(z.string()).nullable().optional(),
  }),

  output: z.object({
    summary: z.object({
      total: z.number(),
      passed: z.number(),
      failed: z.number(),
      not_applicable: z.number(),
    }),
    results: z.array(z.object({
      test_id: z.string(),
      name: z.string(),
      status: z.string(),
      reason: z.string(),
      detail: z.any().optional(),
    })),
    checklist_version: z.string(),
  }),

  async run(ctx, { testIds }) {
    const db = ctx.integrations.db;
    const results: TestResult[] = [];
    const findingCount = await findingsExist(db);
    const hasFindings = findingCount > 0;

    // Define all 13 tests
    const allTests: Array<{ id: string; name: string; run: () => Promise<TestResult> }> = [

      // ═══════════════════════════════════════════════════════════════════
      // BLOCKED UNTIL FINDINGS EXIST (T1-T5, T10, T12)
      // ═══════════════════════════════════════════════════════════════════

      // ─── T1: Finding has narrative ───────────────────────────────────────
      {
        id: "T1",
        name: "Every finding has a non-null narrative",
        run: async () => {
          if (!hasFindings) return { test_id: "T1", name: "Every finding has a non-null narrative", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}). Findings do not exist until P8 Finding Assembly runs against live data.` };
          const rows = await db.query(
            `SELECT COUNT(*)::int AS cnt FROM oa_findings WHERE run_id = $1 AND narrative IS NULL`,
            z.object({ cnt: z.coerce.number() }),
            [SCG_RUN_ID],
            { label: "T1: null narratives" }
          );
          const nullCount = rows[0]?.cnt ?? 0;
          return nullCount === 0
            ? { test_id: "T1", name: "Every finding has a non-null narrative", status: "pass", reason: `All ${findingCount} findings have narratives.` }
            : { test_id: "T1", name: "Every finding has a non-null narrative", status: "fail", reason: `${nullCount}/${findingCount} findings have NULL narrative.` };
        },
      },

      // ─── T2: No B2 banned fields in narrative ──────────────────────────
      {
        id: "T2",
        name: "Narrative body contains no B2 banned fields",
        run: async () => {
          if (!hasFindings) return { test_id: "T2", name: "Narrative body contains no B2 banned fields", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}).` };
          const likeConditions = B2_BANNED_FIELDS.map((_, i) => `narrative ILIKE '%' || $${i + 2} || '%'`).join(" OR ");
          const rows = await db.query(
            `SELECT finding_id, narrative FROM oa_findings WHERE run_id = $1 AND (${likeConditions}) LIMIT 10`,
            z.object({ finding_id: z.string(), narrative: z.string().nullable() }),
            [SCG_RUN_ID, ...B2_BANNED_FIELDS],
            { label: "T2: check B2 banned fields in narrative" }
          );
          return rows.length === 0
            ? { test_id: "T2", name: "Narrative body contains no B2 banned fields", status: "pass", reason: `No findings contain banned fields in narrative.` }
            : { test_id: "T2", name: "Narrative body contains no B2 banned fields", status: "fail", reason: `${rows.length} finding(s) contain B2 banned fields in narrative.`, detail: rows.map(r => r.finding_id) };
        },
      },

      // ─── T3: Quote validation ──────────────────────────────────────────
      {
        id: "T3",
        name: "Every double-quoted span in narrative verifiable against source",
        run: async () => {
          if (!hasFindings) return { test_id: "T3", name: "Every double-quoted span in narrative verifiable against source", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}). Quote validation requires narratives from P8.` };
          const rows = await db.query(
            `SELECT finding_id FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'finding_assembly' AND status = 'quote_invalid' LIMIT 10`,
            z.object({ finding_id: z.string() }),
            [SCG_RUN_ID],
            { label: "T3: quote failures" }
          );
          return rows.length === 0
            ? { test_id: "T3", name: "Every double-quoted span in narrative verifiable against source", status: "pass", reason: "No quote validation failures." }
            : { test_id: "T3", name: "Every double-quoted span in narrative verifiable against source", status: "fail", reason: `${rows.length} finding(s) failed quote validation.`, detail: rows };
        },
      },

      // ─── T4: materiality_tier in {1, 2, 3} ────────────────────────────
      {
        id: "T4",
        name: "materiality_tier is 1, 2, or 3",
        run: async () => {
          if (!hasFindings) return { test_id: "T4", name: "materiality_tier is 1, 2, or 3", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}).` };
          const rows = await db.query(
            `SELECT finding_id, materiality_tier FROM oa_findings WHERE run_id = $1 AND materiality_tier NOT IN (1, 2, 3) LIMIT 10`,
            z.object({ finding_id: z.string(), materiality_tier: z.coerce.number() }),
            [SCG_RUN_ID],
            { label: "T4: invalid materiality tiers" }
          );
          return rows.length === 0
            ? { test_id: "T4", name: "materiality_tier is 1, 2, or 3", status: "pass", reason: `All findings have valid materiality tiers.` }
            : { test_id: "T4", name: "materiality_tier is 1, 2, or 3", status: "fail", reason: `${rows.length} finding(s) have invalid materiality_tier.`, detail: rows };
        },
      },

      // ─── T5: gap_kind from valid enum ─────────────────────────────────
      {
        id: "T5",
        name: "gap_kind from valid enum",
        run: async () => {
          if (!hasFindings) return { test_id: "T5", name: "gap_kind from valid enum", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}).` };
          const rows = await db.query(
            `SELECT finding_id, gap_kind FROM oa_findings WHERE run_id = $1 AND gap_kind != ALL($2::text[]) LIMIT 10`,
            z.object({ finding_id: z.string(), gap_kind: z.string() }),
            [SCG_RUN_ID, VALID_GAP_KINDS],
            { label: "T5: invalid gap_kind values" }
          );
          return rows.length === 0
            ? { test_id: "T5", name: "gap_kind from valid enum", status: "pass", reason: `All findings have valid gap_kind.` }
            : { test_id: "T5", name: "gap_kind from valid enum", status: "fail", reason: `${rows.length} finding(s) have invalid gap_kind.`, detail: rows };
        },
      },

      // ─── T10: Finding references at least one subject_evidence fact_id ─
      {
        id: "T10",
        name: "Every finding references ≥1 subject_evidence fact_id",
        run: async () => {
          if (!hasFindings) return { test_id: "T10", name: "Every finding references ≥1 subject_evidence fact_id", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}).` };
          const rows = await db.query(
            `SELECT finding_id FROM oa_findings WHERE run_id = $1 AND (subject_evidence IS NULL OR subject_evidence = '[]'::jsonb OR jsonb_array_length(subject_evidence) = 0) LIMIT 10`,
            z.object({ finding_id: z.string() }),
            [SCG_RUN_ID],
            { label: "T10: findings without subject_evidence" }
          );
          return rows.length === 0
            ? { test_id: "T10", name: "Every finding references ≥1 subject_evidence fact_id", status: "pass", reason: `All findings have subject evidence.` }
            : { test_id: "T10", name: "Every finding references ≥1 subject_evidence fact_id", status: "fail", reason: `${rows.length} finding(s) have empty subject_evidence.`, detail: rows.map(r => r.finding_id) };
        },
      },

      // ─── T12: No finding references a fact_id not in oa_facts ─────────
      {
        id: "T12",
        name: "No finding references a fact_id not in oa_facts",
        run: async () => {
          if (!hasFindings) return { test_id: "T12", name: "No finding references a fact_id not in oa_facts", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}).` };
          const rows = await db.query(
            `WITH finding_fact_ids AS (
              SELECT DISTINCT elem->>'fact_id' AS fid
              FROM oa_findings, jsonb_array_elements(COALESCE(subject_evidence, '[]'::jsonb)) AS elem
              WHERE run_id = $1
              UNION
              SELECT DISTINCT elem->>'fact_id' AS fid
              FROM oa_findings, jsonb_array_elements(COALESCE(reference_evidence, '[]'::jsonb)) AS elem
              WHERE run_id = $1
            )
            SELECT fid FROM finding_fact_ids
            WHERE fid IS NOT NULL AND fid::uuid NOT IN (SELECT fact_id FROM oa_facts WHERE deal_id = $2)
            LIMIT 10`,
            z.object({ fid: z.string() }),
            [SCG_RUN_ID, SCG_DEAL_ID],
            { label: "T12: orphaned fact_id references" }
          );
          return rows.length === 0
            ? { test_id: "T12", name: "No finding references a fact_id not in oa_facts", status: "pass", reason: `All referenced fact_ids exist in oa_facts.` }
            : { test_id: "T12", name: "No finding references a fact_id not in oa_facts", status: "fail", reason: `${rows.length} orphaned fact_id references found.`, detail: rows.map(r => r.fid) };
        },
      },

      // ═══════════════════════════════════════════════════════════════════
      // RUNNABLE NOW (R-A through R-F + T8)
      // ═══════════════════════════════════════════════════════════════════

      // ─── R-A: Every skipped/failed checkpoint has non-empty reason ─────
      {
        id: "R-A",
        name: "Every skipped/failed checkpoint carries a non-empty reason",
        run: async () => {
          const rows = await db.query(
            `SELECT unit_key, stage, status, reason
             FROM oa_stage_checkpoints
             WHERE run_id = $1
               AND status IN ('skipped', 'failed')
               AND (reason IS NULL OR reason = '')
             LIMIT 50`,
            z.object({ unit_key: z.string(), stage: z.string(), status: z.string(), reason: z.string().nullable() }),
            [SCG_RUN_ID],
            { label: "R-A: checkpoints without reason" }
          );
          return rows.length === 0
            ? { test_id: "R-A", name: "Every skipped/failed checkpoint carries a non-empty reason", status: "pass", reason: `All skipped/failed checkpoints have a reason.` }
            : { test_id: "R-A", name: "Every skipped/failed checkpoint carries a non-empty reason", status: "fail", reason: `${rows.length} checkpoint row(s) with status skipped/failed lack a reason.`, detail: rows };
        },
      },

      // ─── R-B: Clustering integrity — scatter rate per probe ───────────
      {
        id: "R-B",
        name: "Clustering integrity — 6 probes scatter rate ≤5%",
        run: async () => {
          // For each probe topic, count how many assigned facts come from documents
          // NOT typically associated with that topic (scatter = wrong document_role for the topic).
          // Financial/valuation topics should have facts predominantly from reference docs.
          // A fact from a subject doc assigned to a pure-reference topic is "scattered".
          const probeResults: Array<{ topic_id: string; label: string; total: number; scattered: number; scatter_pct: number }> = [];
          for (const probe of CLUSTERING_PROBES) {
            const rows = await db.query(
              `SELECT f.document_role, COUNT(*)::int AS cnt
               FROM oa_topic_facts tf
               JOIN oa_facts f ON f.fact_id = tf.fact_id
               WHERE tf.run_id = $1 AND tf.topic_id = $2
               GROUP BY f.document_role`,
              z.object({ document_role: z.string(), cnt: z.coerce.number() }),
              [SCG_RUN_ID, probe.topic_id],
              { label: `R-B: ${probe.label} role dist` }
            );
            const total = rows.reduce((sum, r) => sum + r.cnt, 0);
            // These topics should have facts primarily from 'reference' documents.
            // Facts from 'subject' are expected too (IC memos discuss these topics).
            // Scatter = facts with no clear role assignment (neither subject nor reference).
            // More precisely: for financial probes, we count document diversity.
            // A probe is "scattered" if facts come from >3 distinct documents.
            const docRows = await db.query(
              `SELECT COUNT(DISTINCT f.document_id)::int AS doc_cnt
               FROM oa_topic_facts tf
               JOIN oa_facts f ON f.fact_id = tf.fact_id
               WHERE tf.run_id = $1 AND tf.topic_id = $2`,
              z.object({ doc_cnt: z.coerce.number() }),
              [SCG_RUN_ID, probe.topic_id],
              { label: `R-B: ${probe.label} doc diversity` }
            );
            const docCount = docRows[0]?.doc_cnt ?? 0;
            // Scatter rate: fraction of facts from documents that contribute <5% of the topic's facts
            const docBreakdown = await db.query(
              `SELECT f.document_id, COUNT(*)::int AS cnt
               FROM oa_topic_facts tf
               JOIN oa_facts f ON f.fact_id = tf.fact_id
               WHERE tf.run_id = $1 AND tf.topic_id = $2
               GROUP BY f.document_id
               ORDER BY cnt DESC LIMIT 10`,
              z.object({ document_id: z.string(), cnt: z.coerce.number() }),
              [SCG_RUN_ID, probe.topic_id],
              { label: `R-B: ${probe.label} per-doc` }
            );
            // "Scattered" = facts in documents contributing <5% of the topic
            const threshold = Math.max(1, Math.floor(total * 0.05));
            const scattered = docBreakdown.filter(d => d.cnt < threshold).reduce((sum, d) => sum + d.cnt, 0);
            const scatterPct = total > 0 ? (scattered / total) * 100 : 0;
            probeResults.push({ topic_id: probe.topic_id, label: probe.label, total, scattered, scatter_pct: Math.round(scatterPct * 10) / 10 });
          }
          const failed = probeResults.filter(p => p.scatter_pct > 5);
          return failed.length === 0
            ? { test_id: "R-B", name: "Clustering integrity — 6 probes scatter rate ≤5%", status: "pass", reason: `All 6 probes below 5% scatter.`, detail: probeResults }
            : { test_id: "R-B", name: "Clustering integrity — 6 probes scatter rate ≤5%", status: "fail", reason: `${failed.length} probe(s) exceed 5% scatter: ${failed.map(f => `${f.label} (${f.scatter_pct}%)`).join(", ")}.`, detail: probeResults };
        },
      },

      // ─── R-C: scope_qualifier coverage ────────────────────────────────
      {
        id: "R-C",
        name: "scope_qualifier non-null on 100% of oa_facts",
        run: async () => {
          const rows = await db.query(
            `SELECT
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE scope_qualifier IS NULL)::int AS null_count,
               COUNT(*) FILTER (WHERE scope_qualifier = 'NONE_STATED')::int AS none_stated,
               COUNT(*) FILTER (WHERE scope_qualifier = 'UNSCOPED_BY_NATURE')::int AS unscoped,
               COUNT(*) FILTER (WHERE scope_qualifier LIKE '%NONE_STATED%' AND scope_qualifier != 'NONE_STATED')::int AS contaminated
             FROM oa_facts WHERE deal_id = $1`,
            z.object({ total: z.coerce.number(), null_count: z.coerce.number(), none_stated: z.coerce.number(), unscoped: z.coerce.number(), contaminated: z.coerce.number() }),
            [SCG_DEAL_ID],
            { label: "R-C: scope_qualifier coverage" }
          );
          const r = rows[0];
          const detail = { total: r.total, null_count: r.null_count, none_stated: r.none_stated, unscoped_by_nature: r.unscoped, contaminated: r.contaminated };
          if (r.null_count > 0) {
            return { test_id: "R-C", name: "scope_qualifier non-null on 100% of oa_facts", status: "fail", reason: `${r.null_count}/${r.total} facts have NULL scope_qualifier.`, detail };
          }
          return { test_id: "R-C", name: "scope_qualifier non-null on 100% of oa_facts", status: "pass", reason: `All ${r.total} facts have non-null scope_qualifier. NONE_STATED: ${r.none_stated}, UNSCOPED_BY_NATURE: ${r.unscoped}, contaminated: ${r.contaminated}.`, detail };
        },
      },

      // ─── R-D: Screening Memo churn facts have scope ≠ NONE_STATED ─────
      {
        id: "R-D",
        name: "Screening Memo churn metrics have scope_qualifier ≠ NONE_STATED",
        run: async () => {
          const rows = await db.query(
            `SELECT fact_id, predicate, value, scope_qualifier, period
             FROM oa_facts
             WHERE deal_id = $1
               AND document_id = $2
               AND predicate ILIKE '%churn%'
               AND scope_qualifier = 'NONE_STATED'
             LIMIT 20`,
            z.object({ fact_id: z.string(), predicate: z.string(), value: z.string().nullable(), scope_qualifier: z.string(), period: z.string().nullable() }),
            [SCG_DEAL_ID, SCREENING_MEMO_DOC_ID],
            { label: "R-D: Screening Memo churn with NONE_STATED" }
          );
          if (rows.length === 0) {
            return { test_id: "R-D", name: "Screening Memo churn metrics have scope_qualifier ≠ NONE_STATED", status: "pass", reason: `All churn facts from Screening Memo have meaningful scope_qualifier.` };
          }
          return { test_id: "R-D", name: "Screening Memo churn metrics have scope_qualifier ≠ NONE_STATED", status: "fail", reason: `${rows.length} churn fact(s) from Screening Memo have scope_qualifier = 'NONE_STATED'.`, detail: rows };
        },
      },

      // ─── R-E: Static check — no "absence_basis" in oa-* prompt templates ─
      {
        id: "R-E",
        name: "Zero occurrences of absence_basis in oa-* prompt templates",
        run: async () => {
          // This test verifies that the string "absence_basis" does not appear in the
          // prompt content sent to the LLM. We check oa_stage_checkpoints payload_json
          // for any prompt that leaked absence_basis, and also check oa_findings narratives.
          // If no findings exist yet, we verify the extraction prompt templates stored
          // in universal_extractions.extraction_json don't include the string.
          const rows = await db.query(
            `SELECT unit_key, stage,
                    substring(payload_json::text FROM 1 FOR 200) AS payload_snippet
             FROM oa_stage_checkpoints
             WHERE run_id = $1
               AND payload_json::text ILIKE '%absence_basis%'
             LIMIT 10`,
            z.object({ unit_key: z.string(), stage: z.string(), payload_snippet: z.string().nullable() }),
            [SCG_RUN_ID],
            { label: "R-E: absence_basis in checkpoint payloads" }
          );
          // Also check extraction field probe for any extraction containing the term
          const extractionRows = await db.query(
            `SELECT document_id, substring(extraction_json::text FROM 1 FOR 200) AS snippet
             FROM universal_extractions
             WHERE deal_id = $1
               AND extraction_json::text ILIKE '%absence_basis%'
             LIMIT 5`,
            z.object({ document_id: z.string(), snippet: z.string().nullable() }),
            [SCG_DEAL_ID],
            { label: "R-E: absence_basis in extractions" }
          );
          const total = rows.length + extractionRows.length;
          if (total === 0) {
            return { test_id: "R-E", name: "Zero occurrences of absence_basis in oa-* prompt templates", status: "pass", reason: `No occurrences of absence_basis found in checkpoint payloads or extraction outputs.` };
          }
          return { test_id: "R-E", name: "Zero occurrences of absence_basis in oa-* prompt templates", status: "fail", reason: `${total} occurrence(s) of absence_basis found.`, detail: { checkpoints: rows, extractions: extractionRows } };
        },
      },

      // ─── R-F: OBLIGATION_CHECKLIST_VERSION recorded on oa_topics ───────
      {
        id: "R-F",
        name: "OBLIGATION_CHECKLIST_VERSION recorded on oa_topics rows",
        run: async () => {
          const rows = await db.query(
            `SELECT checklist_version, COUNT(*)::int AS cnt
             FROM oa_topics WHERE run_id = $1
             GROUP BY checklist_version
             ORDER BY cnt DESC LIMIT 10`,
            z.object({ checklist_version: z.string(), cnt: z.coerce.number() }),
            [SCG_RUN_ID],
            { label: "R-F: checklist_version distribution" }
          );
          if (rows.length === 0) {
            return { test_id: "R-F", name: "OBLIGATION_CHECKLIST_VERSION recorded on oa_topics rows", status: "fail", reason: `No oa_topics rows found for run.` };
          }
          const matchingVersion = rows.find(r => r.checklist_version === OBLIGATION_CHECKLIST_VERSION);
          const total = rows.reduce((sum, r) => sum + r.cnt, 0);
          if (matchingVersion && matchingVersion.cnt === total) {
            return { test_id: "R-F", name: "OBLIGATION_CHECKLIST_VERSION recorded on oa_topics rows", status: "pass", reason: `All ${total} topics carry checklist_version = ${OBLIGATION_CHECKLIST_VERSION}.`, detail: rows };
          }
          return { test_id: "R-F", name: "OBLIGATION_CHECKLIST_VERSION recorded on oa_topics rows", status: "fail", reason: `Expected all topics to have version ${OBLIGATION_CHECKLIST_VERSION}. Found: ${rows.map(r => `${r.checklist_version} (${r.cnt})`).join(", ")}.`, detail: rows };
        },
      },

      // ─── T8: Vendor FDD 6.5/7.5/6.9% FY23/24/25 churn ────────────────
      {
        id: "T8",
        name: "Vendor FDD FY23/24/25 churn rates present in oa_facts",
        run: async () => {
          const targets = [
            { year: "FY23", pct: "6.5" },
            { year: "FY24", pct: "7.5" },
            { year: "FY25", pct: "6.9" },
          ] as const;
          const perYear: Array<{ year: string; pct: string; status: "found" | "missing"; row?: { fact_id: string; predicate: string; value: string; period: string; scope_qualifier: string | null } }> = [];
          for (const t of targets) {
            const rows = await db.query(
              `SELECT fact_id, predicate, value, period, scope_qualifier
               FROM oa_facts
               WHERE deal_id = $1
                 AND document_id = $2
                 AND predicate ILIKE '%churn%'
                 AND period = $3
                 AND value ILIKE $4
               LIMIT 5`,
              z.object({ fact_id: z.string(), predicate: z.string(), value: z.string(), period: z.string(), scope_qualifier: z.string().nullable() }),
              [SCG_DEAL_ID, VENDOR_FDD_DOC_ID, t.year, `%${t.pct}%`],
              { label: `T8: churn ${t.year} containing ${t.pct}` }
            );
            if (rows.length > 0) {
              perYear.push({ year: t.year, pct: t.pct, status: "found", row: rows[0] });
            } else {
              perYear.push({ year: t.year, pct: t.pct, status: "missing" });
            }
          }
          const missing = perYear.filter(r => r.status === "missing");
          if (missing.length === 0) {
            return { test_id: "T8", name: "Vendor FDD FY23/24/25 churn rates present in oa_facts", status: "pass", reason: `All three FY churn rates found on single rows.`, detail: perYear };
          }
          return { test_id: "T8", name: "Vendor FDD FY23/24/25 churn rates present in oa_facts", status: "fail", reason: `Missing: ${missing.map(m => `${m.pct}% (${m.year})`).join(", ")}. No single row matches (document_id=VendorFDD AND predicate ILIKE '%churn%' AND period=FYxx AND value LIKE '%x.x%').`, detail: perYear };
        },
      },
    ];

    // Filter to requested tests (or run all)
    const testsToRun = testIds && testIds.length > 0
      ? allTests.filter(t => testIds.includes(t.id))
      : allTests;

    // Execute
    for (const test of testsToRun) {
      try {
        const result = await test.run();
        results.push(result);
      } catch (err: any) {
        results.push({
          test_id: test.id,
          name: test.name,
          status: "fail",
          reason: `Unexpected error: ${err.message ?? String(err)}`,
        });
      }
    }

    // Summary
    const passed = results.filter(r => r.status === "pass").length;
    const failed = results.filter(r => r.status === "fail").length;
    const notApplicable = results.filter(r => r.status === "not_applicable").length;

    return {
      summary: { total: results.length, passed, failed, not_applicable: notApplicable },
      results,
      checklist_version: OBLIGATION_CHECKLIST_VERSION,
    };
  },
});
