/**
 * Migration 032 — BSS v2 Phase 1 durable state.
 *
 * Creates three additive tables for the absence search, dependency check,
 * and disposition pipeline:
 *
 *   1. bss_coverage      — per-candidate sweep verdict and audit trail.
 *   2. bss_dependencies   — does the investment thesis rely on this candidate.
 *   3. bss_dispositions   — final outcome per candidate with attribution.
 *
 * Design constraints:
 *
 *   - The absence search decides by counting, not scoring. There is no rank
 *     threshold anywhere in this schema, deliberately. A threshold tuned on
 *     one deal would not transfer to another, and the second-deal test is
 *     what proves the tool is general. Every column is a count, a flag, or
 *     evidence — nothing is a tunable score.
 *
 *   - No severity, tier, priority, or score column on any of these three
 *     tables. Criticality is assigned by the model at write-up, from these
 *     facts, and lands in the findings — not here. The schema is the
 *     enforcement, as with `bss_candidates`.
 *
 *   - No foreign keys to tables we do not own (`module_runs`, `module_outputs`,
 *     `documents`, `deals`). The single FK on each table is
 *     `candidate_id → bss_candidates(candidate_id)`, which migration 031
 *     created and we own.
 *
 *   - No ALTER of any table we do not own.
 *
 * This migration is additive only — no existing table is altered or dropped.
 * All statements are idempotent (IF NOT EXISTS).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration032",
  description: "Creates BSS v2 Phase 1 tables: bss_coverage, bss_dependencies, bss_dispositions",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    tables: z.array(z.string()),
    indexes: z.array(z.string()),
    objectCount: z.number(),
    tablesAlreadyPresent: z.array(z.string()),
  }),

  async run(ctx) {
    const TARGET_TABLES = ["bss_coverage", "bss_dependencies", "bss_dispositions"];

    // Record which tables existed before we ran, so the caller can tell a
    // first-run migration from a no-op re-run.
    const preExisting = await ctx.integrations.db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration032: check which BSS v2 Phase 1 tables already exist" },
    );
    const tablesAlreadyPresent = preExisting.map((r) => r.table_name);

    const tables: string[] = [];
    const indexes: string[] = [];

    // ─── TABLE 1: bss_coverage ───────────────────────────────────────────
    // One row per candidate per sweep. Records the verdict and everything
    // needed to audit it. The agreement count (queries_with_hits) drives
    // the verdict: 0 → absent, 1 → thin, 2+ → covered.
    //
    // documents_searched is not optional. An absence claim without a named
    // search scope is unfalsifiable, and the report has to state which
    // documents it looked at.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS bss_coverage (
        coverage_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id              UUID NOT NULL,
        candidate_id         UUID NOT NULL REFERENCES bss_candidates (candidate_id),
        verdict              TEXT NOT NULL,
        queries_run          JSONB NOT NULL,
        queries_with_hits    INT  NOT NULL,
        documents_searched   JSONB NOT NULL,
        documents_with_hits  INT  NOT NULL,
        max_term_coverage    INT  NOT NULL,
        hits                 JSONB NOT NULL,
        boilerplate_only     BOOLEAN NOT NULL,
        expansion_ran        BOOLEAN NOT NULL,
        expansion_overturned BOOLEAN NOT NULL,
        swept_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT bss_coverage_verdict_chk
          CHECK (verdict IN ('covered', 'thin', 'absent')),
        CONSTRAINT bss_coverage_candidate_swept_uniq
          UNIQUE (candidate_id, swept_at)
      )`,
      [],
      { label: "Migration032: create bss_coverage" },
    );
    tables.push("bss_coverage");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_coverage_deal
         ON bss_coverage (deal_id)`,
      [],
      { label: "Migration032: index bss_coverage deal" },
    );
    indexes.push("idx_bss_coverage_deal");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_coverage_deal_verdict
         ON bss_coverage (deal_id, verdict)`,
      [],
      { label: "Migration032: index bss_coverage deal_verdict" },
    );
    indexes.push("idx_bss_coverage_deal_verdict");

    // ─── TABLE 2: bss_dependencies ───────────────────────────────────────
    // Does the investment case rely on this. Same search mechanism, pointed
    // at IC memos instead of the data room.
    //
    // latest_memo_hit matters because a topic present only in the screening
    // memo and absent from the third IC memo is weaker evidence of current
    // reliance than one the latest memo rests on.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS bss_dependencies (
        dependency_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id                UUID NOT NULL,
        candidate_id           UUID NOT NULL REFERENCES bss_candidates (candidate_id),
        thesis_hit             BOOLEAN NOT NULL,
        queries_run            JSONB NOT NULL,
        memo_documents_searched JSONB NOT NULL,
        hits                   JSONB,
        latest_memo_hit        BOOLEAN,
        swept_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration032: create bss_dependencies" },
    );
    tables.push("bss_dependencies");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_dependencies_deal
         ON bss_dependencies (deal_id)`,
      [],
      { label: "Migration032: index bss_dependencies deal" },
    );
    indexes.push("idx_bss_dependencies_deal");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_dependencies_candidate
         ON bss_dependencies (candidate_id)`,
      [],
      { label: "Migration032: index bss_dependencies candidate" },
    );
    indexes.push("idx_bss_dependencies_candidate");

    // ─── TABLE 3: bss_dispositions ───────────────────────────────────────
    // Final state per candidate, with attribution. The gate column records
    // which step decided (coverage, dependency, remedy), and reason is a
    // human-readable explanation citing the counts that drove it.
    //
    // No severity, tier, priority, or score column. Criticality is assigned
    // by the model at write-up, from these facts, and lands in the findings.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS bss_dispositions (
        disposition_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id         UUID NOT NULL,
        candidate_id    UUID NOT NULL REFERENCES bss_candidates (candidate_id),
        outcome         TEXT NOT NULL,
        gate            TEXT NOT NULL,
        reason          TEXT NOT NULL,
        decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT bss_dispositions_outcome_chk
          CHECK (outcome IN (
            'finding',
            'dropped_covered',
            'dropped_thin',
            'dropped_no_dependency',
            'dropped_no_remedy'
          )),
        CONSTRAINT bss_dispositions_candidate_decided_uniq
          UNIQUE (candidate_id, decided_at)
      )`,
      [],
      { label: "Migration032: create bss_dispositions" },
    );
    tables.push("bss_dispositions");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_dispositions_deal_outcome
         ON bss_dispositions (deal_id, outcome)`,
      [],
      { label: "Migration032: index bss_dispositions deal_outcome" },
    );
    indexes.push("idx_bss_dispositions_deal_outcome");

    const objectCount = tables.length + indexes.length;

    return {
      success: true,
      message:
        tablesAlreadyPresent.length === TARGET_TABLES.length
          ? `All ${TARGET_TABLES.length} BSS v2 Phase 1 tables already existed — migration re-ran idempotently, no schema change.`
          : `Migration 032 applied. Tables ensured: ${tables.join(", ")}. Indexes ensured: ${indexes.join(", ")}.` +
            (tablesAlreadyPresent.length > 0
              ? ` Already present before this run: ${tablesAlreadyPresent.join(", ")}.`
              : " No BSS v2 Phase 1 tables existed before this run."),
      tables,
      indexes,
      objectCount,
      tablesAlreadyPresent,
    };
  },
});
