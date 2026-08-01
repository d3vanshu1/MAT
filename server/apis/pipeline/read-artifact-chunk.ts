/**
 * ReadArtifactChunk
 *
 * Generates the requested artifact file content ON THE FLY from the L3 export
 * checkpoint (tree_level=98) and returns a byte-range slice.
 *
 * artifact_type: "json" | "markdown" | "mapping"
 * byte_offset: starting byte position
 * byte_length: max bytes to return (default 30000)
 *
 * Returns the slice plus total_bytes for the full content.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ExportCheckpointSchema = z.object({
  id: z.string(),
  merged_json: z.any(),
});

// ─── Field normalizer ─────────────────────────────────────────────────────────

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
    ...(f.severity_anchor      !== undefined ? { severity_anchor:      f.severity_anchor } : {}),
    ...(f.materiality_rationale !== undefined ? { materiality_rationale: f.materiality_rationale } : {}),
    ...(f.numeric_unverified   !== undefined ? { numeric_unverified:   f.numeric_unverified } : {}),
  };
}

// ─── JSON builder ─────────────────────────────────────────────────────────────

function buildJsonContent(findings: any[], meta: any, indent?: number): string {
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
      generated_at:          new Date().toISOString(),
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
  }, null, indent);
}

// ─── Markdown builder ─────────────────────────────────────────────────────────

function buildMarkdownContent(findings: any[], meta: any): string {
  const lines: string[] = [];
  lines.push("# Saint / SCG — L3 Raw Findings Corpus");
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| run_id | \`${meta.run_id}\` |`);
  lines.push(`| module_id | \`${meta.module_id}\` |`);
  lines.push(`| deal_id | \`c46b4129-8a16-48ae-ad3a-1da061255445\` |`);
  lines.push(`| export_checkpoint_id | \`${meta.export_checkpoint_id}\` |`);
  lines.push(`| export_timestamp | ${meta.export_timestamp} |`);
  lines.push(`| generated_at | ${new Date().toISOString()} |`);
  lines.push(`| git_reference_commit | \`bc01c41\` |`);
  lines.push(`| total_findings | **${findings.length}** |`);
  lines.push("");
  lines.push("## L3 Node Manifest");
  lines.push("");
  lines.push("| Node | Checkpoint ID | Count | Updated At |");
  lines.push("|---|---|---|---|");
  for (const nc of (meta.node_counts ?? [])) {
    lines.push(`| ${nc.node} | \`${nc.checkpoint_id}\` | ${nc.count} | ${nc.updated_at} |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Findings (1–273)");
  lines.push("");
  lines.push("> All 273 findings listed sequentially in pipeline order (N0 → N5).");
  lines.push("> No collapsing, deduplication, or grouping.");
  lines.push("");

  for (let i = 0; i < findings.length; i++) {
    const f = normaliseFinding(findings[i]);
    const n = i + 1;
    lines.push("---");
    lines.push("");
    lines.push(`### Finding ${n} of 273`);
    lines.push("");
    lines.push(`| Field | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| Finding ID | \`${f.finding_id}\` |`);
    lines.push(`| Issue Key | \`${f.issue_key}\` |`);
    lines.push(`| Finding Kind | \`${f.finding_kind}\` |`);
    lines.push(`| Severity | \`${f.severity}\` |`);
    lines.push(`| Category | \`${f.category ?? "(none)"}\` |`);
    lines.push(`| L3 Node | N${f._l3_node_index} (\`${f._l3_checkpoint_id}\`) |`);
    lines.push("");
    lines.push(`**Title:** ${f.title}`);
    lines.push("");

    if (Array.isArray(f.source_docs) && f.source_docs.length > 0) {
      lines.push("**Source Documents:**");
      for (const sd of f.source_docs) lines.push(`- ${sd}`);
      lines.push("");
    }
    if (Array.isArray(f.claim_ids) && f.claim_ids.length > 0) {
      lines.push(`**Claim IDs:** ${f.claim_ids.join(", ")}`);
      lines.push("");
    }
    if (f.evidence) {
      lines.push("**Evidence:**");
      lines.push("");
      if (Array.isArray(f.evidence)) {
        for (const ev of f.evidence) {
          const fig = ev.figure ?? "(none)";
          const doc = ev.source_doc ?? "(none)";
          lines.push(`- Figure: ${fig} | Doc: ${doc}`);
          if (ev.verbatim_snippet) lines.push(`  > ${ev.verbatim_snippet}`);
        }
      } else {
        lines.push(String(f.evidence));
      }
      lines.push("");
    }
    if (f.detail) {
      lines.push("**Detail:**");
      lines.push("");
      lines.push(f.detail);
      lines.push("");
    }
    if (f.full_analysis) {
      lines.push("**Full Analysis:**");
      lines.push("");
      lines.push(f.full_analysis);
      lines.push("");
    }
    if (f.structured_impact) {
      lines.push("**Structured Impact:**");
      lines.push("");
      if (Array.isArray(f.structured_impact)) {
        for (const si of f.structured_impact) {
          lines.push(`- ${si.currency ?? ""} ${si.amount ?? ""} (${si.role ?? ""}) — ${si.source_doc ?? ""} [${si.source_coordinate ?? ""}]`);
        }
      } else {
        lines.push(JSON.stringify(f.structured_impact));
      }
      lines.push("");
    }
    if (Array.isArray(f.merged_from_finding_ids) && f.merged_from_finding_ids.length > 0) {
      lines.push(`**Merged From:** ${f.merged_from_finding_ids.join(", ")}`);
      lines.push("");
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Mapping builder ──────────────────────────────────────────────────────────

function buildMappingContent(findings: any[], meta: any, indent?: number): string {
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
      generated_at:          new Date().toISOString(),
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
  }, null, indent);
}

// ─── API definition ───────────────────────────────────────────────────────────

export default api({
  name: "ReadArtifactChunk",
  description: "Generates artifact content on-the-fly and returns a byte-range slice.",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    artifact_type: z.enum(["json", "markdown", "mapping"]),
    byte_offset: z.number().default(0),
    byte_length: z.number().default(30000),
    compact: z.boolean().default(false),
  }),

  output: z.object({
    chunk: z.string(),
    byte_offset: z.number(),
    chunk_bytes: z.number(),
    total_bytes: z.number(),
    has_more: z.boolean(),
  }),

  async run(ctx, { runId, artifact_type, byte_offset, byte_length, compact }) {
    // Load the consolidated L3 export checkpoint
    const rows = await ctx.integrations.ic_diligence_db.query(
      `SELECT id, merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98 AND node_index = 0
       LIMIT 1`,
      ExportCheckpointSchema,
      [runId],
      { label: "Load L3 export for chunk generation" }
    );

    if (rows.length === 0) {
      throw new Error(`No L3 export checkpoint found for run ${runId}.`);
    }

    const payload = typeof rows[0].merged_json === "string"
      ? JSON.parse(rows[0].merged_json)
      : rows[0].merged_json;

    const findings: any[] = payload.findings ?? [];
    const meta = {
      ...(payload._export_metadata ?? {}),
      export_checkpoint_id: rows[0].id,
    };

    // Generate the requested artifact type
    let content: string;
    const indent = compact ? undefined : 2;
    switch (artifact_type) {
      case "json":     content = buildJsonContent(findings, meta, indent);     break;
      case "markdown": content = buildMarkdownContent(findings, meta); break;
      case "mapping":  content = buildMappingContent(findings, meta, indent);  break;
    }

    // Return the requested byte range
    const totalBytes = Buffer.byteLength(content, "utf8");
    const contentBuf = Buffer.from(content, "utf8");
    const slice = contentBuf.slice(byte_offset, byte_offset + byte_length);
    const chunkStr = slice.toString("utf8");

    return {
      chunk: chunkStr,
      byte_offset,
      chunk_bytes: slice.length,
      total_bytes: totalBytes,
      has_more: byte_offset + slice.length < totalBytes,
    };
  },
});
