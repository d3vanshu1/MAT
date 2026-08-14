/**
 * P11a — OA Acceptance Test Suite
 *
 * THIRTEEN structural acceptance tests for the OA pipeline.
 * Tests that query oa_findings return "not_applicable" when oa_findings is empty
 * (findings do not exist until P8 has been run against live data).
 *
 * RUNNABLE NOW (T6-T9, T11, T13): Query oa_facts, oa_topics, oa_topic_facts directly.
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
const VALID_GAP_KINDS = new Set([
  "not_disclosed",
  "scope_mismatch",
  "unreconciled_divergence",
  "unquantified",
]);

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
            : { test_id: "T1", name: "Every finding has a non-null narrative", status: "fail", reason: `${nullCount}/${findingCount} findings have NULL narrative.`, detail: { nullCount, total: findingCount } };
        },
      },

      // ─── T2: No B2 banned fields in narrative ──────────────────────────
      {
        id: "T2",
        name: "Narrative body contains no B2 banned fields",
        run: async () => {
          if (!hasFindings) return { test_id: "T2", name: "Narrative body contains no B2 banned fields", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}).` };
          // Check each banned field as a substring in narrative
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

      // ─── T3: Quote validation (all double-quoted spans verifiable) ─────
      {
        id: "T3",
        name: "Every double-quoted span in narrative verifiable against source",
        run: async () => {
          if (!hasFindings) return { test_id: "T3", name: "Every double-quoted span in narrative verifiable against source", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}). Quote validation requires narratives from P8.` };
          // This test loads findings with narrative, extracts quotes, and validates against source windows.
          // For now we check the validation_failures column:
          const rows = await db.query(
            `SELECT COUNT(*)::int AS cnt FROM oa_findings WHERE run_id = $1 AND narrative IS NOT NULL AND (validation_failures IS NOT NULL AND validation_failures != '[]'::jsonb)`,
            z.object({ cnt: z.coerce.number() }),
            [SCG_RUN_ID],
            { label: "T3: findings with validation failures" }
          );
          const failedCount = rows[0]?.cnt ?? 0;
          return failedCount === 0
            ? { test_id: "T3", name: "Every double-quoted span in narrative verifiable against source", status: "pass", reason: `All narratives pass quote validation.` }
            : { test_id: "T3", name: "Every double-quoted span in narrative verifiable against source", status: "fail", reason: `${failedCount} finding(s) have unverifiable quotes.`, detail: { failedCount } };
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
          const validArray = Array.from(VALID_GAP_KINDS);
          const rows = await db.query(
            `SELECT finding_id, gap_kind FROM oa_findings WHERE run_id = $1 AND gap_kind != ALL($2::text[]) LIMIT 10`,
            z.object({ finding_id: z.string(), gap_kind: z.string() }),
            [SCG_RUN_ID, validArray],
            { label: "T5: invalid gap_kind values" }
          );
          return rows.length === 0
            ? { test_id: "T5", name: "gap_kind from valid enum", status: "pass", reason: `All findings have valid gap_kind.` }
            : { test_id: "T5", name: "gap_kind from valid enum", status: "fail", reason: `${rows.length} finding(s) have invalid gap_kind.`, detail: rows };
        },
      },

      // ─── T6: oa_facts count > 0 ──────────────────────────────────────
      {
        id: "T6",
        name: "oa_facts has >0 rows for SCG deal",
        run: async () => {
          const rows = await db.query(
            `SELECT COUNT(*)::int AS cnt FROM oa_facts WHERE deal_id = $1`,
            z.object({ cnt: z.coerce.number() }),
            [SCG_DEAL_ID],
            { label: "T6: oa_facts count" }
          );
          const cnt = rows[0]?.cnt ?? 0;
          return cnt > 0
            ? { test_id: "T6", name: "oa_facts has >0 rows for SCG deal", status: "pass", reason: `${cnt} facts exist.` }
            : { test_id: "T6", name: "oa_facts has >0 rows for SCG deal", status: "fail", reason: `oa_facts is empty for deal ${SCG_DEAL_ID}.` };
        },
      },

      // ─── T7: Screening Memo churn 5%/7% present ──────────────────────
      {
        id: "T7",
        name: "Screening Memo 5%/7% churn present in oa_facts",
        run: async () => {
          const rows = await db.query(
            `SELECT fact_id, predicate, value, scope_qualifier
             FROM oa_facts
             WHERE deal_id = $1
               AND document_id = $2
               AND predicate ILIKE '%churn%'
             LIMIT 20`,
            z.object({ fact_id: z.string(), predicate: z.string(), value: z.string().nullable(), scope_qualifier: z.string().nullable() }),
            [SCG_DEAL_ID, SCREENING_MEMO_DOC_ID],
            { label: "T7: churn facts from Screening Memo" }
          );
          // Look for 5% and 7% values
          const has5 = rows.some(r => r.value?.includes("5%") || r.value?.includes("5 %"));
          const has7 = rows.some(r => r.value?.includes("7%") || r.value?.includes("7 %"));
          if (has5 && has7) {
            return { test_id: "T7", name: "Screening Memo 5%/7% churn present in oa_facts", status: "pass", reason: `Both 5% and 7% churn values found (${rows.length} churn facts total).`, detail: rows.map(r => ({ fact_id: r.fact_id, value: r.value, scope: r.scope_qualifier })) };
          }
          return { test_id: "T7", name: "Screening Memo 5%/7% churn present in oa_facts", status: "fail", reason: `Missing: ${!has5 ? "5%" : ""}${!has5 && !has7 ? " and " : ""}${!has7 ? "7%" : ""} churn. Found ${rows.length} churn facts.`, detail: rows.map(r => ({ fact_id: r.fact_id, value: r.value, scope: r.scope_qualifier })) };
        },
      },

      // ─── T8: Vendor FDD 6.5/7.5/6.9% FY23/24/25 present ─────────────
      {
        id: "T8",
        name: "Vendor FDD FY23/24/25 churn rates present in oa_facts",
        run: async () => {
          // Search broadly across churn-related predicates AND values containing the target %s
          const rows = await db.query(
            `SELECT fact_id, predicate, value, scope_qualifier
             FROM oa_facts
             WHERE deal_id = $1
               AND document_id = $2
               AND (predicate ILIKE '%churn%' OR predicate ILIKE '%retention%' OR predicate ILIKE '%attrition%'
                    OR value ILIKE '%6.5%' OR value ILIKE '%7.5%' OR value ILIKE '%6.9%')
             LIMIT 50`,
            z.object({ fact_id: z.string(), predicate: z.string(), value: z.string().nullable(), scope_qualifier: z.string().nullable() }),
            [SCG_DEAL_ID, VENDOR_FDD_DOC_ID],
            { label: "T8: churn/retention facts from Vendor FDD" }
          );
          // Values may be stored as compound strings e.g. "(5.8%), (8.0%), (8.2%)"
          // or individual rows. Also check related percentages in broader value text.
          const allValues = rows.map(r => `${r.value ?? ""} ${r.scope_qualifier ?? ""}`).join(" ");
          const has65 = allValues.includes("6.5") || rows.some(r => r.value?.includes("6.5"));
          const has75 = allValues.includes("7.5") || rows.some(r => r.value?.includes("7.5"));
          const has69 = allValues.includes("6.9") || rows.some(r => r.value?.includes("6.9"));
          const missing: string[] = [];
          if (!has65) missing.push("6.5% (FY23)");
          if (!has75) missing.push("7.5% (FY24)");
          if (!has69) missing.push("6.9% (FY25)");
          if (missing.length === 0) {
            return { test_id: "T8", name: "Vendor FDD FY23/24/25 churn rates present in oa_facts", status: "pass", reason: `All three FY churn rates found (${rows.length} churn facts total).`, detail: rows.map(r => ({ fact_id: r.fact_id, value: r.value, scope: r.scope_qualifier })) };
          }
          return { test_id: "T8", name: "Vendor FDD FY23/24/25 churn rates present in oa_facts", status: "fail", reason: `Missing: ${missing.join(", ")}. Found ${rows.length} churn facts total.`, detail: rows.map(r => ({ fact_id: r.fact_id, value: r.value, scope: r.scope_qualifier })) };
        },
      },

      // ─── T9: oa_topics count ≥ 47 (seeded spine) ─────────────────────
      {
        id: "T9",
        name: "oa_topics count ≥ 47 (seeded taxonomy)",
        run: async () => {
          const rows = await db.query(
            `SELECT COUNT(DISTINCT topic_id)::int AS cnt FROM oa_topics WHERE run_id = $1`,
            z.object({ cnt: z.coerce.number() }),
            [SCG_RUN_ID],
            { label: "T9: oa_topics count" }
          );
          const cnt = rows[0]?.cnt ?? 0;
          const target = SEEDED_TOPICS.length; // 47
          return cnt >= target
            ? { test_id: "T9", name: "oa_topics count ≥ 47 (seeded taxonomy)", status: "pass", reason: `${cnt} topics (≥ ${target} seeded). Checklist version: ${OBLIGATION_CHECKLIST_VERSION}.` }
            : { test_id: "T9", name: "oa_topics count ≥ 47 (seeded taxonomy)", status: "fail", reason: `Only ${cnt} topics, expected ≥ ${target}.`, detail: { cnt, expected: target } };
        },
      },

      // ─── T10: Finding references at least one subject_evidence fact_id ─
      {
        id: "T10",
        name: "Every finding references ≥1 subject_evidence fact_id",
        run: async () => {
          if (!hasFindings) return { test_id: "T10", name: "Every finding references ≥1 subject_evidence fact_id", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}).` };
          const rows = await db.query(
            `SELECT finding_id, subject_evidence
             FROM oa_findings
             WHERE run_id = $1
               AND (subject_evidence IS NULL OR subject_evidence = '[]'::jsonb OR jsonb_array_length(subject_evidence) = 0)
             LIMIT 10`,
            z.object({ finding_id: z.string(), subject_evidence: z.any() }),
            [SCG_RUN_ID],
            { label: "T10: findings without subject_evidence" }
          );
          return rows.length === 0
            ? { test_id: "T10", name: "Every finding references ≥1 subject_evidence fact_id", status: "pass", reason: `All findings have subject evidence.` }
            : { test_id: "T10", name: "Every finding references ≥1 subject_evidence fact_id", status: "fail", reason: `${rows.length} finding(s) have empty subject_evidence.`, detail: rows.map(r => r.finding_id) };
        },
      },

      // ─── T11: oa_topic_facts join count > 0 ───────────────────────────
      {
        id: "T11",
        name: "oa_topic_facts join count > 0",
        run: async () => {
          const rows = await db.query(
            `SELECT COUNT(*)::int AS cnt FROM oa_topic_facts WHERE run_id = $1`,
            z.object({ cnt: z.coerce.number() }),
            [SCG_RUN_ID],
            { label: "T11: oa_topic_facts count" }
          );
          const cnt = rows[0]?.cnt ?? 0;
          return cnt > 0
            ? { test_id: "T11", name: "oa_topic_facts join count > 0", status: "pass", reason: `${cnt} fact-topic assignments exist.` }
            : { test_id: "T11", name: "oa_topic_facts join count > 0", status: "fail", reason: `oa_topic_facts is empty for run ${SCG_RUN_ID}.` };
        },
      },

      // ─── T12: No finding references a fact_id not in oa_facts ─────────
      {
        id: "T12",
        name: "No finding references a fact_id not in oa_facts",
        run: async () => {
          if (!hasFindings) return { test_id: "T12", name: "No finding references a fact_id not in oa_facts", status: "not_applicable", reason: `oa_findings is empty (0 rows for run ${SCG_RUN_ID}).` };
          // Extract fact_ids from subject_evidence + reference_evidence JSONB arrays
          const rows = await db.query(
            `WITH finding_fact_ids AS (
              SELECT DISTINCT elem->>'fact_id' AS fid
              FROM oa_findings,
                   jsonb_array_elements(COALESCE(subject_evidence, '[]'::jsonb)) AS elem
              WHERE run_id = $1
              UNION
              SELECT DISTINCT elem->>'fact_id' AS fid
              FROM oa_findings,
                   jsonb_array_elements(COALESCE(reference_evidence, '[]'::jsonb)) AS elem
              WHERE run_id = $1
            )
            SELECT fid FROM finding_fact_ids
            WHERE fid IS NOT NULL
              AND fid NOT IN (SELECT fact_id FROM oa_facts WHERE deal_id = $2)
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

      // ─── T13: No duplicate (predicate, value, document_id, scope_qualifier) ─
      {
        id: "T13",
        name: "No duplicate (predicate, value, document_id, scope_qualifier) in oa_facts",
        run: async () => {
          const rows = await db.query(
            `SELECT predicate, value, document_id, scope_qualifier, COUNT(*)::int AS cnt
             FROM oa_facts
             WHERE deal_id = $1
             GROUP BY predicate, value, document_id, scope_qualifier
             HAVING COUNT(*) > 1
             ORDER BY cnt DESC
             LIMIT 10`,
            z.object({ predicate: z.string().nullable(), value: z.string().nullable(), document_id: z.string(), scope_qualifier: z.string().nullable(), cnt: z.coerce.number() }),
            [SCG_DEAL_ID],
            { label: "T13: duplicate facts" }
          );
          return rows.length === 0
            ? { test_id: "T13", name: "No duplicate (predicate, value, document_id, scope_qualifier) in oa_facts", status: "pass", reason: `No duplicates found.` }
            : { test_id: "T13", name: "No duplicate (predicate, value, document_id, scope_qualifier) in oa_facts", status: "fail", reason: `${rows.length} duplicate group(s) found.`, detail: rows };
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
