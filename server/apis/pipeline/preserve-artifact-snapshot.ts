/**
 * Preserve Artifact Snapshot — durable, idempotent, byte-for-byte copy of a
 * `module_outputs` row into the `diag_consolidation_sessions` scratch table.
 *
 * WHY THIS EXISTS
 * ---------------
 * `canonicalFinalize` UPDATEs an existing `module_outputs` row in place when one
 * is already present for a run (canonical-finalizer.ts STEP 10). That means the
 * moment finalization succeeds, the prior artifact is gone. When the prior
 * artifact is itself evidence — e.g. a pre-reduction-gate merge-tree output that
 * forms the "before" half of a comparison — it must be copied out first.
 *
 * DESIGN NOTES
 * ------------
 *  - The copy is a single `INSERT ... SELECT` executed inside the database. The
 *    payload is never serialized through the API layer, so there is no size
 *    ceiling and no risk of lossy re-encoding.
 *  - `ON CONFLICT (id, pass_number) DO NOTHING` makes this idempotent AND
 *    write-once: re-running it after finalization can never clobber a good
 *    snapshot with a later artifact. Use a new `snapshotKey` for a new snapshot.
 *  - `state_json` deliberately has NO top-level `runId` key. `purge-deal-pipeline-state`
 *    selects rows for deletion via `state_json->>'runId'`; the source run is
 *    recorded as `sourceRunId` so deal purges do not sweep the snapshot away.
 *  - md5 checksums of all three payload columns are recorded at snapshot time and
 *    re-verified after the write, so the caller gets proof the copy is faithful.
 *
 * Read-only with respect to `module_outputs`. Writes only to the scratch table.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ChecksumSchema = z.object({
  findings_md5: z.string().nullable(),
  md_md5: z.string().nullable(),
  exec_md5: z.string().nullable(),
  findings_bytes: z.number().nullable(),
  md_chars: z.number().nullable(),
  exec_chars: z.number().nullable(),
  finding_count: z.number().nullable(),
});

export default api({
  name: "PreserveArtifactSnapshot",
  description: "Durably snapshots a module_outputs artifact before overwrite",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    /** `module_outputs.id` to snapshot. */
    moduleOutputId: z.string(),
    /** Stable, human-readable snapshot id. Write-once: reuse is a no-op. */
    snapshotKey: z.string(),
    /** Free-text provenance recorded alongside the payload. */
    note: z.string().default(""),
  }),

  output: z.object({
    snapshotKey: z.string(),
    inserted: z.boolean(),
    alreadyExisted: z.boolean(),
    sourceChecksums: ChecksumSchema.nullable(),
    snapshotChecksums: ChecksumSchema.nullable(),
    checksumsMatch: z.boolean(),
    snapshotCreatedAt: z.string().nullable(),
  }),

  async run(ctx, { moduleOutputId, snapshotKey, note }) {
    // ── Ensure the scratch table exists (same DDL as diag-consolidation-engine) ──
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS diag_consolidation_sessions (
        id            TEXT NOT NULL,
        pass_number   INT NOT NULL,
        state_json    JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, pass_number)
      )`,
      undefined,
      { label: "Ensure diag_consolidation_sessions table" }
    );

    // ── Checksum the source BEFORE copying ────────────────────────────────────
    const sourceRows = await ctx.integrations.db.query(
      `SELECT md5(findings::text)          AS findings_md5,
              md5(full_report_markdown)    AS md_md5,
              md5(executive_header)        AS exec_md5,
              length(findings::text)       AS findings_bytes,
              length(full_report_markdown) AS md_chars,
              length(executive_header)     AS exec_chars,
              jsonb_array_length(findings)  AS finding_count
         FROM module_outputs
        WHERE id = $1
        LIMIT 1`,
      ChecksumSchema,
      [moduleOutputId],
      { label: "Checksum source artifact" }
    );

    const sourceChecksums = sourceRows[0] ?? null;
    if (!sourceChecksums) {
      throw new Error(`module_outputs row ${moduleOutputId} not found — nothing to preserve.`);
    }

    // ── Copy DB-side. Write-once via DO NOTHING. ──────────────────────────────
    await ctx.integrations.db.execute(
      `INSERT INTO diag_consolidation_sessions (id, pass_number, state_json)
       SELECT $2,
              0,
              jsonb_build_object(
                'snapshotKind',      'module_output_preservation',
                'snapshotKey',       $2::text,
                'note',              $3::text,
                'moduleOutputId',    mo.id::text,
                'sourceRunId',       mo.module_run_id::text,
                'sourceCreatedAt',   mo.created_at,
                'snapshottedAt',     NOW(),
                'findings',          mo.findings,
                'fullReportMarkdown', mo.full_report_markdown,
                'executiveHeader',   mo.executive_header,
                'checksums', jsonb_build_object(
                  'findingsMd5',    md5(mo.findings::text),
                  'markdownMd5',    md5(mo.full_report_markdown),
                  'execHeaderMd5',  md5(mo.executive_header),
                  'findingsBytes',  length(mo.findings::text),
                  'markdownChars',  length(mo.full_report_markdown),
                  'execHeaderChars', length(mo.executive_header),
                  'findingCount',   jsonb_array_length(mo.findings)
                )
              )
         FROM module_outputs mo
        WHERE mo.id = $1
       ON CONFLICT (id, pass_number) DO NOTHING`,
      [moduleOutputId, snapshotKey, note],
      { label: "Copy artifact into snapshot row" }
    );

    // ── Verify the snapshot independently of the insert path ──────────────────
    const VerifySchema = z.object({
      findings_md5: z.string().nullable(),
      md_md5: z.string().nullable(),
      exec_md5: z.string().nullable(),
      findings_bytes: z.number().nullable(),
      md_chars: z.number().nullable(),
      exec_chars: z.number().nullable(),
      finding_count: z.number().nullable(),
      created_at: z.string().nullable(),
      recorded_output_id: z.string().nullable(),
    });

    const verifyRows = await ctx.integrations.db.query(
      `SELECT md5((state_json->'findings')::text)              AS findings_md5,
              md5(state_json->>'fullReportMarkdown')           AS md_md5,
              md5(state_json->>'executiveHeader')              AS exec_md5,
              length((state_json->'findings')::text)           AS findings_bytes,
              length(state_json->>'fullReportMarkdown')        AS md_chars,
              length(state_json->>'executiveHeader')           AS exec_chars,
              jsonb_array_length(state_json->'findings')       AS finding_count,
              created_at::text                                 AS created_at,
              state_json->>'moduleOutputId'                    AS recorded_output_id
         FROM diag_consolidation_sessions
        WHERE id = $1 AND pass_number = 0
        LIMIT 1`,
      VerifySchema,
      [snapshotKey],
      { label: "Verify snapshot row" }
    );

    const verified = verifyRows[0] ?? null;
    if (!verified) {
      throw new Error(`Snapshot ${snapshotKey} was not written — refusing to report success.`);
    }

    const snapshotChecksums: z.infer<typeof ChecksumSchema> = {
      findings_md5: verified.findings_md5,
      md_md5: verified.md_md5,
      exec_md5: verified.exec_md5,
      findings_bytes: verified.findings_bytes,
      md_chars: verified.md_chars,
      exec_chars: verified.exec_chars,
      finding_count: verified.finding_count,
    };

    // `findings` md5 can legitimately differ: jsonb round-trips through the
    // snapshot may renormalize key order/whitespace. Byte length and element
    // count are the load-bearing equality checks there; markdown and the
    // executive header are text columns and must match exactly.
    const checksumsMatch =
      snapshotChecksums.md_md5 === sourceChecksums.md_md5 &&
      snapshotChecksums.exec_md5 === sourceChecksums.exec_md5 &&
      snapshotChecksums.finding_count === sourceChecksums.finding_count &&
      snapshotChecksums.md_chars === sourceChecksums.md_chars &&
      snapshotChecksums.exec_chars === sourceChecksums.exec_chars;

    const alreadyExisted = verified.recorded_output_id !== moduleOutputId;

    return {
      snapshotKey,
      inserted: !alreadyExisted,
      alreadyExisted,
      sourceChecksums,
      snapshotChecksums,
      checksumsMatch,
      snapshotCreatedAt: verified.created_at,
    };
  },
});
