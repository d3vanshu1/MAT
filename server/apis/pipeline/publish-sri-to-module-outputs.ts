/**
 * PublishSriToModuleOutputs
 *
 * One-shot data-write that publishes an existing SRI v2 run's output into
 * module_runs + module_outputs so the dashboard renders it.
 *
 * DETERMINISTIC. ZERO LLM CALLS. Pure row-reading and canonical mapping.
 *
 * Uses module_id = "social_reputation" (same as v1) so the dashboard's
 * DISTINCT ON (module_id) naturally shows v2's output on the same card.
 *
 * Evidence URLs survive in full_analysis. URLs are FIRST-CLASS.
 *
 * finding_kind mapping — keyed on verdict, not claim_type:
 *   contradicted + metric_value present → data_divergence
 *   contradicted (no metric) / mixed    → source_stated_risk
 *   corroborated / unverifiable / not_searched → process_observation
 *   Never absence_claim (reserved for omission verification).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const SRI_MODULE_ID = "social_reputation";

// ═══════════════════════════════════════════════════════════════════
// DB ROW SCHEMAS
// ═══════════════════════════════════════════════════════════════════

const PipelineStateRow = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
});

const ClaimRow = z.object({
  claim_id: z.string(),
  claim_text: z.string(),
  claim_type: z.string(),
  subject_entity: z.string().nullable(),
  attribution: z.string().nullable(),
  thesis_dependence: z.string().nullable(),
  locator: z.string().nullable(),
  metric_value: z.string().nullable(),
  document_id: z.string().nullable(),
});

const FindingRow = z.object({
  finding_id: z.string(),
  claim_id: z.string(),
  verdict: z.string(),
  severity: z.string(),
  title: z.string(),
  detail: z.string(),
  entity_confidence: z.string().nullable(),
  pointer_text: z.string().nullable(),
});

const EvidenceRow = z.object({
  evidence_id: z.string(),
  claim_id: z.string(),
  platform: z.string(),
  url: z.string(),
  domain: z.string().nullable(),
  publisher: z.string().nullable(),
  publication_date: z.string().nullable(),
  snippet: z.string().nullable(),
  stance: z.string().nullable(),
  entity_match: z.string().nullable(),
});

const DocumentNameRow = z.object({
  id: z.string(),
  file_name: z.string(),
});

const ClaimCountRow = z.object({
  total: z.coerce.number(),
  verified: z.coerce.number(),
  unverifiable: z.coerce.number(),
  not_searched: z.coerce.number(),
});

const OutputIdRow = z.object({ id: z.string() });

// ═══════════════════════════════════════════════════════════════════
// VERDICT → FINDING_KIND
// ═══════════════════════════════════════════════════════════════════

const VERDICT_LABELS: Record<string, string> = {
  contradicted: "Contradicted by Public Evidence",
  mixed: "Mixed Public Evidence",
  corroborated: "Corroborated by Public Evidence",
  unverifiable: "No Public Evidence Found",
  not_searched: "Not Searched",
};

const CLAIM_TYPE_LABELS: Record<string, string> = {
  culture: "Culture",
  retention_attrition: "Retention / Attrition",
  headcount: "Headcount",
  employer_reputation: "Employer Reputation",
  nps_csat: "NPS / CSAT",
  customer_satisfaction: "Customer Satisfaction",
  brand_reputation: "Brand Reputation",
  award: "Awards & Recognition",
};

function verdictToFindingKind(
  verdict: string,
  hasMetricValue: boolean,
): "data_divergence" | "source_stated_risk" | "process_observation" {
  if (verdict === "contradicted" && hasMetricValue) return "data_divergence";
  if (verdict === "contradicted" || verdict === "mixed") return "source_stated_risk";
  return "process_observation";
}

// ═══════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════

export default api({
  name: "PublishSriToModuleOutputs",
  description: "Publishes an SRI v2 run to module_outputs for the dashboard",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    moduleRunId: z.string(),
    outputId: z.string(),
    findingsCount: z.number(),
    verdictCounts: z.object({
      contradicted: z.number(),
      mixed: z.number(),
      corroborated: z.number(),
      unverifiable: z.number(),
      not_searched: z.number(),
    }),
  }),

  async run(ctx, { runId }) {
    const db = ctx.integrations.db;

    // ── 1. Load pipeline state ──────────────────────────────────────
    const stateRows = await db.query(
      "SELECT run_id, deal_id, current_stage, stage_status FROM sri_pipeline_state WHERE run_id = $1",
      PipelineStateRow,
      [runId],
      { label: "SRI Publish: load pipeline state" },
    );

    if (stateRows.length === 0) {
      throw new Error("SRI run not found: " + runId);
    }

    const dealId = stateRows[0].deal_id;

    // ── 2. Load SRI data ────────────────────────────────────────────

    const [claims, findings, evidence, claimCounts] = await Promise.all([
      db.query(
        "SELECT claim_id, claim_text, claim_type, subject_entity, attribution, thesis_dependence, locator, metric_value, document_id FROM sri_claims WHERE run_id = $1 ORDER BY claim_type, created_at ASC",
        ClaimRow,
        [runId],
        { label: "SRI Publish: load claims" },
      ),
      db.query(
        "SELECT finding_id, claim_id, verdict, severity, title, detail, entity_confidence, pointer_text FROM sri_findings WHERE run_id = $1 ORDER BY created_at ASC",
        FindingRow,
        [runId],
        { label: "SRI Publish: load findings" },
      ),
      db.query(
        "SELECT e.evidence_id, e.claim_id, e.platform, e.url, e.domain, e.publisher, e.publication_date::text AS publication_date, e.snippet, e.stance, e.entity_match FROM sri_evidence e JOIN sri_claims c ON c.claim_id = e.claim_id WHERE c.run_id = $1 ORDER BY e.claim_id, e.retrieved_at ASC",
        EvidenceRow,
        [runId],
        { label: "SRI Publish: load evidence" },
      ),
      db.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE claim_id IN (SELECT claim_id FROM sri_findings WHERE run_id = $1 AND verdict NOT IN ('unverifiable', 'not_searched')))::int AS verified, count(*) FILTER (WHERE claim_id IN (SELECT claim_id FROM sri_findings WHERE run_id = $1 AND verdict = 'unverifiable'))::int AS unverifiable, count(*) FILTER (WHERE claim_id IN (SELECT claim_id FROM sri_findings WHERE run_id = $1 AND verdict = 'not_searched'))::int AS not_searched FROM sri_claims WHERE run_id = $1",
        ClaimCountRow,
        [runId],
        { label: "SRI Publish: claim counts" },
      ),
    ]);

    if (findings.length === 0) {
      throw new Error("No sri_findings found for run_id=" + runId + ". Run the pipeline through render first.");
    }

    // ── 3. Resolve document filenames ───────────────────────────────

    const docIds = new Set<string>();
    for (const c of claims) {
      if (c.document_id) docIds.add(c.document_id);
    }

    const docNameMap = new Map<string, string>();
    if (docIds.size > 0) {
      const docRows = await db.query(
        "SELECT id, file_name FROM documents WHERE id = ANY($1::uuid[])",
        DocumentNameRow,
        [Array.from(docIds)],
        { label: "SRI Publish: resolve document filenames" },
      );
      for (const d of docRows) {
        docNameMap.set(d.id, d.file_name);
      }
    }

    // ── 4. Build lookup maps ────────────────────────────────────────

    const claimMap = new Map<string, z.infer<typeof ClaimRow>>();
    for (const c of claims) {
      claimMap.set(c.claim_id, c);
    }

    const evidenceByClaimId = new Map<string, Array<z.infer<typeof EvidenceRow>>>();
    for (const ev of evidence) {
      const arr = evidenceByClaimId.get(ev.claim_id) ?? [];
      arr.push(ev);
      evidenceByClaimId.set(ev.claim_id, arr);
    }

    // ── 5. Transform findings to canonical shape ────────────────────

    const verdictCounts = {
      contradicted: 0,
      mixed: 0,
      corroborated: 0,
      unverifiable: 0,
      not_searched: 0,
    };

    const canonicalFindings = findings.map((f: z.infer<typeof FindingRow>) => {
      const claim = claimMap.get(f.claim_id);
      const evidItems = evidenceByClaimId.get(f.claim_id) ?? [];

      // Count verdicts
      if (f.verdict in verdictCounts) {
        verdictCounts[f.verdict as keyof typeof verdictCounts]++;
      }

      // Compose display title from claim metadata
      const typeLabel = claim ? (CLAIM_TYPE_LABELS[claim.claim_type] ?? claim.claim_type) : "Unknown";
      const verdictVerb: Record<string, string> = {
        contradicted: "contradicted",
        mixed: "mixed evidence",
        corroborated: "corroborated",
        unverifiable: "unverifiable",
        not_searched: "not searched",
      };
      const verb = verdictVerb[f.verdict] ?? f.verdict;
      const entityPart = claim?.subject_entity ? " — " + claim.subject_entity : "";
      const sourcePart = evidItems.length > 0 ? " (" + evidItems.length + " source" + (evidItems.length === 1 ? "" : "s") + ")" : "";
      const displayTitle = typeLabel + " claim " + verb + entityPart + sourcePart;

      // ── full_analysis: carries evidence URLs ──────────────────────
      const analysisLines: string[] = [];

      // Claim text
      if (claim) {
        analysisLines.push("**Claim:** _\"" + claim.claim_text.slice(0, 500) + "\"_");
        analysisLines.push("");
        if (claim.attribution) analysisLines.push("**Source:** " + claim.attribution);
        if (claim.thesis_dependence) analysisLines.push("**Thesis dependence:** " + claim.thesis_dependence);
        if (claim.locator) analysisLines.push("**Locator:** " + claim.locator);
        analysisLines.push("");
      }

      // Verdict + entity confidence
      const verdictLabel = VERDICT_LABELS[f.verdict] ?? f.verdict;
      analysisLines.push("**Verdict:** " + verdictLabel);
      analysisLines.push("**Severity:** " + f.severity);
      if (f.entity_confidence) analysisLines.push("**Entity confidence:** " + f.entity_confidence);
      analysisLines.push("");

      if (f.pointer_text) {
        analysisLines.push("**Assessment:** " + f.pointer_text);
        analysisLines.push("");
      }

      // Evidence list — URLs are FIRST-CLASS
      if (evidItems.length > 0) {
        const supportsCount = evidItems.filter((e: z.infer<typeof EvidenceRow>) => e.stance === "supports").length;
        const contradictsCount = evidItems.filter((e: z.infer<typeof EvidenceRow>) => e.stance === "contradicts").length;
        analysisLines.push("**Evidence (" + supportsCount + " supports, " + contradictsCount + " contradicts):**");
        analysisLines.push("");
        for (let i = 0; i < evidItems.length; i++) {
          const ev = evidItems[i];
          const stanceTag = ev.stance ? " [" + ev.stance + "]" : "";
          analysisLines.push((i + 1) + ". **" + ev.platform + "**" + stanceTag);
          analysisLines.push("   - URL: " + ev.url);
          if (ev.domain) analysisLines.push("   - Domain: " + ev.domain);
          if (ev.publication_date) analysisLines.push("   - Date: " + ev.publication_date);
          if (ev.snippet) analysisLines.push("   - Snippet: " + ev.snippet.slice(0, 300));
          analysisLines.push("");
        }
      }

      const fullAnalysis = analysisLines.join("\n");

      // ── source_docs ──────────────────────────────────────────────
      const sourceDocs: string[] = [];
      const seenDocs = new Set<string>();

      // Source document filename
      if (claim?.document_id) {
        const fileName = docNameMap.get(claim.document_id);
        if (fileName && !seenDocs.has(fileName)) {
          seenDocs.add(fileName);
          sourceDocs.push(fileName);
        }
      }

      // Evidence domains
      for (const ev of evidItems) {
        const domainLabel = ev.domain ?? ev.url;
        if (!seenDocs.has(domainLabel)) {
          seenDocs.add(domainLabel);
          sourceDocs.push(domainLabel);
        }
      }

      // ── evidence array (canonical shape) ──────────────────────────
      const canonicalEvidence = evidItems.map((ev: z.infer<typeof EvidenceRow>) => ({
        figure: (ev.snippet ?? "").slice(0, 200),
        source_doc: ev.url,
        verbatim_snippet: ev.snippet ?? "",
        verified: ev.entity_match === "confirmed",
        source_filename: ev.domain ?? undefined,
        document_role: "external_" + ev.platform,
      }));

      // finding_kind from verdict + metric_value
      const hasMetricValue = claim?.metric_value != null && claim.metric_value.trim() !== "";
      const findingKind = verdictToFindingKind(f.verdict, hasMetricValue);

      return {
        finding_id: f.finding_id,
        severity: f.severity as "critical" | "warning" | "info",
        title: displayTitle,
        detail: claim?.claim_text ?? f.detail,
        full_analysis: fullAnalysis,
        source_docs: sourceDocs,
        category: "principal_finding" as const,
        finding_kind: findingKind,
        evidence: canonicalEvidence,
        materiality_rationale: f.pointer_text ?? "",
      };
    });

    // ── 6. Build executive header ───────────────────────────────────

    const cc = claimCounts[0] ?? { total: 0, verified: 0, unverifiable: 0, not_searched: 0 };

    const executiveHeader = [
      "Social & Reputation Intelligence (v2): " + findings.length + " findings from " + cc.total + " claims.",
      "",
      "Claims: " + cc.total + " extracted, " + cc.verified + " verified, " + cc.unverifiable + " unverifiable, " + cc.not_searched + " not searched.",
      "",
      "Verdicts: " + verdictCounts.contradicted + " contradicted, " + verdictCounts.mixed + " mixed, " + verdictCounts.corroborated + " corroborated.",
      "",
      "Severity: " + findings.filter((f: z.infer<typeof FindingRow>) => f.severity === "critical").length + " critical, " + findings.filter((f: z.infer<typeof FindingRow>) => f.severity === "warning").length + " warning, " + findings.filter((f: z.infer<typeof FindingRow>) => f.severity === "info").length + " info.",
    ].join("\n");

    // ── 7. Build full_report_markdown ───────────────────────────────

    const mdLines: string[] = [];
    mdLines.push("# Social & Reputation Intelligence — Report");
    mdLines.push("");
    mdLines.push(executiveHeader);
    mdLines.push("");
    mdLines.push("---");
    mdLines.push("");

    for (const cf of canonicalFindings) {
      mdLines.push("## " + cf.title);
      mdLines.push("");
      mdLines.push(cf.full_analysis);
      mdLines.push("");
      mdLines.push("---");
      mdLines.push("");
    }

    const fullReportMarkdown = mdLines.join("\n");

    // ── 8. Upsert module_runs ───────────────────────────────────────

    await db.execute(
      "INSERT INTO module_runs (id, deal_id, module_id, status, triggered_at, completed_at, documents_included) VALUES ($1::uuid, $2::uuid, $3, 'completed', NOW(), NOW(), '{}') ON CONFLICT (id) DO UPDATE SET status = 'completed', completed_at = NOW()",
      [runId, dealId, SRI_MODULE_ID],
      { label: "SRI Publish: upsert module_runs" },
    );

    // ── 9. DELETE then INSERT module_outputs ─────────────────────────

    await db.execute(
      "DELETE FROM module_outputs WHERE module_run_id = $1::uuid",
      [runId],
      { label: "SRI Publish: clear existing module_output" },
    );

    const findingsJson = JSON.stringify(canonicalFindings);

    const insertResult = await db.query(
      "INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown) VALUES ($1::uuid, $2, $3::jsonb, $4) RETURNING id",
      OutputIdRow,
      [runId, executiveHeader, findingsJson, fullReportMarkdown],
      { label: "SRI Publish: insert module_outputs row" },
    );

    const outputId = insertResult[0]?.id ?? "unknown";

    // ── 10. Bump deals.updated_at ───────────────────────────────────

    await db.execute(
      "UPDATE deals SET updated_at = NOW() WHERE id = $1::uuid",
      [dealId],
      { label: "SRI Publish: bump deal updated_at" },
    );

    return {
      moduleRunId: runId,
      outputId,
      findingsCount: canonicalFindings.length,
      verdictCounts,
    };
  },
});
