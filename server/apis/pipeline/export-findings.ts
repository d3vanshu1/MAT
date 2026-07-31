/**
 * ExportFindings — permanent diagnostic API.
 *
 * RC1: Now uses CanonicalFindingSchema at the output boundary — all finding fields
 * preserved including finding_kind, severity_anchor, issue_key, structured_impact,
 * evidence, verification, etc.
 *
 * RC audit item #10 (§10 "persist one canonical post-quality artifact"):
 * ONLY source is module_outputs.findings (post-quality-pass canonical artifact).
 *
 * Fix 19: Canonical-only — merge_checkpoints fallback REMOVED.
 * Missing canonical artifact = explicit "incomplete" status in response.
 * Consumers MUST NOT silently degrade to pre-quality checkpoint data.
 *
 * Pagination: `offset` + `limit` params let callers page through findings.
 * `severityFilter` applies BEFORE pagination (filter → slice).
 * Summary block always reflects the full unfiltered set.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { CanonicalFindingSchema, FINDING_SCHEMA_VERSION } from "./canonical-finding.js";
import { strictReloadFindings } from "../modules/strict-reload-findings.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const SummarySchema = z.object({
  totalCount: z.number(),
  byteSize: z.number(),
  bySeverity: z.object({
    critical: z.number(),
    warning: z.number(),
    info: z.number(),
  }),
  byGapType: z.object({
    diligence_gap: z.number(),
    memo_omission: z.number(),
    unclassified: z.number(),
  }),
  treeLevel: z.number(),
  /** Fix 19: Now always true — merge_checkpoints fallback removed. Kept for backward-compat. */
  fromCanonicalArtifact: z.boolean(),
  /** Schema version of the persisted artifact (null if pre-Fix 13 data). Current = FINDING_SCHEMA_VERSION. */
  schemaVersion: z.number().nullable(),
});

