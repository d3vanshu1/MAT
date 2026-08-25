/**
 * PromoteClaimsLedger — promote the IC claim ledger into durable storage.
 *
 * Reads the `claims_ledger` checkpoint for a deal out of `pipeline_checkpoints`
 * (purgeable) and upserts it into `bss_claims_index` (durable, created by
 * migration 031). Phase 1's dependency gate reads from the durable table.
 *
 * ── Deal resolution ──────────────────────────────────────────────────────
 * `pipeline_checkpoints` has NO `deal_id` column. Verified against live schema
 * on 2026-08-25; the table is exactly eight columns:
 *   id, module_run_id, checkpoint_key, payload, created_at, updated_at,
 *   version_hash, status
 * The deal is therefore resolved by joining to `module_runs`. The join column
 * on `module_runs` was confirmed from information_schema as `id` (not assumed):
 *   module_runs(id, deal_id, module_id, status, triggered_at, completed_at,
 *               documents_included)
 * so the join is `pipeline_checkpoints.module_run_id = module_runs.id`.
 *
 * ── Completion gating ────────────────────────────────────────────────────
 * A partial or failed run's ledger must never be promoted.
 *
 * `pipeline_checkpoints.status` CANNOT enforce that. It is declared
 * `NOT NULL DEFAULT 'complete'::text` and, as of 2026-08-25, holds the single
 * value 'complete' across all 66 rows in the table — nothing ever writes any
 * other value. Filtering on it alone is a no-op that reads as a safety gate.
 * Concretely, checkpoint 13e9c0d6-9e71-43dc-898e-47aed6e37ac8 on the SCG deal
 * is stamped status='complete' while its owning module run is status='failed'.
 *
 * The effective gate is `module_runs.status`, a USER-DEFINED enum
 * (`module_status`: pending | running | completed | failed). Note the spelling
 * differs from the checkpoint column — the run value is 'completed'.
 *
 * Both predicates are applied. `module_runs.status = 'completed'` is what
 * actually excludes partial runs; `pipeline_checkpoints.status = 'complete'`
 * is retained so that if the checkpoint column is ever given real semantics,
 * this query tightens automatically rather than silently widening.
 *
 * Ordering is applied only AFTER gating: `ORDER BY pc.created_at DESC LIMIT 1`.
 *
 * ── Promotion source ─────────────────────────────────────────────────────
 * The payload holds two parallel arrays. Promotion reads `canonical_claims`
 * only — the only array with a stable `claim_id` and a `document_id` UUID.
 * The `claims` array identifies source by filename string and is read solely
 * to produce the discrepancy report. No reconciliation is attempted.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CHECKPOINT_KEY = "claims_ledger";
const COMPLETED_RUN_STATUS = "completed"; // module_runs.status enum label
const COMPLETE_CHECKPOINT_STATUS = "complete"; // pipeline_checkpoints.status text

/** Narrow an unknown JSON value to a plain object without throwing. */
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

function asNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function asUuid(value: unknown): string | null {
  const s = asText(value);
  return s !== null && UUID_RE.test(s.trim()) ? s.trim() : null;
}

/** Normalise free text for discrepancy matching: trim, collapse space, lowercase. */
function norm(value: unknown): string {
  const s = asText(value);
  return s === null ? "" : s.replace(/\s+/g, " ").trim().toLowerCase();
}

