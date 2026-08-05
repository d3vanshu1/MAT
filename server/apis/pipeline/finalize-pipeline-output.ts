import { api, z, postgres } from "@superblocksteam/sdk-api";
import { parseCanonicalFindings } from "./canonical-finding.js";
import {
  canonicalFinalize,
  loadCheckpointStatus,
} from "./canonical-finalizer.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * MAT-F06: Standalone finalizer for stuck/recovery pipeline runs.
 *
 * Reads the final merge checkpoint and delegates entirely to canonicalFinalize()
 * — the single authoritative finalization function shared by all completion paths.
 *
 * Never duplicates persist/complete logic. Enforces:
 *   - prerequisite validation (§B)
 *   - F05 narrative enforcement
 *   - §F report filter (reportable findings only)
 *   - §G diagnostic persistence
 *   - persist-before-complete ordering (§C)
 *   - idempotency guard (§C)
 */
export default api({
  name: "FinalizePipelineOutput",
  description: "Recovery finalizer for stuck runs — delegates to canonical finalizer",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    dealId: z.string(),
    moduleId: z.string(),
  }),

  output: z.object({
    success: z.boolean(),
    phase: z.string(),
    outputId: z.string().nullable(),
    semanticHash: z.string().nullable(),
    reportLength: z.number(),
    findingsCount: z.number(),
    error: z.string().nullable(),
  }),

  async run(ctx, { runId, dealId, moduleId }) {
    // Step 1: Load the final merge checkpoint (top-level root node)
    const TopNodeSchema = z.object({
      tree_level: z.coerce.number(),
      node_index: z.coerce.number(),
      executive_header: z.string(),
      findings_json: z.string(),
    });

    const topNodes = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              COALESCE(merged_json->>'executiveHeader', '') AS executive_header,
              COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND COALESCE(status, 'complete') = 'complete'
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 1`,
      TopNodeSchema,
      [runId],
      { label: "Finalize: load final checkpoint" }
    );

    if (topNodes.length === 0) {
      return {
        success: false,
        phase: "no_final_checkpoint",
        outputId: null,
        semanticHash: null,
        reportLength: 0,
        findingsCount: 0,
        error: "No complete merge checkpoint found — run may not have finished merging",
      };
    }

    const topNode = topNodes[0];
    console.log(`[Finalize] Found top node: level=${topNode.tree_level}, index=${topNode.node_index}`);

    // Step 2: Parse findings
    let findings: any[];
    try {
      const rawFindings = JSON.parse(topNode.findings_json);
      const parseResult = parseCanonicalFindings(rawFindings, {
        mode: "reload",
        source: `finalize-pipeline:${runId}`,
      });
      if (parseResult.malformed_count > 0) {
        return {
          success: false,
          phase: "findings_parse_error",
          outputId: null,
          semanticHash: null,
          reportLength: 0,
          findingsCount: 0,
          error: `${parseResult.malformed_count} findings were irrecoverably malformed`,
        };
      }
      findings = parseResult.findings as any[];
    } catch (parseErr: any) {
      return {
        success: false,
        phase: "findings_parse_error",
        outputId: null,
        semanticHash: null,
        reportLength: 0,
        findingsCount: 0,
        error: `Failed to parse findings: ${parseErr?.message}`,
      };
    }

    console.log(`[Finalize] Parsed ${findings.length} findings`);

    // Step 3: Load Q3 canonical records for F05 enforcement
    let canonicalRecordMap: Map<string, any> | undefined;
    try {
      const q3Checkpoints = await ctx.integrations.db.query(
        `SELECT checkpoint_data FROM pipeline_checkpoints
         WHERE run_id = $1 AND stage = 'q3_claim_linkage'
         ORDER BY created_at DESC LIMIT 1`,
        z.object({ checkpoint_data: z.any() }),
        [runId],
        { label: "Finalize: load Q3 canonical records" }
      );
      if (q3Checkpoints.length > 0) {
        const cpData = typeof q3Checkpoints[0].checkpoint_data === "string"
          ? JSON.parse(q3Checkpoints[0].checkpoint_data)
          : q3Checkpoints[0].checkpoint_data;
        if (cpData?.canonical_findings && Array.isArray(cpData.canonical_findings)) {
          canonicalRecordMap = new Map();
          for (const rec of cpData.canonical_findings) {
            if (rec?.claim?.claim_id) {
              canonicalRecordMap.set(rec.claim.claim_id, rec);
            }
          }
          console.log(`[Finalize][F05] Loaded ${canonicalRecordMap.size} canonical records from Q3`);
        }
      }
    } catch (q3Err: any) {
      console.warn(`[Finalize][F05] Could not load Q3 canonical records: ${q3Err?.message}`);
    }

    // Step 4: Load checkpoint status (prerequisite validation)
    // hasParsedFindings=true because we confirmed above that findings parsed successfully
    const checkpointStatus = await loadCheckpointStatus(
      ctx.integrations.db,
      runId,
      moduleId,
      true // findings parsed successfully from merge checkpoint
    );

    // Step 5: Delegate entirely to canonical finalizer (§A — one finalizer for all paths)
    const outcome = await canonicalFinalize(
      ctx.integrations.db,
      runId,
      dealId,
      {
        findings,
        executiveHeader: topNode.executive_header,
        moduleType: moduleId,
        canonicalRecordMap,
        checkpointStatus,
        proposedFinalNode: {
          treeLevel: topNode.tree_level,
          nodeIndex: topNode.node_index,
        },
      }
    );

    switch (outcome.status) {
      case "completed":
        return {
          success: true,
          phase: "completed",
          outputId: outcome.artifactId,
          semanticHash: outcome.semanticHash,
          reportLength: outcome.artifact.report.markdown.length,
          findingsCount: outcome.findingCount,
          error: null,
        };

      case "idempotent":
        return {
          success: true,
          phase: "already_finalized_idempotent",
          outputId: outcome.artifactId,
          semanticHash: outcome.semanticHash,
          reportLength: 0,
          findingsCount: 0,
          error: null,
        };

      case "already_completed":
        return {
          success: true,
          phase: "already_completed",
          outputId: null,
          semanticHash: null,
          reportLength: 0,
          findingsCount: 0,
          error: null,
        };

      case "prerequisites_missing":
        return {
          success: false,
          phase: "prerequisites_missing",
          outputId: null,
          semanticHash: null,
          reportLength: 0,
          findingsCount: 0,
          error: outcome.message,
        };

      case "rejected_overwrite":
        return {
          success: false,
          phase: "rejected_overwrite",
          outputId: null,
          semanticHash: null,
          reportLength: 0,
          findingsCount: 0,
          error: outcome.message,
        };

      case "persist_failed":
        return {
          success: false,
          phase: "persist_failed",
          outputId: null,
          semanticHash: null,
          reportLength: 0,
          findingsCount: 0,
          error: outcome.error,
        };

      case "publication_blocked":
        return {
          success: false,
          phase: "publication_blocked",
          outputId: null,
          semanticHash: null,
          reportLength: 0,
          findingsCount: 0,
          error: outcome.message,
        };
    }
  },
});
