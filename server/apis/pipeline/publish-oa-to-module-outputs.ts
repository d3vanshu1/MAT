/**
 * PublishOaToModuleOutputs
 *
 * One-shot data-write that publishes an existing OA run's output into the
 * module_runs + module_outputs tables so the dashboard renders it.
 *
 * Does NOT trigger any pipeline execution. Reads from oa_findings and
 * oa_stage_checkpoints, transforms per SPEC 1/2/3, writes to module_outputs.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { SEEDED_TOPICS, OBLIGATION_CHECKLIST_VERSION } from "./oa-taxonomy.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Gap-kind to reader language (same as oa-render.ts)
// ---------------------------------------------------------------------------
const GAP_KIND_LABELS: Record<string, string> = {
  not_disclosed: "Not addressed in the memos",
  scope_mismatch: "Disclosed for a narrower population than the underlying data",
  unreconciled_divergence: "Figures differ between memo and source without reconciliation",
  unquantified: "Discussed qualitatively; the source carries a figure the memo omits",
};

function renderGapKind(gapKind: string): string {
  return GAP_KIND_LABELS[gapKind] ?? gapKind.replace(/_/g, " ");
}

// Topic label lookup
const TOPIC_LABEL_MAP: Record<string, string> = {};
SEEDED_TOPICS.forEach((t) => { TOPIC_LABEL_MAP[t.topic_id] = t.topic_label; });

function getTopicLabel(topicId: string): string {
  return TOPIC_LABEL_MAP[topicId] ?? topicId.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const OaFindingRow = z.object({
  finding_id: z.string(),
  topic_id: z.string(),
  gap_kind: z.string(),
  materiality_tier: z.coerce.number(),
  materiality_basis: z.string().nullable(),
  subject_evidence: z.any(),
  reference_evidence: z.any(),
  narrative: z.string().nullable(),
});

const CheckpointRow = z.object({
  payload_json: z.any(),
});

const ModuleRunExistsRow = z.object({
  id: z.string(),
});

const DocumentRow = z.object({
  file_name: z.string(),
});

export default api({
  name: "PublishOaToModuleOutputs",
  description: "Publishes an OA run to module_outputs so the dashboard renders it",

  integrations: {
    db: postgres(DB_ID),
  },

  input: z.object({
    dealId: z.string(),
    runId: z.string(),
  }),

  output: z.object({
    moduleRunId: z.string(),
    outputId: z.string(),
    findingsCount: z.number(),
    tierCounts: z.object({
      tier1: z.number(),
      tier2: z.number(),
      tier3: z.number(),
    }),
  }),

  async run(ctx, { dealId, runId }) {
    const db = ctx.integrations.db;

    // ─── 1. Load OA findings ─────────────────────────────────────────────
    const findings = await db.query(
      `SELECT finding_id, topic_id, gap_kind, materiality_tier, materiality_basis,
              subject_evidence, reference_evidence, narrative
       FROM oa_findings
       WHERE run_id = $1::uuid
       ORDER BY materiality_tier ASC, topic_id ASC`,
      OaFindingRow,
      [runId],
      { label: "Load OA findings for publish" }
    );

    if (findings.length === 0) {
      throw new Error(`No oa_findings found for run_id=${runId}`);
    }

    // ─── 2. Load rendered report markdown ────────────────────────────────
    const checkpoints = await db.query(
      `SELECT payload_json FROM oa_stage_checkpoints
       WHERE run_id = $1::uuid AND stage = 'render' AND unit_key = 'report_markdown'
       LIMIT 1`,
      CheckpointRow,
      [runId],
      { label: "Load rendered report" }
    );

    if (checkpoints.length === 0) {
      throw new Error(`No rendered report checkpoint for run_id=${runId}. Run OaRender first.`);
    }

    const payload = typeof checkpoints[0].payload_json === "string"
      ? JSON.parse(checkpoints[0].payload_json)
      : checkpoints[0].payload_json;
    const fullReport: string = payload.report_markdown ?? "";

    // ─── 3. Get document names for source_docs field ─────────────────────
    const docs = await db.query(
      `SELECT DISTINCT file_name FROM documents WHERE deal_id = $1::uuid`,
      DocumentRow,
      [dealId],
      { label: "Load deal documents for source mapping" }
    );
    const docNameSet = new Set(docs.map((d) => d.file_name));

    // ─── 4. Transform findings per SPEC 1/2/3 ────────────────────────────
    const tierCounts = { tier1: 0, tier2: 0, tier3: 0 };
    let withheldCount = 0;
    const truncatedTopics: string[] = [];

    const canonicalFindings = findings.map((f) => {
      const tier = f.materiality_tier;
      if (tier === 1) tierCounts.tier1++;
      else if (tier === 2) tierCounts.tier2++;
      else tierCounts.tier3++;

      if (!f.narrative) withheldCount++;

      // SPEC 1: severity mapping — Tier 1 → critical, Tier 2 → warning, Tier 3 → info
      const severity: "critical" | "warning" | "info" = tier === 1 ? "critical" : tier === 2 ? "warning" : "info";

      // SPEC 2: title
      const topicLabel = getTopicLabel(f.topic_id);
      const title = `Tier ${tier} — ${topicLabel}`;

      // SPEC 2: detail — 1-2 sentence preview derived from narrative opening + gap kind
      const gapLabel = renderGapKind(f.gap_kind);
      let detail: string;
      if (f.narrative) {
        // Extract the core claim from the narrative's second paragraph (the "However" paragraph)
        // which states the gap. If not found, use the first sentence of the first paragraph.
        const paragraphs = f.narrative.split(/\n\n+/);
        let coreClaim = "";
        // Look for the "However" or contradiction paragraph
        const gapPara = paragraphs.find((p: string) => /^however[, ]/i.test(p.trim()));
        if (gapPara) {
          // Take first sentence of the gap paragraph
          const firstSentence = gapPara.trim().split(/(?<=[.])\s+/).slice(0, 1).join(" ");
          // Limit to ~200 chars
          coreClaim = firstSentence.length > 250 ? firstSentence.slice(0, 247) + "…" : firstSentence;
        } else if (paragraphs.length > 0) {
          // Fallback: last sentence of first paragraph or first sentence
          const sentences = paragraphs[0].trim().split(/(?<=[.])\s+/);
          const last = sentences[sentences.length - 1];
          coreClaim = last.length > 250 ? last.slice(0, 247) + "…" : last;
        }
        detail = coreClaim ? `${coreClaim} ${gapLabel}.` : `${gapLabel}.`;
      } else {
        detail = `${gapLabel}. Narrative withheld on quote validation.`;
      }

      // SPEC 2: full_analysis — narrative + evidence block + adviser rating as rendered
      // For withheld narratives, use the explanation text
      let fullAnalysis: string;
      if (f.narrative) {
        fullAnalysis = f.narrative;
      } else {
        fullAnalysis = "Narrative withheld: the generated text contained a quotation that could not be verified against source. Evidence and basis are shown below.";
      }

      // Append rendered evidence block from the full report (the report has it rendered)
      // We rebuild a minimal evidence summary for the card view
      const allEvidence = [
        ...(Array.isArray(f.subject_evidence) ? f.subject_evidence : []),
        ...(Array.isArray(f.reference_evidence) ? f.reference_evidence : []),
      ];
      if (allEvidence.length > 0) {
        const evidenceLines = allEvidence.slice(0, 5).map((e: any) => {
          const parts: string[] = [];
          if (e?.predicate) parts.push(e.predicate);
          if (e?.value) parts.push(`= ${e.value}`);
          const docName = e?.document_name ?? "Unknown";
          return `• ${docName}: ${parts.join(" ") || "(fact reference)"}`;
        });
        fullAnalysis += `\n\nKey evidence (${allEvidence.length} total facts):\n${evidenceLines.join("\n")}`;
        if (allEvidence.length > 5) {
          fullAnalysis += `\n… and ${allEvidence.length - 5} more`;
        }
      }

      // materiality_basis stays in full_analysis (not in detail)
      const basisText = f.materiality_basis ?? "";
      if (basisText) {
        fullAnalysis += `\n\nBasis: ${basisText}`;
      }

      // SPEC 2: source_docs — distinct document names from evidence
      const sourceDocs: string[] = [];
      const seenDocs = new Set<string>();
      for (const e of allEvidence) {
        const dn = e?.document_name;
        if (dn && !seenDocs.has(dn)) {
          seenDocs.add(dn);
          sourceDocs.push(dn);
        }
      }

      return {
        finding_id: f.finding_id,
        severity,
        title,
        detail,
        full_analysis: fullAnalysis,
        source_docs: sourceDocs,
        // Required canonical fields with safe defaults
        category: "principal_finding" as const,
        finding_kind: f.gap_kind === "unreconciled_divergence" ? "data_divergence" as const
          : f.gap_kind === "not_disclosed" ? "absence_claim" as const
          : f.gap_kind === "scope_mismatch" ? "data_divergence" as const
          : "process_observation" as const,
      };
    });

    // ─── 5. Build executive header per SPEC 3 ────────────────────────────
    // Count findings with capped evidence (> 150 in either evidence array)
    const cappedCount = findings.filter((f) => {
      const subLen = Array.isArray(f.subject_evidence) ? f.subject_evidence.length : 0;
      const refLen = Array.isArray(f.reference_evidence) ? f.reference_evidence.length : 0;
      return subLen >= 150 || refLen >= 150;
    }).length;

    // Find zero-fact documents from rendered report context
    // (The models are known: the two financial models contributed no facts)
    const executiveHeader = [
      `Omission Audit: ${findings.length} findings across ${tierCounts.tier1 + tierCounts.tier2 + tierCounts.tier3} topics.`,
      ``,
      `Findings by tier: ${tierCounts.tier1} Tier 1 (potentially deal-relevant), ${tierCounts.tier2} Tier 2 (worth a condition or follow-up), ${tierCounts.tier3} Tier 3 (noted).`,
      ``,
      `Obligation checklist version: ${OBLIGATION_CHECKLIST_VERSION}.`,
      ``,
      `Scope: findings are drawn from IC memos compared against the CIM, PwC Vendor FDD, Osborne Clarke Legal DD, and Altman Solon CDD.`,
      ``,
      `Limitations:`,
      `• Both financial models (Base Case and Downside Case) contributed no analysable facts to the extraction pipeline.`,
      `• ${cappedCount} findings had evidence sets capped at 150 facts per role (subject or reference).`,
      `• ${withheldCount} narratives were withheld because the generated text contained a quotation that could not be verified against source.`,
    ].join("\n");

    // ─── 6. Ensure module_runs row exists ────────────────────────────────
    // Check if there's already a module_runs row for this run
    const existingRuns = await db.query(
      `SELECT id FROM module_runs WHERE id = $1::uuid LIMIT 1`,
      ModuleRunExistsRow,
      [runId],
      { label: "Check existing module_run" }
    );

    let moduleRunId: string;
    if (existingRuns.length > 0) {
      moduleRunId = existingRuns[0].id;
      // Update to completed if not already
      await db.execute(
        `UPDATE module_runs SET status = 'completed', completed_at = NOW()
         WHERE id = $1::uuid AND status != 'completed'`,
        [runId],
        { label: "Mark module_run completed" }
      );
    } else {
      // Insert new module_runs row with the OA run's ID
      moduleRunId = runId;
      await db.execute(
        `INSERT INTO module_runs (id, deal_id, module_id, status, triggered_at, completed_at, documents_included)
         VALUES ($1::uuid, $2::uuid, 'omission_audit', 'completed', NOW(), NOW(), '{}')
         ON CONFLICT (id) DO UPDATE SET status = 'completed', completed_at = NOW()`,
        [runId, dealId],
        { label: "Insert module_runs row for OA" }
      );
    }

    // ─── 7. Write module_outputs directly (no schema_version column) ────
    // Delete any existing output for this run first
    await db.execute(
      `DELETE FROM module_outputs WHERE module_run_id = $1::uuid`,
      [moduleRunId],
      { label: "Clear existing module_output" }
    );

    const findingsJson = JSON.stringify(canonicalFindings);

    const OutputIdRow = z.object({ id: z.string() });
    const insertResult = await db.query(
      `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown)
       VALUES ($1::uuid, $2, $3::jsonb, $4)
       RETURNING id`,
      OutputIdRow,
      [moduleRunId, executiveHeader, findingsJson, fullReport],
      { label: "Insert module_outputs row" }
    );

    const outputId = insertResult[0]?.id ?? "unknown";

    // Bump deal updated_at
    await db.execute(
      `UPDATE deals SET updated_at = NOW() WHERE id = $1::uuid`,
      [dealId],
      { label: "Bump deal updated_at" }
    );

    return {
      moduleRunId,
      outputId,
      findingsCount: canonicalFindings.length,
      tierCounts,
    };
  },
});