export default api({
  name: "ExportFindings",
  description: "Exports final findings (post-quality artifact) with pagination and severity/category summary",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    mode: z.enum(["full", "ids"]).nullable().optional()
      .describe("'full' (default): return findings with full content. 'ids': return sorted title arrays per severity, counts, byte lengths (~15KB total)."),
    severityFilter: z.enum(["critical", "warning", "info"]).nullable().optional()
      .describe("Optional: return only findings matching this severity (applied before pagination)"),
    offset: z.number().nullable().optional().describe("Pagination offset (0-indexed). Default 0."),
    limit: z.number().nullable().optional().describe("Page size. Default: return all (no limit)."),
  }),

  output: z.object({
    runId: z.string(),
    totalCount: z.number().describe("Total findings matching filter (before pagination)"),
    offset: z.number(),
    returnedCount: z.number().describe("Number of findings in this page"),
    byteLength: z.number().describe("Byte length of the findings JSON in this response"),
    findings: z.array(CanonicalFindingSchema),
    summary: SummarySchema.describe("Always computed from the FULL unfiltered set"),
    filtered: z.boolean(),
    corruptionDetected: z.boolean().describe("true if persisted findings failed strict validation — distinguishes corruption from a genuinely empty run"),
    staleSchema: z.boolean().describe("true if persisted schema_version does not match current FINDING_SCHEMA_VERSION — indicates a pre-migration artifact that may lack newer fields"),
    /** Fix 19: explicit incomplete state when canonical artifact is missing */
    artifactStatus: z.enum(["canonical", "incomplete"]).describe("'canonical' = from module_outputs (post-quality). 'incomplete' = no canonical artifact exists for this run."),
    idManifest: z.object({
      generatedAt: z.string(),
      totalCount: z.number(),
      bySeverity: z.object({
        critical: z.object({ count: z.number(), titles: z.array(z.string()), byteLength: z.number() }),
        warning: z.object({ count: z.number(), titles: z.array(z.string()), byteLength: z.number() }),
        info: z.object({ count: z.number(), titles: z.array(z.string()), byteLength: z.number() }),
      }),
    }).nullable().optional(),
  }),

  async run(ctx, { runId, mode: rawMode, severityFilter, offset: rawOffset, limit: rawLimit }) {
    const mode = rawMode ?? "full";
    const offset = rawOffset ?? 0;

    // --- Fix 19: Canonical-only — ONLY source is module_outputs ---
    // merge_checkpoints fallback REMOVED. Missing canonical = explicit "incomplete".
    const CanonicalOutputRow = z.object({
      findings: z.any(),
      findings_bytes: z.coerce.number(),
      schema_version: z.coerce.number().nullable(),
    });

    type ExportRow = {
      findings: unknown;
      findings_bytes: number;
      schema_version: number | null;
    };

    let row: ExportRow | null = null;

    // Fetch canonical artifact — the ONLY source
    const canonRows = await ctx.integrations.db.query(
      `SELECT mo.findings,
              octet_length(mo.findings::text) AS findings_bytes,
              mo.schema_version
       FROM module_outputs mo
       WHERE mo.module_run_id = $1
       LIMIT 1`,
      CanonicalOutputRow,
      [runId],
      { label: "ExportFindings: fetch canonical artifact from module_outputs" }
    );
    if (canonRows.length > 0) {
      const cr = canonRows[0];
      row = { findings: cr.findings, findings_bytes: cr.findings_bytes, schema_version: cr.schema_version ?? null };
    }

    // Fix 19: No fallback — missing canonical = incomplete
    if (!row) {
      return {
        runId,
        totalCount: 0,
        offset: 0,
        returnedCount: 0,
        byteLength: 2,
        findings: [],
        summary: {
          totalCount: 0,
          byteSize: 0,
          bySeverity: { critical: 0, warning: 0, info: 0 },
          byGapType: { diligence_gap: 0, memo_omission: 0, unclassified: 0 },
          treeLevel: -1,
          fromCanonicalArtifact: false,
          schemaVersion: null,
        },
        filtered: false,
        corruptionDetected: false,
        staleSchema: false,
        artifactStatus: "incomplete" as const,
      };
    }

    // Determine if artifact is from a stale schema version
    const isStaleSchema = row.schema_version != null && row.schema_version !== FINDING_SCHEMA_VERSION;
    if (isStaleSchema) {
      console.warn(`[ExportFindings] Stale schema detected: persisted v${row.schema_version}, current v${FINDING_SCHEMA_VERSION} (run=${runId})`);
    }

    // RC1 + Fix 3: strict reload — fail closed on any corruption
    let allFindings;
    try {
      allFindings = strictReloadFindings(
        row.findings,
        `ExportFindings run_id=${runId} canonical=true`
      ).findings;
    } catch (err) {
      console.error(`[ExportFindings] Fail-closed:`, err instanceof Error ? err.message : err);
      return {
        runId,
        totalCount: 0,
        offset: 0,
        returnedCount: 0,
        byteLength: 2,
        findings: [],
        summary: {
          totalCount: 0,
          byteSize: row.findings_bytes,
          bySeverity: { critical: 0, warning: 0, info: 0 },
          byGapType: { diligence_gap: 0, memo_omission: 0, unclassified: 0 },
          treeLevel: -1,
          fromCanonicalArtifact: true,
          schemaVersion: row.schema_version,
        },
        filtered: false,
        corruptionDetected: true,
        staleSchema: isStaleSchema,
        artifactStatus: "canonical" as const,
      };
    }

    // Compute summary from the FULL set (before filter)
    const bySeverity = { critical: 0, warning: 0, info: 0 };
    const byGapType = { diligence_gap: 0, memo_omission: 0, unclassified: 0 };
    for (const f of allFindings) {
      if (f.severity === "critical") bySeverity.critical++;
      else if (f.severity === "warning") bySeverity.warning++;
      else bySeverity.info++;
      if (f.gap_type === "diligence_gap") byGapType.diligence_gap++;
      else if (f.gap_type === "memo_omission") byGapType.memo_omission++;
      else byGapType.unclassified++;
    }

    const summary: z.infer<typeof SummarySchema> = {
      totalCount: allFindings.length,
      byteSize: row.findings_bytes,
      bySeverity,
      byGapType,
      treeLevel: -1,
      fromCanonicalArtifact: true,
      schemaVersion: row.schema_version,
    };

    // --- mode: "ids" ---
    if (mode === "ids") {
      const buckets: Record<string, string[]> = { critical: [], warning: [], info: [] };
      for (const f of allFindings) {
        buckets[f.severity]?.push(f.title);
      }
      for (const key of Object.keys(buckets)) buckets[key].sort();
      const cJ = JSON.stringify(buckets.critical);
      const wJ = JSON.stringify(buckets.warning);
      const iJ = JSON.stringify(buckets.info);

      return {
        runId,
        totalCount: allFindings.length,
        offset: 0,
        returnedCount: 0,
        byteLength: 0,
        findings: [],
        summary,
        filtered: false,
        corruptionDetected: false,
        staleSchema: isStaleSchema,
        artifactStatus: "canonical" as const,
        idManifest: {
          generatedAt: new Date().toISOString(),
          totalCount: allFindings.length,
          bySeverity: {
            critical: { count: buckets.critical.length, titles: buckets.critical, byteLength: Buffer.byteLength(cJ, "utf8") },
            warning: { count: buckets.warning.length, titles: buckets.warning, byteLength: Buffer.byteLength(wJ, "utf8") },
            info: { count: buckets.info.length, titles: buckets.info, byteLength: Buffer.byteLength(iJ, "utf8") },
          },
        },
      };
    }

    // --- mode: "full" ---
    const filteredFindings = severityFilter
      ? allFindings.filter(f => f.severity === severityFilter)
      : allFindings;

    const totalCount = filteredFindings.length;
    const pageFindings = rawLimit != null
      ? filteredFindings.slice(offset, offset + rawLimit)
      : filteredFindings.slice(offset);

    const byteLength = Buffer.byteLength(JSON.stringify(pageFindings), "utf8");

    return {
      runId,
      totalCount,
      offset,
      returnedCount: pageFindings.length,
      byteLength,
      findings: pageFindings,
      summary,
      filtered: !!severityFilter,
      corruptionDetected: false,
      staleSchema: isStaleSchema,
      artifactStatus: "canonical" as const,
    };
  },
});
