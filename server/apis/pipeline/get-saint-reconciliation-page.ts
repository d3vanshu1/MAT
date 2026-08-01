/**
 * GetSaintReconciliationPage — Paginated read-only retrieval
 *
 * Reads the persisted reconciliation artifact (tree_level=98) and returns
 * a single page of rows. Does NOT recompute reconciliation during paging.
 *
 * Rules:
 * - Default limit: 10, maximum limit: 20
 * - Reject negative offsets
 * - Reject invalid limits (< 1 or > 20)
 * - Stable deterministic ordering by finding_id then legacy_reference
 * - Include total row count and artifact checksum on every page
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const PageRowSchema = z.object({
  finding_id: z.string(),
  legacy_reference: z.string().nullable(),
  source_document_id: z.string().nullable(),
  source_document_name: z.string().nullable(),
  source_page_or_location: z.string().nullable(),
  deterministic_claim_id: z.string().nullable(),
  exact_claim_text: z.string().nullable(),
  resolution_method: z.string(),
  match_count: z.number(),
  confidence: z.string(),
  disposition: z.string(),
  rejection_reason: z.string().nullable(),
  q3_eligible: z.boolean(),
});

export default api({
  name: "GetSaintReconciliationPage",
  description: "Paginated retrieval of persisted reconciliation artifact rows",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    artifactCheckpointId: z.string(),
    offset: z.number().default(0),
    limit: z.number().default(10),
  }),

  output: z.object({
    artifact_id: z.string(),
    schema_version: z.string(),
    checksum: z.string(),
    total_rows: z.number(),
    offset: z.number(),
    limit: z.number(),
    returned_count: z.number(),
    has_more: z.boolean(),
    rows: z.array(PageRowSchema),
  }),

  async run(ctx, { artifactCheckpointId, offset, limit }) {
    // Validate inputs
    if (offset < 0) {
      throw new Error(`Invalid offset: ${offset}. Must be non-negative.`);
    }
    if (limit < 1 || limit > 20) {
      throw new Error(`Invalid limit: ${limit}. Must be between 1 and 20.`);
    }

    // Load artifact from merge_checkpoints
    // Support both UUID-style IDs and composite keys
    const ArtifactRow = z.object({ merged_json: z.any(), id: z.string() });
    let artifactRows = await ctx.integrations.db.query(
      `SELECT id, merged_json FROM merge_checkpoints
       WHERE id = $1
       LIMIT 1`,
      ArtifactRow,
      [artifactCheckpointId],
      { label: "Load reconciliation artifact by ID" }
    );

    // If not found by ID, try loading by module_run_id + tree_level=96
    if (artifactRows.length === 0) {
      artifactRows = await ctx.integrations.db.query(
        `SELECT id, merged_json FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = 96 AND node_index = 0
         ORDER BY updated_at DESC LIMIT 1`,
        ArtifactRow,
        [artifactCheckpointId],
        { label: "Load reconciliation artifact by run_id fallback" }
      );
    }

    if (artifactRows.length === 0) {
      throw new Error(`No reconciliation artifact found for ID: ${artifactCheckpointId}`);
    }

    const artifact = typeof artifactRows[0].merged_json === "string"
      ? JSON.parse(artifactRows[0].merged_json)
      : artifactRows[0].merged_json;

    const schemaVersion: string = artifact.schema_version ?? "unknown";
    const checksum: string = artifact.checksum ?? "missing";
    const allRows: any[] = artifact.rows ?? [];
    const totalRows = allRows.length;

    // Rows are already stored in deterministic order (sorted by finding_id then legacy_claim_ref)
    // but re-sort to guarantee stability
    allRows.sort((a: any, b: any) => {
      const cmp = (a.finding_id ?? "").localeCompare(b.finding_id ?? "");
      if (cmp !== 0) return cmp;
      return (a.legacy_claim_ref ?? "").localeCompare(b.legacy_claim_ref ?? "");
    });

    // Slice the page
    const pageRows = allRows.slice(offset, offset + limit);

    // Map to output schema
    const mappedRows = pageRows.map((r: any) => ({
      finding_id: r.finding_id ?? "",
      legacy_reference: r.legacy_claim_ref ?? null,
      source_document_id: r.source_document_id ?? null,
      source_document_name: r.source_document_name ?? null,
      source_page_or_location: r.source_page_or_location ?? null,
      deterministic_claim_id: r.resolved_claim_id ?? null,
      exact_claim_text: r.resolved_claim_text ?? null,
      resolution_method: r.matching_method ?? "unknown",
      match_count: r.candidate_match_count ?? 0,
      confidence: r.confidence ?? "none",
      disposition: r.q3_eligible ? "resolved_eligible" : (r.confidence === "none" ? "unresolved_rejected" : "resolved_not_eligible"),
      rejection_reason: r.rejection_reason ?? null,
      q3_eligible: r.q3_eligible ?? false,
    }));

    return {
      artifact_id: artifactRows[0].id,
      schema_version: schemaVersion,
      checksum,
      total_rows: totalRows,
      offset,
      limit,
      returned_count: mappedRows.length,
      has_more: (offset + limit) < totalRows,
      rows: mappedRows,
    };
  },
});
