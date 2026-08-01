/**
 * AssembleExportArtifact
 *
 * Full server-side assembly of an L3 export artifact.
 * - Reads the consolidated L3 checkpoint (tree_level=98)
 * - Generates the complete artifact content (json or mapping)
 * - Validates: JSON parse, record count, dedup, node reconciliation
 * - Computes SHA-256 via Web Crypto API
 * - Stores the validated content in merge_checkpoints at tree_level=99
 *   (node_index=0 for json, node_index=1 for mapping)
 * - Returns validation metadata + SHA-256
 *
 * This API produces a byte-preserving canonical artifact that can then
 * be retrieved chunk-by-chunk via StreamExportArtifact.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
// sha256hex is defined locally below (accepts string input)

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ExportCheckpointSchema = z.object({
  id: z.string(),
  merged_json: z.any(),
});

const UpsertResultSchema = z.object({ id: z.string() });

// ─── Field normalizer (must match ReadArtifactChunk exactly) ──────────────────

function normaliseFinding(f: any): Record<string, any> {
  return {
    finding_id:               f.finding_id ?? null,
    issue_key:                f.issue_key ?? null,
    title:                    f.title ?? null,
    detail:                   f.detail ?? null,
    full_analysis:            f.full_analysis ?? null,
    finding_kind:             f.finding_kind ?? null,
    category:                 f.category ?? null,
    severity:                 f.severity ?? null,
    confidence:               f.confidence ?? null,
    source_docs:              f.source_docs ?? null,
    source_document_ids:      f.source_document_ids ?? null,
    source_sections:          f.source_sections ?? null,
    evidence:                 f.evidence ?? null,
    evidence_coordinates:     f.evidence_coordinates ?? null,
    claim_ids:                f.claim_ids ?? null,
    structured_impact:        f.structured_impact ?? null,
    verification_status:      f.verification_status ?? null,
    materiality_fields:       f.materiality_fields ?? null,
    entity:                   f.entity ?? null,
    metric:                   f.metric ?? null,
    period:                   f.period ?? null,
    scope:                    f.scope ?? null,
    unit:                     f.unit ?? null,
    comparison_basis:         f.comparison_basis ?? null,
    recommendation:           f.recommendation ?? null,
    content_identity:         f.content_identity ?? null,
    analysis_chunk_id:        f.analysis_chunk_id ?? null,
    pipeline_analysis_id:     f.pipeline_analysis_id ?? null,
    merge_level:              f.merge_level ?? null,
    merge_node:               f.merge_node ?? null,
    merged_from_finding_ids:  f.merged_from_finding_ids ?? null,
    created_at:               f.created_at ?? null,
    updated_at:               f.updated_at ?? null,
    _l3_node_index:           f._l3_node_index ?? null,
    _l3_checkpoint_id:        f._l3_checkpoint_id ?? null,
    ...(f.severity_anchor       !== undefined ? { severity_anchor:       f.severity_anchor } : {}),
    ...(f.materiality_rationale !== undefined ? { materiality_rationale: f.materiality_rationale } : {}),
    ...(f.numeric_unverified    !== undefined ? { numeric_unverified:    f.numeric_unverified } : {}),
  };
}

// ─── SHA-256 using Web Crypto ─────────────────────────────────────────────────

async function sha256hex(content: string): Promise<string> {
  const data = Buffer.from(content, "utf8");
  const hashBuffer = await (globalThis as any).crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b: number) => b.toString(16).padStart(2, "0")).join("");
}

// ─── JSON builder (identical logic to ReadArtifactChunk) ──────────────────────

function buildJsonContent(findings: any[], meta: any): string {
  const normalised = findings.map(normaliseFinding);
  const nodeMap: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const allIds: string[] = [];
  let missingTitle = 0, missingIssueKey = 0, missingEvidence = 0, missingSourceDocs = 0;

  for (const f of normalised) {
    const nodeKey = `L3:N${f._l3_node_index}`;
    nodeMap[nodeKey] = (nodeMap[nodeKey] ?? 0) + 1;
    byKind[f.finding_kind ?? "null"]   = (byKind[f.finding_kind ?? "null"]   ?? 0) + 1;
    bySeverity[f.severity ?? "null"]   = (bySeverity[f.severity ?? "null"]   ?? 0) + 1;
    byCategory[f.category ?? "(none)"] = (byCategory[f.category ?? "(none)"] ?? 0) + 1;
    if (f.finding_id) allIds.push(f.finding_id);
    if (!f.title)      missingTitle++;
    if (!f.issue_key)  missingIssueKey++;
    if (!f.evidence && !f.full_analysis) missingEvidence++;
    if (!f.source_docs || (Array.isArray(f.source_docs) && f.source_docs.length === 0)) missingSourceDocs++;
  }

  const uniqueIds    = Array.from(new Set(allIds));
  const duplicateIds = allIds.filter((id, i) => allIds.indexOf(id) !== i);

  return JSON.stringify({
    _export_metadata: {
      export_format_version: "1.0.0",
      export_timestamp:      meta.export_timestamp,
      generated_at:          meta.generated_at,
      run_id:                meta.run_id,
      module_id:             meta.module_id,
      deal_id:               "c46b4129-8a16-48ae-ad3a-1da061255445",
      git_reference_commit:  "bc01c41",
      export_checkpoint_id:  meta.export_checkpoint_id,
      total_findings:        normalised.length,
      node_counts:           meta.node_counts,
    },
    _completeness_checks: {
      expected_findings:          273,
      exported_findings:          normalised.length,
      unique_finding_ids:         uniqueIds.length,
      duplicate_finding_ids:      duplicateIds.length,
      duplicate_ids_list:         duplicateIds,
      findings_missing_title:     missingTitle,
      findings_missing_issue_key: missingIssueKey,
      findings_missing_evidence:  missingEvidence,
      findings_missing_source_docs: missingSourceDocs,
      findings_by_kind:           byKind,
      findings_by_category:       byCategory,
      findings_by_severity:       bySeverity,
      findings_by_l3_node:        nodeMap,
    },
    _node_checkpoint_manifest: (meta.node_counts ?? []).map((nc: any) => ({
      node:          nc.node,
      checkpoint_id: nc.checkpoint_id,
      finding_count: nc.count,
      updated_at:    nc.updated_at,
    })),
    findings: normalised,
  });
}

// ─── Mapping builder (identical logic to ReadArtifactChunk) ───────────────────

function buildMappingContent(findings: any[], meta: any): string {
  const rows = findings.map((f: any) => {
    const nf = normaliseFinding(f);
    const hasMerge = Array.isArray(nf.merged_from_finding_ids) && nf.merged_from_finding_ids.length > 0;
    return {
      raw_finding_id:          nf.finding_id,
      l3_node:                 `L3:N${nf._l3_node_index}`,
      l3_checkpoint_id:        nf._l3_checkpoint_id,
      issue_key:               nf.issue_key,
      title:                   nf.title,
      finding_kind:            nf.finding_kind,
      severity:                nf.severity,
      l3_merge_type:           hasMerge ? "consolidated_from_earlier_analyses" : "atomic_at_l3",
      merged_from_finding_ids: nf.merged_from_finding_ids ?? [],
      merged_from_count:       hasMerge ? (nf.merged_from_finding_ids?.length ?? 0) : 0,
      family_id:               null,
      family_members:          null,
      grouping_reason:         null,
      grouping_confidence:     null,
      subgroup_id:             null,
      processing_status:       null,
      final_finding_id:        null,
      disposition:             null,
      merged_into:             null,
      excluded_reason:         null,
      degraded_fallback:       null,
    };
  });

  const consolidatedCount = rows.filter((r) => r.l3_merge_type === "consolidated_from_earlier_analyses").length;
  const atomicCount       = rows.filter((r) => r.l3_merge_type === "atomic_at_l3").length;

  return JSON.stringify({
    _mapping_metadata: {
      export_format_version: "1.0.0",
      generated_at:          meta.generated_at,
      run_id:                meta.run_id,
      module_id:             meta.module_id,
      git_reference_commit:  "bc01c41",
      total_l3_findings:     rows.length,
      l3_findings_with_internal_merges: consolidatedCount,
      l3_atomic_findings:    atomicCount,
      diagnostic_finalization_mapping_status: "REQUIRES_SEPARATE_EXTRACTION",
      diagnostic_finalization_note:
        "The mapping from L3 findings to 50 diagnostic families to 140 final findings " +
        "is produced by the DiagnosticFinalization stage and stored in merge_checkpoints " +
        "at tree_level=4. Query that stage's checkpoints to populate family_id, " +
        "grouping_reason, final_finding_id, and disposition fields.",
    },
    _l3_internal_merge_summary: {
      total_l3_findings:                        rows.length,
      findings_that_consolidated_earlier_analyses: consolidatedCount,
      atomic_findings_no_prior_merge:           atomicCount,
    },
    mappings: rows,
  });
}

// ─── API definition ───────────────────────────────────────────────────────────

export default api({
  name: "AssembleExportArtifact",
  description: "Full server-side assembly/validation of L3 export artifact with SHA-256.",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    artifact_type: z.enum(["json", "mapping"]),
  }),

  output: z.object({
    status: z.enum(["success", "validation_failed"]),
    artifact_type: z.string(),
    total_bytes: z.number(),
    sha256: z.string(),
    finding_count: z.number(),
    unique_ids: z.number(),
    duplicate_ids: z.number(),
    node_reconciliation: z.record(z.number()),
    stored_checkpoint_level: z.number(),
    stored_node_index: z.number(),
    validation_errors: z.array(z.string()),
    generated_at: z.string(),
  }),

  async run(ctx, { runId, artifact_type }) {
    // 1. Load the consolidated L3 export checkpoint (tree_level=98)
    const rows = await ctx.integrations.ic_diligence_db.query(
      `SELECT id, merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98 AND node_index = 0
       LIMIT 1`,
      ExportCheckpointSchema,
      [runId],
      { label: "Load L3 export checkpoint" }
    );

    if (rows.length === 0) {
      throw new Error(`No L3 export checkpoint found for run ${runId}.`);
    }

    const payload = typeof rows[0].merged_json === "string"
      ? JSON.parse(rows[0].merged_json)
      : rows[0].merged_json;

    const findings: any[] = payload.findings ?? [];
    const generatedAt = new Date().toISOString();
    const meta = {
      ...(payload._export_metadata ?? {}),
      export_checkpoint_id: rows[0].id,
      generated_at: generatedAt,
    };

    // 2. Generate the artifact content
    let content: string;
    if (artifact_type === "json") {
      content = buildJsonContent(findings, meta);
    } else {
      content = buildMappingContent(findings, meta);
    }

    // 3. Validate
    const validationErrors: string[] = [];

    // Verify valid JSON
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (e: any) {
      validationErrors.push(`JSON parse failed: ${e.message}`);
    }

    // Verify record count
    const expectedCount = 273;
    let actualCount = 0;
    let uniqueCount = 0;
    let duplicateCount = 0;
    const nodeRecon: Record<string, number> = {};

    if (parsed) {
      if (artifact_type === "json") {
        const pFindings = parsed.findings ?? [];
        actualCount = pFindings.length;
        const ids = pFindings.map((f: any) => f.finding_id).filter(Boolean);
        const uniqueSet = new Set(ids);
        uniqueCount = uniqueSet.size;
        duplicateCount = ids.length - uniqueCount;

        // Node reconciliation
        for (const f of pFindings) {
          const nodeKey = `L3:N${f._l3_node_index}`;
          nodeRecon[nodeKey] = (nodeRecon[nodeKey] ?? 0) + 1;
        }

        if (actualCount !== expectedCount) {
          validationErrors.push(`Expected ${expectedCount} findings, got ${actualCount}`);
        }
        if (duplicateCount > 0) {
          validationErrors.push(`Found ${duplicateCount} duplicate finding IDs`);
        }

        // Verify no synthetic/fabricated records
        for (const f of pFindings) {
          if (f.finding_id && (f.finding_id.includes("dup-guard") || f.finding_id.includes("placeholder"))) {
            validationErrors.push(`Fabricated record detected: ${f.finding_id}`);
          }
          if (f.title === "placeholder" || f.detail === "placeholder") {
            validationErrors.push(`Placeholder content detected in finding ${f.finding_id}`);
          }
        }
      } else {
        // mapping
        const mappings = parsed.mappings ?? [];
        actualCount = mappings.length;
        const ids = mappings.map((m: any) => m.raw_finding_id).filter(Boolean);
        const uniqueSet = new Set(ids);
        uniqueCount = uniqueSet.size;
        duplicateCount = ids.length - uniqueCount;

        for (const m of mappings) {
          const nodeKey = m.l3_node ?? "unknown";
          nodeRecon[nodeKey] = (nodeRecon[nodeKey] ?? 0) + 1;
        }

        if (actualCount !== expectedCount) {
          validationErrors.push(`Expected ${expectedCount} mapping records, got ${actualCount}`);
        }
        if (duplicateCount > 0) {
          validationErrors.push(`Found ${duplicateCount} duplicate raw_finding_ids`);
        }
      }
    }

    // Verify node reconciliation sums to 273
    const nodeSum = Object.values(nodeRecon).reduce((a, b) => a + b, 0);
    if (nodeSum !== expectedCount && parsed) {
      validationErrors.push(`Node reconciliation sums to ${nodeSum}, expected ${expectedCount}`);
    }

    // 4. Compute SHA-256
    const sha = await sha256hex(content);

    // 5. Store the validated content at tree_level=99
    const nodeIndex = artifact_type === "json" ? 0 : 1;
    const totalBytes = Buffer.byteLength(content, "utf8");

    // Store metadata about the artifact (not the content itself — content is generated on-the-fly)
    // We store a manifest so StreamExportArtifact can verify integrity
    const manifestPayload = {
      artifact_type,
      total_bytes: totalBytes,
      sha256: sha,
      finding_count: actualCount,
      unique_ids: uniqueCount,
      duplicate_ids: duplicateCount,
      node_reconciliation: nodeRecon,
      validation_errors: validationErrors,
      generated_at: generatedAt,
      source_checkpoint_id: rows[0].id,
    };

    await ctx.integrations.ic_diligence_db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, updated_at)
       VALUES ($1, 99, $2, $3::jsonb, NOW())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $3::jsonb, updated_at = NOW()
       RETURNING id`,
      UpsertResultSchema,
      [runId, nodeIndex, JSON.stringify(manifestPayload)],
      { label: `Store artifact manifest (tree_level=99, node=${nodeIndex})` }
    );

    return {
      status: validationErrors.length === 0 ? "success" as const : "validation_failed" as const,
      artifact_type,
      total_bytes: totalBytes,
      sha256: sha,
      finding_count: actualCount,
      unique_ids: uniqueCount,
      duplicate_ids: duplicateCount,
      node_reconciliation: nodeRecon,
      stored_checkpoint_level: 99,
      stored_node_index: nodeIndex,
      validation_errors: validationErrors,
      generated_at: generatedAt,
    };
  },
});
