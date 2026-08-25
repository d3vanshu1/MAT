/**
 * Migration 031 — Blind Spot Scanner v2 durable state.
 *
 * Creates three additive tables for the `blind_spot_scanner_v2` module:
 *   1. bss_profiles      — structural/thesis profiles plus proof of generator blindness.
 *   2. bss_candidates    — generated risk hypotheses (no severity/confidence/priority/tier).
 *   3. bss_claims_index  — the IC claim ledger promoted out of `pipeline_checkpoints`
 *                          (which is purgeable) into durable storage.
 *
 * Design constraints carried from the BSS v2 Phase 0 package:
 *
 *   - `module_outputs` has a fixed six-column schema the integration role cannot
 *     ALTER, so all new state lives in side tables. Same pattern as migrations
 *     029 (module_run_flags) and 030 (module_run_diagnostics).
 *
 *   - No foreign keys to tables we do not own (`module_runs`, `documents`,
 *     `deals`). The single FK here is bss_candidates -> bss_profiles, both of
 *     which this migration creates.
 *
 *   - `bss_candidates` deliberately has NO severity, confidence, priority, or
 *     tier column. Tier is computed in Phase 1 from coverage and dependency
 *     facts and written to a separate table. The absent column is the
 *     enforcement: a model-emitted rank has nowhere to land.
 *
 *   - `bss_profiles.excluded_document_ids` is the blindness verification
 *     artifact. It is the full document set for the deal minus
 *     `input_document_ids`, so blindness is provable by set arithmetic rather
 *     than by reading a prompt.
 *
 * `bss_claims_index` column set was amended 2026-08-25 against the confirmed
 * `claims_ledger` payload shape. Promotion source is the `canonical_claims`
 * array only — it is the only one of the payload's two parallel arrays carrying
 * a stable `claim_id` and a `document_id` UUID. The `claims` array identifies
 * source by filename string and is unusable as a join key.
 *
 * `chunk_index` was in the original table spec and is intentionally absent:
 * `canonical_claims` carries character offsets (`source.source_start` /
 * `source.source_end`) and `source.page_or_slide`, not chunk indices. It is not
 * derived.
 *
 * This migration is additive only — no existing table is altered or dropped.
 * All statements are idempotent (IF NOT EXISTS).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration031",
  description: "Creates BSS v2 tables: bss_profiles, bss_candidates, bss_claims_index",

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
    const TARGET_TABLES = ["bss_profiles", "bss_candidates", "bss_claims_index"];

    // Record which tables existed before we ran, so the caller can tell a
    // first-run migration from a no-op re-run.
    const preExisting = await ctx.integrations.db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration031: check which BSS v2 tables already exist" }
    );
    const tablesAlreadyPresent = preExisting.map((r) => r.table_name);

    const tables: string[] = [];
    const indexes: string[] = [];

    // ─── TABLE 1: bss_profiles ───────────────────────────────────────────
    // profile_json holds the derived profile. The four input_/excluded_
    // columns are the audit trail proving what the generator was and was not
    // shown at generation time.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS bss_profiles (
        profile_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id               UUID NOT NULL,
        profile_kind          TEXT NOT NULL,
        profile_version       INT  NOT NULL DEFAULT 1,
        profile_json          JSONB NOT NULL,
        input_document_ids    UUID[] NOT NULL,
        input_document_names  TEXT[] NOT NULL,
        excluded_document_ids UUID[] NOT NULL,
        input_char_count      INT  NOT NULL,
        generation_model      TEXT NOT NULL,
        prompt_hash           TEXT NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT bss_profiles_kind_chk
          CHECK (profile_kind IN ('structural','thesis')),
        CONSTRAINT bss_profiles_deal_kind_version_uniq
          UNIQUE (deal_id, profile_kind, profile_version)
      )`,
      [],
      { label: "Migration031: create bss_profiles" }
    );
    tables.push("bss_profiles");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_profiles_deal
         ON bss_profiles (deal_id)`,
      [],
      { label: "Migration031: index bss_profiles deal" }
    );
    indexes.push("idx_bss_profiles_deal");

    // ─── TABLE 2: bss_candidates ─────────────────────────────────────────
    // implied_assumption is the primary artifact: the proposition the thesis
    // must hold for this failure mode not to bite. Phase 1 matches it against
    // the claim and model indices.
    //
    // NOTE: no severity / confidence / priority / tier column, by design.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS bss_candidates (
        candidate_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id            UUID NOT NULL,
        profile_id         UUID NOT NULL REFERENCES bss_profiles (profile_id),
        module_run_id      UUID,
        pass_type          TEXT NOT NULL,
        failure_mode       TEXT NOT NULL,
        implied_assumption TEXT NOT NULL,
        hypothesis         TEXT NOT NULL,
        rationale          TEXT,
        proposed_queries   JSONB NOT NULL,
        candidate_hash     TEXT NOT NULL,
        generation_model   TEXT NOT NULL,
        prompt_hash        TEXT NOT NULL,
        generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT bss_candidates_pass_type_chk
          CHECK (pass_type IN ('blind','informed')),
        CONSTRAINT bss_candidates_dedupe_uniq
          UNIQUE (deal_id, profile_id, pass_type, candidate_hash)
      )`,
      [],
      { label: "Migration031: create bss_candidates" }
    );
    tables.push("bss_candidates");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_candidates_deal_pass
         ON bss_candidates (deal_id, pass_type)`,
      [],
      { label: "Migration031: index bss_candidates deal_pass" }
    );
    indexes.push("idx_bss_candidates_deal_pass");

    // ─── TABLE 3: bss_claims_index ───────────────────────────────────────
    // Durable promotion target for the claims_ledger checkpoint payload.
    // Composite PK (deal_id, claim_id) is the upsert conflict target.
    //
    // memo_version, actual_forecast_status, coordinate_valid, exact_text_found
    // and scope_qualifier are retained deliberately — Phase 1 uses them for
    // supersession weighting, base-case materiality, fail-closed confidence,
    // and scope disambiguation respectively.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS bss_claims_index (
        deal_id                 UUID NOT NULL,
        claim_id                TEXT NOT NULL,
        claim_text              TEXT NOT NULL,
        claim_type              TEXT,
        document_id             UUID,
        document_name           TEXT,
        memo_version            TEXT,
        page_or_slide           TEXT,
        char_start              INT,
        char_end                INT,
        verbatim_snippet        VARCHAR(200),
        metric                  TEXT,
        stated_value            NUMERIC,
        unit                    TEXT,
        period                  TEXT,
        scope_qualifier         TEXT,
        actual_forecast_status  TEXT,
        qualitative_proposition TEXT,
        coordinate_valid        BOOLEAN,
        exact_text_found        BOOLEAN,
        schema_version          TEXT,
        source_module_run_id    UUID,
        source_checkpoint_at    TIMESTAMPTZ,
        promoted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT bss_claims_index_pk PRIMARY KEY (deal_id, claim_id)
      )`,
      [],
      { label: "Migration031: create bss_claims_index" }
    );
    tables.push("bss_claims_index");

    // Specified in the Part 1 table spec. Note this is a prefix of the
    // composite primary key, so the PK index would already serve deal_id-only
    // lookups; it is created as specified rather than silently omitted.
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_claims_index_deal
         ON bss_claims_index (deal_id)`,
      [],
      { label: "Migration031: index bss_claims_index deal" }
    );
    indexes.push("idx_bss_claims_index_deal");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_bss_claims_index_deal_memo
         ON bss_claims_index (deal_id, memo_version)`,
      [],
      { label: "Migration031: index bss_claims_index deal_memo_version" }
    );
    indexes.push("idx_bss_claims_index_deal_memo");

    const objectCount = tables.length + indexes.length;

    return {
      success: true,
      message:
        tablesAlreadyPresent.length === TARGET_TABLES.length
          ? `All ${TARGET_TABLES.length} BSS v2 tables already existed — migration re-ran idempotently, no schema change.`
          : `Migration 031 applied. Tables ensured: ${tables.join(", ")}. Indexes ensured: ${indexes.join(", ")}.` +
            (tablesAlreadyPresent.length > 0
              ? ` Already present before this run: ${tablesAlreadyPresent.join(", ")}.`
              : " No BSS v2 tables existed before this run."),
      tables,
      indexes,
      objectCount,
      tablesAlreadyPresent,
    };
  },
});
