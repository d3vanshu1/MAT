/**
 * PublishEroToModuleOutputs
 *
 * One-shot data-write that publishes an existing ERO v2 run's output into
 * module_runs + module_outputs so the dashboard renders it.
 *
 * DETERMINISTIC. ZERO LLM CALLS. Pure row-reading and canonical mapping.
 *
 * Uses module_id = "external_risk_overlay" (same as v1) so the dashboard's
 * DISTINCT ON (module_id) naturally shows v2's output on the same card.
 *
 * Evidence URLs and corpus classification survive in full_analysis.
 * URLs are FIRST-CLASS — every evidence item is rendered with its
 * resolvable URL, publisher, date, and source tier.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ═══════════════════════════════════════════════════════════════════
// MODULE_ID — same as v1 so dashboard card is the same
// ═══════════════════════════════════════════════════════════════════

const ERO_MODULE_ID = "external_risk_overlay";

// ═══════════════════════════════════════════════════════════════════
// DB ROW SCHEMAS
// ═══════════════════════════════════════════════════════════════════

const PipelineStateRow = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
});

const FindingRow = z.object({
  finding_id: z.string(),
  hypothesis_id: z.string(),
  verdict: z.string(),
  severity: z.string(),
  ceiling_reason: z.string(),
  title: z.string(),
  detail: z.string(),
  materiality_rationale: z.string(),
});

const HypothesisRow = z.object({
  hypothesis_id: z.string(),
  family: z.string(),
  question: z.string(),
  execution_rank: z.coerce.number(),
  status: z.string(),
  entity_id: z.string().nullable(),
});

const EvidenceRow = z.object({
  evidence_id: z.string(),
  hypothesis_id: z.string(),
  url: z.string(),
  domain: z.string().nullable(),
  publisher: z.string().nullable(),
  publication_date: z.string().nullable(),
  source_tier: z.coerce.number(),
  verbatim_snippet: z.string(),
});

const CorpusCheckRow = z.object({
  finding_id: z.string(),
  classification: z.string().nullable(),
  best_hit_snippet: z.string().nullable(),
  best_hit_document_id: z.string().nullable(),
});

const DocumentNameRow = z.object({
  id: z.string(),
  file_name: z.string(),
});

const HypCountRow = z.object({
  total: z.coerce.number(),
  researched: z.coerce.number(),
  no_evidence: z.coerce.number(),
});

const OutputIdRow = z.object({ id: z.string() });

// ═══════════════════════════════════════════════════════════════════
// CLASSIFICATION LABELS (for full_analysis rendering)
// ═══════════════════════════════════════════════════════════════════

const CLASSIFICATION_LABELS: Record<string, string> = {
  known_but_understated:
    "Understated by Deal Team — external evidence exceeds deal team's stated figures",
  unknown_to_deal_team:
    "Unknown to Deal Team — not found in deal documents",
  known_and_assessed:
    "Known and Assessed — deal team addressed this risk",
};

const TIER_LABELS: Record<number, string> = {
  1: "Tier 1 — Authoritative",
  2: "Tier 2 — Reputable",
  3: "Tier 3 — General Web",
};

// ═══════════════════════════════════════════════════════════════════
// FAMILY → FINDING_KIND MAPPING
// ═══════════════════════════════════════════════════════════════════

function familyToFindingKind(
  family: string,
): "data_divergence" | "absence_claim" | "source_stated_risk" | "process_observation" {
  // litigation/regulatory/enforcement families are sourced external risks
  if (
    family === "litigation_enforcement" ||
    family === "regulatory" ||
    family === "sanctions_pep"
  ) {
    return "source_stated_risk";
  }
  // competitive/market families are external data divergence
  if (family === "competitive" || family === "market_position") {
    return "data_divergence";
  }
  return "process_observation";
}

// ═══════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════

export default api({
  name: "PublishEroToModuleOutputs",
  description:
    "Publishes an ERO v2 run to module_outputs for the dashboard",

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
    classificationCounts: z.object({
      unknown_to_deal_team: z.number(),
      known_and_assessed: z.number(),
      known_but_understated: z.number(),
    }),
  }),

  async run(ctx, { runId }) {
    const db = ctx.integrations.db;

    // ── 1. Load pipeline state ──────────────────────────────────────
    const stateRows = await db.query(
      `SELECT run_id, deal_id, current_stage, stage_status
       FROM ero_pipeline_state WHERE run_id = $1`,
      PipelineStateRow,
      [runId],
      { label: "Publish: load pipeline state" },
    );

    if (stateRows.length === 0) {
      throw new Error(`ERO run not found: ${runId}`);
    }

    const dealId = stateRows[0].deal_id;

    // ── 2. Load ERO data ────────────────────────────────────────────

    const [findings, hypotheses, evidence, corpusChecks, hypCounts] =
      await Promise.all([
        db.query(
          `SELECT f.finding_id, f.hypothesis_id, f.verdict, f.severity,
                  f.ceiling_reason, f.title, f.detail, f.materiality_rationale
           FROM ero_findings f
           JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
           WHERE h.run_id = $1
           ORDER BY f.created_at ASC`,
          FindingRow,
          [runId],
          { label: "Publish: load findings" },
        ),
        db.query(
          `SELECT hypothesis_id, family, question, execution_rank, status, entity_id
           FROM ero_hypotheses WHERE run_id = $1
           ORDER BY execution_rank ASC`,
          HypothesisRow,
          [runId],
          { label: "Publish: load hypotheses" },
        ),
        db.query(
          `SELECT e.evidence_id, e.hypothesis_id, e.url, e.domain, e.publisher,
                  e.publication_date::text AS publication_date, e.source_tier,
                  e.verbatim_snippet
           FROM ero_evidence e
           JOIN ero_hypotheses h ON h.hypothesis_id = e.hypothesis_id
           WHERE h.run_id = $1
           ORDER BY e.hypothesis_id, e.source_tier ASC`,
          EvidenceRow,
          [runId],
          { label: "Publish: load evidence" },
        ),
        db.query(
          `SELECT DISTINCT ON (cc.finding_id)
                  cc.finding_id, cc.classification, cc.best_hit_snippet,
                  cc.best_hit_document_id
           FROM ero_corpus_checks cc
           JOIN ero_findings f ON f.finding_id = cc.finding_id
           JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
           WHERE h.run_id = $1 AND cc.classification IS NOT NULL
           ORDER BY cc.finding_id, cc.checked_at ASC`,
          CorpusCheckRow,
          [runId],
          { label: "Publish: load corpus classifications" },
        ),
        db.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'researched')::int AS researched,
             COUNT(*) FILTER (WHERE status = 'no_evidence_found')::int AS no_evidence
           FROM ero_hypotheses
           WHERE run_id = $1`,
          HypCountRow,
          [runId],
          { label: "Publish: hypothesis counts" },
        ),
      ]);

    if (findings.length === 0) {
      throw new Error(
        `No ero_findings found for run_id=${runId}. Run the pipeline through render first.`,
      );
    }

    // ── 3. Resolve document filenames for corpus best-hit docs ───────
    const corpusDocIds = new Set<string>();
    for (const cc of corpusChecks) {
      if (cc.best_hit_document_id) corpusDocIds.add(cc.best_hit_document_id);
    }

    const docNameMap = new Map<string, string>();
    if (corpusDocIds.size > 0) {
      const docIds = Array.from(corpusDocIds);
      const docRows = await db.query(
        `SELECT id, file_name FROM documents
         WHERE id = ANY($1::uuid[])`,
        DocumentNameRow,
        [docIds],
        { label: "Publish: resolve document filenames" },
      );
      for (const d of docRows) {
        docNameMap.set(d.id, d.file_name);
      }
    }

    // ── 4. Build lookup maps ────────────────────────────────────────

    const hypMap = new Map<string, z.infer<typeof HypothesisRow>>();
    for (const h of hypotheses) {
      hypMap.set(h.hypothesis_id, h);
    }

    const evidenceByHyp = new Map<
      string,
      Array<z.infer<typeof EvidenceRow>>
    >();
    for (const ev of evidence) {
      const arr = evidenceByHyp.get(ev.hypothesis_id) ?? [];
      arr.push(ev);
      evidenceByHyp.set(ev.hypothesis_id, arr);
    }

    const corpusByFinding = new Map<
      string,
      z.infer<typeof CorpusCheckRow>
    >();
    for (const cc of corpusChecks) {
      if (!corpusByFinding.has(cc.finding_id)) {
        corpusByFinding.set(cc.finding_id, cc);
      }
    }

    // ── 5. Transform findings to canonical shape ────────────────────

    const classificationCounts = {
      unknown_to_deal_team: 0,
      known_and_assessed: 0,
      known_but_understated: 0,
    };

    const canonicalFindings = findings.map((f) => {
      const hyp = hypMap.get(f.hypothesis_id);
      const evidItems = evidenceByHyp.get(f.hypothesis_id) ?? [];
      const corpus = corpusByFinding.get(f.finding_id);
      const classification =
        corpus?.classification ?? "unknown_to_deal_team";

      // Count classifications
      if (classification in classificationCounts) {
        classificationCounts[
          classification as keyof typeof classificationCounts
        ]++;
      }

      // ── full_analysis: carries evidence URLs + corpus classification ──
      // This is where URLs and classification survive publish. The dashboard
      // renders full_analysis as the expanded finding content.
      const analysisLines: string[] = [];

      // Detail + materiality
      analysisLines.push(f.detail);
      analysisLines.push("");
      analysisLines.push(`**Materiality:** ${f.materiality_rationale}`);
      analysisLines.push("");

      // Corpus classification section
      const classLabel =
        CLASSIFICATION_LABELS[classification] ?? classification;
      analysisLines.push(`**Corpus Classification:** ${classLabel}`);
      if (
        classification === "known_but_understated" &&
        corpus?.best_hit_snippet
      ) {
        analysisLines.push(
          `**Corpus excerpt:** _"${corpus.best_hit_snippet.slice(0, 300)}"_`,
        );
      } else if (
        classification === "known_and_assessed" &&
        corpus?.best_hit_snippet
      ) {
        analysisLines.push(
          `**Corpus reference:** _"${corpus.best_hit_snippet.slice(0, 300)}"_`,
        );
      }
      analysisLines.push("");

      // Severity + ceiling context
      analysisLines.push(
        `**Severity:** ${f.severity} (${f.ceiling_reason})`,
      );
      analysisLines.push(`**Verdict:** ${f.verdict}`);
      analysisLines.push("");

      // ── Evidence list — URLs are FIRST-CLASS ──────────────────────
      if (evidItems.length > 0) {
        analysisLines.push(`**Evidence (${evidItems.length} sources):**`);
        analysisLines.push("");
        for (let i = 0; i < evidItems.length; i++) {
          const ev = evidItems[i];
          const tierLabel =
            TIER_LABELS[ev.source_tier] ?? `Tier ${ev.source_tier}`;
          analysisLines.push(`${i + 1}. **${tierLabel}**`);
          analysisLines.push(`   - URL: ${ev.url}`);
          if (ev.publisher) {
            analysisLines.push(`   - Publisher: ${ev.publisher}`);
          }
          analysisLines.push(
            `   - Date: ${ev.publication_date ?? "undated"}`,
          );
          analysisLines.push(`   - Domain: ${ev.domain ?? "unknown"}`);
          analysisLines.push(
            `   - Snippet: ${ev.verbatim_snippet.slice(0, 200)}`,
          );
          analysisLines.push("");
        }
      }

      const fullAnalysis = analysisLines.join("\n");

      // ── source_docs: corpus document filenames + evidence domains ──
      const sourceDocs: string[] = [];
      const seenDocs = new Set<string>();

      // Corpus best-hit document filename
      if (corpus?.best_hit_document_id) {
        const fileName = docNameMap.get(corpus.best_hit_document_id);
        if (fileName && !seenDocs.has(fileName)) {
          seenDocs.add(fileName);
          sourceDocs.push(fileName);
        }
      }

      // Evidence domains as source identifiers
      for (const ev of evidItems) {
        const domainLabel = ev.domain ?? ev.url;
        if (!seenDocs.has(domainLabel)) {
          seenDocs.add(domainLabel);
          sourceDocs.push(domainLabel);
        }
      }

      // ── evidence array (canonical EvidenceItemSchema shape) ────────
      const canonicalEvidence = evidItems.map((ev) => ({
        figure: ev.verbatim_snippet.slice(0, 200),
        source_doc: ev.url,   // ← URL verbatim as source_doc
        verbatim_snippet: ev.verbatim_snippet,
        verified: ev.source_tier <= 2, // Tier 1/2 = verified
        source_filename: ev.domain ?? undefined,
        document_role: `external_tier_${ev.source_tier}`,
      }));

      // Determine finding_kind from hypothesis family
      const family = hyp?.family ?? "unknown";
      const findingKind = familyToFindingKind(family);

      return {
        finding_id: f.finding_id,
        severity: f.severity as "critical" | "warning" | "info",
        title: f.title,
        detail: f.detail,
        full_analysis: fullAnalysis,
        source_docs: sourceDocs,
        category: "principal_finding" as const,
        finding_kind: findingKind,
        evidence: canonicalEvidence,
        materiality_rationale: f.materiality_rationale,
      };
    });

    // ── 6. Build executive header ───────────────────────────────────

    const hc = hypCounts[0] ?? { total: 0, researched: 0, no_evidence: 0 };

    const executiveHeader = [
      `External Risk Overlay (v2): ${findings.length} findings from ${hc.total} hypotheses.`,
      ``,
      `Hypotheses: ${hc.total} generated, ${hc.researched} researched, ${hc.no_evidence} no evidence found.`,
      ``,
      `Findings by corpus classification:`,
      `• ${classificationCounts.known_but_understated} Understated by Deal Team`,
      `• ${classificationCounts.unknown_to_deal_team} Unknown to Deal Team`,
      `• ${classificationCounts.known_and_assessed} Known and Assessed`,
      ``,
      `Severity: ${findings.filter((f) => f.severity === "critical").length} critical, ${findings.filter((f) => f.severity === "warning").length} warning, ${findings.filter((f) => f.severity === "info").length} info.`,
    ].join("\n");

    // ── 7. Build full_report_markdown from render ───────────────────
    // Render stored the markdown in stageData, but stageData is ephemeral
    // (not in DB). Rebuild a minimal markdown from the canonical findings.
    // This matches OA's pattern where publish rebuilds the report text.

    const mdLines: string[] = [];
    mdLines.push("# External Risk Overlay — Report");
    mdLines.push("");
    mdLines.push(executiveHeader);
    mdLines.push("");
    mdLines.push("---");
    mdLines.push("");

    for (const cf of canonicalFindings) {
      mdLines.push(`## ${cf.title}`);
      mdLines.push("");
      mdLines.push(cf.full_analysis);
      mdLines.push("");
      mdLines.push("---");
      mdLines.push("");
    }

    const fullReportMarkdown = mdLines.join("\n");

    // ── 8. Upsert module_runs ───────────────────────────────────────
    // Mirror OA exactly: INSERT ... ON CONFLICT DO UPDATE

    await db.execute(
      `INSERT INTO module_runs
         (id, deal_id, module_id, status, triggered_at, completed_at, documents_included)
       VALUES ($1::uuid, $2::uuid, $3, 'completed', NOW(), NOW(), '{}')
       ON CONFLICT (id) DO UPDATE
         SET status = 'completed', completed_at = NOW()`,
      [runId, dealId, ERO_MODULE_ID],
      { label: "Publish: upsert module_runs" },
    );

    // ── 9. DELETE then INSERT module_outputs ─────────────────────────

    await db.execute(
      `DELETE FROM module_outputs WHERE module_run_id = $1::uuid`,
      [runId],
      { label: "Publish: clear existing module_output" },
    );

    const findingsJson = JSON.stringify(canonicalFindings);

    const insertResult = await db.query(
      `INSERT INTO module_outputs
         (module_run_id, executive_header, findings, full_report_markdown)
       VALUES ($1::uuid, $2, $3::jsonb, $4)
       RETURNING id`,
      OutputIdRow,
      [runId, executiveHeader, findingsJson, fullReportMarkdown],
      { label: "Publish: insert module_outputs row" },
    );

    const outputId = insertResult[0]?.id ?? "unknown";

    // ── 10. Bump deals.updated_at ───────────────────────────────────

    await db.execute(
      `UPDATE deals SET updated_at = NOW() WHERE id = $1::uuid`,
      [dealId],
      { label: "Publish: bump deal updated_at" },
    );

    return {
      moduleRunId: runId,
      outputId,
      findingsCount: canonicalFindings.length,
      classificationCounts,
    };
  },
});