export default api({
  name: "PromoteClaimsLedger",
  description: "Promotes claims_ledger checkpoint into durable bss_claims_index",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    success: z.boolean(),
    found: z.boolean(),
    message: z.string(),

    // Provenance of the promoted checkpoint
    sourceModuleRunId: z.string().nullable(),
    checkpointId: z.string().nullable(),
    checkpointCreatedAt: z.string().nullable(),
    checkpointStatus: z.string().nullable(),
    moduleRunStatus: z.string().nullable(),
    moduleId: z.string().nullable(),

    // Gate transparency
    checkpointStatusValuesObserved: z.array(z.string()),
    candidateCheckpointsForDeal: z.number(),
    candidateCheckpointsRejectedByGate: z.number(),

    // Counts
    canonicalClaimsCount: z.number(),
    claimsCount: z.number(),
    delta: z.number(),
    rowsInserted: z.number(),
    rowsUpdated: z.number(),
    rowsSkippedMissingClaimId: z.number(),

    // Discrepancy report
    unmatchedClaimsCount: z.number(),
    unmatchedClaims: z.array(z.unknown()),
  }),

  async run(ctx, { dealId }) {
    // ── 1. Report the distinct pipeline_checkpoints.status values ──────────
    // Required by spec before any filtering decision is made.
    const statusRows = await ctx.integrations.db.query(
      `SELECT DISTINCT status FROM pipeline_checkpoints ORDER BY status`,
      z.object({ status: z.string() }),
      [],
      { label: "Distinct pipeline_checkpoints.status values" }
    );
    const checkpointStatusValuesObserved = statusRows.map((r) => r.status);

    // ── 2. Enumerate candidate checkpoints for the deal (pre-gate) ─────────
    const candidates = await ctx.integrations.db.query(
      `SELECT
         pc.id::text                AS checkpoint_id,
         pc.module_run_id::text     AS module_run_id,
         pc.created_at::text        AS created_at,
         pc.status                  AS checkpoint_status,
         mr.status::text            AS run_status,
         mr.module_id               AS module_id
       FROM pipeline_checkpoints pc
       JOIN module_runs mr ON pc.module_run_id = mr.id
       WHERE mr.deal_id = $1::uuid
         AND pc.checkpoint_key = $2
       ORDER BY pc.created_at DESC`,
      z.object({
        checkpoint_id: z.string(),
        module_run_id: z.string(),
        created_at: z.string(),
        checkpoint_status: z.string(),
        run_status: z.string(),
        module_id: z.string(),
      }),
      [dealId, CHECKPOINT_KEY],
      { label: "Enumerate claims_ledger checkpoints for deal (pre-gate)" }
    );

    // ── 3. Gate, then order. Never order first. ────────────────────────────
    const gated = candidates.filter(
      (c) =>
        c.run_status === COMPLETED_RUN_STATUS &&
        c.checkpoint_status === COMPLETE_CHECKPOINT_STATUS
    );
    const chosen = gated.length > 0 ? gated[0] : null; // already created_at DESC

    const emptyResult = {
      success: true,
      found: false,
      sourceModuleRunId: null,
      checkpointId: null,
      checkpointCreatedAt: null,
      checkpointStatus: null,
      moduleRunStatus: null,
      moduleId: null,
      checkpointStatusValuesObserved,
      candidateCheckpointsForDeal: candidates.length,
      candidateCheckpointsRejectedByGate: candidates.length - gated.length,
      canonicalClaimsCount: 0,
      claimsCount: 0,
      delta: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsSkippedMissingClaimId: 0,
      unmatchedClaimsCount: 0,
      unmatchedClaims: [] as unknown[],
    };

    if (chosen === null) {
      return {
        ...emptyResult,
        message:
          candidates.length === 0
            ? `No '${CHECKPOINT_KEY}' checkpoint exists for deal ${dealId}. Nothing promoted; no rows created.`
            : `Found ${candidates.length} '${CHECKPOINT_KEY}' checkpoint(s) for deal ${dealId}, but none belongs to a module run with status='${COMPLETED_RUN_STATUS}'. Refusing to promote a partial or failed run's ledger. Nothing promoted; no rows created.`,
      };
    }

    // ── 4. Load the payload arrays for the chosen checkpoint ───────────────
    const payloadRows = await ctx.integrations.db.query(
      `SELECT
         COALESCE(payload->'canonical_claims', '[]'::jsonb) AS canonical_claims,
         COALESCE(payload->'claims',           '[]'::jsonb) AS claims
       FROM pipeline_checkpoints
       WHERE id = $1::uuid`,
      z.object({
        canonical_claims: z.array(z.unknown()),
        claims: z.array(z.unknown()),
      }),
      [chosen.checkpoint_id],
      { label: "Load claims_ledger payload arrays" }
    );

    if (payloadRows.length === 0) {
      return {
        ...emptyResult,
        message: `Checkpoint ${chosen.checkpoint_id} disappeared between selection and read. Nothing promoted.`,
      };
    }

    const canonicalClaims = payloadRows[0].canonical_claims;
    const rawClaims = payloadRows[0].claims;

    // ── 5. Flatten canonical_claims into promotion records ─────────────────
    const records: Array<Record<string, unknown>> = [];
    let rowsSkippedMissingClaimId = 0;

    for (const item of canonicalClaims) {
      const c = asObject(item);
      const claimId = asText(c.claim_id);
      if (claimId === null || claimId.trim() === "") {
        // claim_id is half the primary key. A record without one cannot be
        // upserted deterministically, so it is counted rather than invented.
        rowsSkippedMissingClaimId += 1;
        continue;
      }

      const source = asObject(c.source);
      const proposition = asObject(c.proposition);
      const validation = asObject(c.source_validation);
      const claimText = asText(c.exact_claim_text) ?? "";

      records.push({
        claim_id: claimId,
        claim_text: claimText,
        claim_type: asText(c.claim_type),
        document_id: asUuid(source.document_id),
        document_name: asText(source.document_name),
        memo_version: asText(source.memo_version),
        page_or_slide: asText(source.page_or_slide),
        char_start: asInt(source.source_start),
        char_end: asInt(source.source_end),
        // Column is VARCHAR(200); truncate at the source rather than relying
        // on the database to reject an oversized value.
        verbatim_snippet: claimText.slice(0, 200),
        metric: asText(proposition.metric),
        stated_value: asNumeric(proposition.stated_value),
        unit: asText(proposition.unit),
        period: asText(proposition.period),
        scope_qualifier: asText(proposition.scope),
        actual_forecast_status: asText(proposition.actual_forecast_status),
        qualitative_proposition: asText(proposition.qualitative_proposition),
        coordinate_valid: asBool(validation.coordinate_valid),
        exact_text_found: asBool(validation.exact_text_found),
        schema_version: asText(c.schema_version),
      });
    }

    // De-duplicate within the batch. ON CONFLICT DO UPDATE cannot affect the
    // same row twice in one statement ("cannot affect row a second time"), so
    // a payload carrying a repeated claim_id would abort the whole upsert.
    // Last occurrence wins, matching the semantics of a sequential upsert.
    const byClaimId = new Map<string, Record<string, unknown>>();
    for (const r of records) {
      byClaimId.set(String(r.claim_id), r);
    }
    const dedupedRecords = Array.from(byClaimId.values());
    const duplicateClaimIdsInPayload = records.length - dedupedRecords.length;

    // ── 6. Upsert. DO UPDATE, never DO NOTHING. ────────────────────────────
    // xmax = 0 distinguishes a freshly inserted row from an updated one,
    // giving exact insert/update counts in a single round trip.
    let rowsInserted = 0;
    let rowsUpdated = 0;

    if (dedupedRecords.length > 0) {
      const upsertCounts = await ctx.integrations.db.query(
        `WITH upsert AS (
           INSERT INTO bss_claims_index (
             deal_id, claim_id, claim_text, claim_type, document_id, document_name,
             memo_version, page_or_slide, char_start, char_end, verbatim_snippet,
             metric, stated_value, unit, period, scope_qualifier,
             actual_forecast_status, qualitative_proposition,
             coordinate_valid, exact_text_found, schema_version,
             source_module_run_id, source_checkpoint_at, promoted_at
           )
           SELECT
             $1::uuid, r.claim_id, r.claim_text, r.claim_type, r.document_id, r.document_name,
             r.memo_version, r.page_or_slide, r.char_start, r.char_end, r.verbatim_snippet,
             r.metric, r.stated_value, r.unit, r.period, r.scope_qualifier,
             r.actual_forecast_status, r.qualitative_proposition,
             r.coordinate_valid, r.exact_text_found, r.schema_version,
             $3::uuid, $4::timestamptz, now()
           FROM jsonb_to_recordset($2::jsonb) AS r(
             claim_id                TEXT,
             claim_text              TEXT,
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
             schema_version          TEXT
           )
           ON CONFLICT (deal_id, claim_id) DO UPDATE SET
             claim_text              = EXCLUDED.claim_text,
             claim_type              = EXCLUDED.claim_type,
             document_id             = EXCLUDED.document_id,
             document_name           = EXCLUDED.document_name,
             memo_version            = EXCLUDED.memo_version,
             page_or_slide           = EXCLUDED.page_or_slide,
             char_start              = EXCLUDED.char_start,
             char_end                = EXCLUDED.char_end,
             verbatim_snippet        = EXCLUDED.verbatim_snippet,
             metric                  = EXCLUDED.metric,
             stated_value            = EXCLUDED.stated_value,
             unit                    = EXCLUDED.unit,
             period                  = EXCLUDED.period,
             scope_qualifier         = EXCLUDED.scope_qualifier,
             actual_forecast_status  = EXCLUDED.actual_forecast_status,
             qualitative_proposition = EXCLUDED.qualitative_proposition,
             coordinate_valid        = EXCLUDED.coordinate_valid,
             exact_text_found        = EXCLUDED.exact_text_found,
             schema_version          = EXCLUDED.schema_version,
             source_module_run_id    = EXCLUDED.source_module_run_id,
             source_checkpoint_at    = EXCLUDED.source_checkpoint_at,
             promoted_at             = now()
           RETURNING (xmax = 0) AS was_inserted
         )
         SELECT
           COUNT(*) FILTER (WHERE was_inserted)     AS rows_inserted,
           COUNT(*) FILTER (WHERE NOT was_inserted) AS rows_updated
         FROM upsert`,
        z.object({
          rows_inserted: z.coerce.number(),
          rows_updated: z.coerce.number(),
        }),
        [dealId, JSON.stringify(dedupedRecords), chosen.module_run_id, chosen.created_at],
        { label: "Upsert canonical claims into bss_claims_index" }
      );

      rowsInserted = upsertCounts[0]?.rows_inserted ?? 0;
      rowsUpdated = upsertCounts[0]?.rows_updated ?? 0;
    }

    // ── 7. Discrepancy report — report only, do not reconcile ──────────────
    // Match each `claims` item against `canonical_claims` on verbatim_snippet
    // first, then on metric + period + value. Anything unmatched is emitted
    // verbatim.
    const canonicalSnippets = new Set<string>();
    const canonicalTriples = new Set<string>();
    for (const item of canonicalClaims) {
      const c = asObject(item);
      const p = asObject(c.proposition);
      const snippet = norm(c.exact_claim_text);
      if (snippet !== "") canonicalSnippets.add(snippet);
      canonicalTriples.add(
        `${norm(p.metric)}|${norm(p.period)}|${String(asNumeric(p.stated_value))}`
      );
    }

    const unmatchedClaims: unknown[] = [];
    for (const item of rawClaims) {
      const cl = asObject(item);
      const snippet = norm(cl.verbatim_snippet);
      if (snippet !== "" && canonicalSnippets.has(snippet)) continue;
      const triple = `${norm(cl.metric)}|${norm(cl.period)}|${String(asNumeric(cl.value))}`;
      if (canonicalTriples.has(triple)) continue;
      unmatchedClaims.push(item);
    }

    const canonicalClaimsCount = canonicalClaims.length;
    const claimsCount = rawClaims.length;

    const notes: string[] = [];
    if (rowsSkippedMissingClaimId > 0) {
      notes.push(
        `${rowsSkippedMissingClaimId} canonical_claims item(s) had no claim_id and were skipped (claim_id is half the primary key).`
      );
    }
    if (duplicateClaimIdsInPayload > 0) {
      notes.push(
        `${duplicateClaimIdsInPayload} duplicate claim_id(s) collapsed within the payload before upsert (last occurrence wins).`
      );
    }
    notes.push(
      `Gate: pipeline_checkpoints.status observed values = [${checkpointStatusValuesObserved.join(", ")}]; that column is effectively constant, so module_runs.status='${COMPLETED_RUN_STATUS}' is the operative completion gate.`
    );

    return {
      success: true,
      found: true,
      message:
        `Promoted ${rowsInserted + rowsUpdated} claim(s) from checkpoint ${chosen.checkpoint_id} ` +
        `(module_run ${chosen.module_run_id}, run status '${chosen.run_status}', created ${chosen.created_at}). ` +
        `${rowsInserted} inserted, ${rowsUpdated} updated. ` +
        `Discrepancy: canonical_claims=${canonicalClaimsCount}, claims=${claimsCount}, delta=${claimsCount - canonicalClaimsCount}, unmatched claims items=${unmatchedClaims.length}. ` +
        notes.join(" "),

      sourceModuleRunId: chosen.module_run_id,
      checkpointId: chosen.checkpoint_id,
      checkpointCreatedAt: chosen.created_at,
      checkpointStatus: chosen.checkpoint_status,
      moduleRunStatus: chosen.run_status,
      moduleId: chosen.module_id,

      checkpointStatusValuesObserved,
      candidateCheckpointsForDeal: candidates.length,
      candidateCheckpointsRejectedByGate: candidates.length - gated.length,

      canonicalClaimsCount,
      claimsCount,
      delta: claimsCount - canonicalClaimsCount,
      rowsInserted,
      rowsUpdated,
      rowsSkippedMissingClaimId,

      unmatchedClaimsCount: unmatchedClaims.length,
      unmatchedClaims,
    };
  },
});
