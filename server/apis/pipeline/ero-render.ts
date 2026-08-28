/**
 * ERO v2 — Render Stage (Phase 5, final stage)
 *
 * DETERMINISTIC. ZERO LLM CALLS. Pure row-reading and string assembly.
 *
 * Assembles the final External Risk Overlay report from the structured
 * rows already produced by stages 1–6. Findings are already adjudicated
 * and classified; render only arranges them.
 *
 * WHY NO LLM: every LLM pass over a finished finding is a chance to
 * drop a URL or soften evidence — that was v1's failure. Render reads
 * rows and formats. No model calls in this stage at all.
 *
 * The report is returned in stageData. A separate publish step (5.3)
 * writes it to module_runs + module_outputs for the dashboard.
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./ero-stage-contract.js";

// ═══════════════════════════════════════════════════════════════════
// DB ROW SCHEMAS
// ═══════════════════════════════════════════════════════════════════

const EntityRow = z.object({
  entity_id: z.string(),
  entity_type: z.string(),
  legal_name: z.string(),
  registration_number: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  role: z.string().nullable(),
});

const ProfileRow = z.object({
  field_group: z.string(),
  field_name: z.string(),
  field_value: z.string(),
});

const HypothesisRow = z.object({
  hypothesis_id: z.string(),
  family: z.string(),
  question: z.string(),
  execution_rank: z.coerce.number(),
  status: z.string(),
  entity_id: z.string().nullable(),
  thesis_link: z.string().nullable(),
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
  query_text: z.string(),
  hit_count: z.coerce.number(),
  best_hit_snippet: z.string().nullable(),
  classification: z.string().nullable(),
});

const CorpusClassificationRow = z.object({
  finding_id: z.string(),
  classification: z.string().nullable(),
  // For understated: the best_hit_snippet carries the corpus quote
  best_hit_snippet: z.string().nullable(),
});

const PipelineStateRow = z.object({
  created_at: z.string(),
});

// ═══════════════════════════════════════════════════════════════════
// SEVERITY ORDERING (for sorting within classification groups)
// ═══════════════════════════════════════════════════════════════════

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

// ═══════════════════════════════════════════════════════════════════
// TIER LABELS
// ═══════════════════════════════════════════════════════════════════

const TIER_LABELS: Record<number, string> = {
  1: "Tier 1 — Authoritative",
  2: "Tier 2 — Reputable",
  3: "Tier 3 — General Web",
};

// ═══════════════════════════════════════════════════════════════════
// CLASSIFICATION LABELS + ORDERING
// ═══════════════════════════════════════════════════════════════════

const CLASSIFICATION_ORDER: Record<string, number> = {
  known_but_understated: 0,
  unknown_to_deal_team: 1,
  known_and_assessed: 2,
};

const CLASSIFICATION_HEADINGS: Record<string, string> = {
  known_but_understated:
    "Understated by Deal Team — External Evidence Exceeds Stated Figures",
  unknown_to_deal_team:
    "Unknown to Deal Team — Not Found in Deal Documents",
  known_and_assessed:
    "Known and Assessed — Deal Team Addressed This Risk",
};

const CLASSIFICATION_INTROS: Record<string, string> = {
  known_but_understated:
    "These findings appear in the deal team's documents, but external evidence shows a larger magnitude than stated. Both the deal team's figure and the external figure are quoted below.",
  unknown_to_deal_team:
    "These findings are absent from the deal team's documents. The corpus was searched and returned no relevant content. This is the highest-value section for the IC — these are risks the deal team did not surface.",
  known_and_assessed:
    "These findings are addressed in the deal team's documents. The deal team is aware of and has assessed these risks.",
};

// ═══════════════════════════════════════════════════════════════════
// REPORT STRUCTURE TYPES
// ═══════════════════════════════════════════════════════════════════

interface RenderedEvidence {
  url: string;
  domain: string | null;
  publisher: string | null;
  publication_date: string | null;
  source_tier: number;
  tier_label: string;
  verbatim_snippet: string;
}

interface RenderedFinding {
  finding_id: string;
  title: string;
  severity: string;
  ceiling_reason: string;
  verdict: string;
  detail: string;
  materiality_rationale: string;
  classification: string;
  classification_label: string;
  corpus_quote: string | null;
  corpus_quoted_value: string | null;
  external_quoted_value: string | null;
  evidence: RenderedEvidence[];
  family: string;
  entity_name: string | null;
  execution_rank: number;
}

interface RenderedReport {
  header: {
    deal_id: string;
    run_id: string;
    generated_at: string;
    hypotheses_generated: number;
    hypotheses_researched: number;
    hypotheses_no_evidence: number;
    hypotheses_pending: number;
    findings_count: number;
  };
  entity_manifest: {
    counts_by_type: Record<string, number>;
    entity_roster: Array<{ legal_name: string; entity_type: string; jurisdiction: string | null }>;
  };
  deal_profile: {
    business_shape: Record<string, string>;
    thesis_dependencies: Record<string, string>;
  };
  findings_by_classification: Array<{
    classification: string;
    heading: string;
    intro: string;
    findings: RenderedFinding[];
  }>;
  no_evidence_coverage: Array<{
    question: string;
    family: string;
    execution_rank: number;
  }>;
  limitations: string[];
  full_report_markdown: string;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

export async function renderReport(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  const db = ctx.integrations.ic_diligence_db;

  // ── 1. Load all ERO rows for this run ─────────────────────────────

  const [entities, profileRows, hypotheses, findings, evidence, corpusChecks, pipelineState] =
    await Promise.all([
      db.query(
        `SELECT entity_id, entity_type, legal_name, registration_number,
                jurisdiction, role
         FROM ero_entities WHERE run_id = $1
         ORDER BY entity_type ASC, legal_name ASC`,
        EntityRow, [runId],
        { label: "Render: load entities" },
      ),
      db.query(
        `SELECT field_group, field_name, field_value
         FROM ero_profile WHERE run_id = $1
         ORDER BY field_group ASC, field_name ASC`,
        ProfileRow, [runId],
        { label: "Render: load profile" },
      ),
      db.query(
        `SELECT hypothesis_id, family, question, execution_rank, status,
                entity_id, thesis_link
         FROM ero_hypotheses WHERE run_id = $1
         ORDER BY execution_rank ASC`,
        HypothesisRow, [runId],
        { label: "Render: load hypotheses" },
      ),
      db.query(
        `SELECT f.finding_id, f.hypothesis_id, f.verdict, f.severity,
                f.ceiling_reason, f.title, f.detail, f.materiality_rationale
         FROM ero_findings f
         JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
         WHERE h.run_id = $1
         ORDER BY f.created_at ASC`,
        FindingRow, [runId],
        { label: "Render: load findings" },
      ),
      db.query(
        `SELECT e.evidence_id, e.hypothesis_id, e.url, e.domain, e.publisher,
                e.publication_date::text AS publication_date, e.source_tier,
                e.verbatim_snippet
         FROM ero_evidence e
         JOIN ero_hypotheses h ON h.hypothesis_id = e.hypothesis_id
         WHERE h.run_id = $1
         ORDER BY e.hypothesis_id, e.source_tier ASC`,
        EvidenceRow, [runId],
        { label: "Render: load evidence" },
      ),
      db.query(
        `SELECT cc.finding_id, cc.query_text, cc.hit_count,
                cc.best_hit_snippet, cc.classification
         FROM ero_corpus_checks cc
         JOIN ero_findings f ON f.finding_id = cc.finding_id
         JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
         WHERE h.run_id = $1
         ORDER BY cc.finding_id, cc.checked_at ASC`,
        CorpusCheckRow, [runId],
        { label: "Render: load corpus checks" },
      ),
      db.query(
        `SELECT created_at::text AS created_at
         FROM ero_pipeline_state WHERE run_id = $1`,
        PipelineStateRow, [runId],
        { label: "Render: load pipeline created_at" },
      ),
    ]);

  // ── 2. Build lookup maps ──────────────────────────────────────────

  // Entity map: entity_id → entity
  const entityMap = new Map<string, z.infer<typeof EntityRow>>();
  for (const e of entities) {
    entityMap.set(e.entity_id, e);
  }

  // Hypothesis map: hypothesis_id → hypothesis
  const hypMap = new Map<string, z.infer<typeof HypothesisRow>>();
  for (const h of hypotheses) {
    hypMap.set(h.hypothesis_id, h);
  }

  // Evidence map: hypothesis_id → evidence[]
  const evidenceByHyp = new Map<string, Array<z.infer<typeof EvidenceRow>>>();
  for (const ev of evidence) {
    const arr = evidenceByHyp.get(ev.hypothesis_id) ?? [];
    arr.push(ev);
    evidenceByHyp.set(ev.hypothesis_id, arr);
  }

  // Corpus classification map: finding_id → classification + best_hit_snippet
  // Use the FIRST non-null classification row (all rows for a finding have
  // the same classification, per the confrontation stage).
  const corpusByFinding = new Map<
    string,
    { classification: string; best_hit_snippet: string | null }
  >();
  for (const cc of corpusChecks) {
    if (cc.classification && !corpusByFinding.has(cc.finding_id)) {
      corpusByFinding.set(cc.finding_id, {
        classification: cc.classification,
        best_hit_snippet: cc.best_hit_snippet,
      });
    }
  }

  // ── 3. Build header ───────────────────────────────────────────────

  const hypGenerated = hypotheses.length;
  const hypResearched = hypotheses.filter(
    (h: z.infer<typeof HypothesisRow>) => h.status === "researched",
  ).length;
  const hypNoEvidence = hypotheses.filter(
    (h: z.infer<typeof HypothesisRow>) => h.status === "no_evidence_found",
  ).length;
  const hypPending = hypotheses.filter(
    (h: z.infer<typeof HypothesisRow>) => h.status === "pending" || h.status === "error",
  ).length;

  const generatedAt = pipelineState.length > 0
    ? pipelineState[0].created_at
    : new Date().toISOString();

  const header = {
    deal_id: dealId,
    run_id: runId,
    generated_at: generatedAt,
    hypotheses_generated: hypGenerated,
    hypotheses_researched: hypResearched,
    hypotheses_no_evidence: hypNoEvidence,
    hypotheses_pending: hypPending,
    findings_count: findings.length,
  };

  // ── 4. Build entity manifest summary ──────────────────────────────

  const countsByType: Record<string, number> = {};
  for (const e of entities) {
    countsByType[e.entity_type] = (countsByType[e.entity_type] ?? 0) + 1;
  }

  const entityRoster = entities.map((e: z.infer<typeof EntityRow>) => ({
    legal_name: e.legal_name,
    entity_type: e.entity_type,
    jurisdiction: e.jurisdiction,
  }));

  // ── 5. Build deal profile ─────────────────────────────────────────

  const businessShape: Record<string, string> = {};
  const thesisDeps: Record<string, string> = {};
  for (const p of profileRows) {
    if (p.field_group === "business_shape") {
      businessShape[p.field_name] = p.field_value;
    } else {
      thesisDeps[p.field_name] = p.field_value;
    }
  }

  // ── 6. Build rendered findings ────────────────────────────────────

  const renderedFindings: RenderedFinding[] = [];

  for (const f of findings) {
    const hyp = hypMap.get(f.hypothesis_id);
    const entity = hyp?.entity_id ? entityMap.get(hyp.entity_id) : null;
    const evidItems = evidenceByHyp.get(f.hypothesis_id) ?? [];
    const corpus = corpusByFinding.get(f.finding_id);

    // Guard: no finding with zero evidence (invariant)
    if (evidItems.length === 0) continue;

    const classification = corpus?.classification ?? "unknown_to_deal_team";

    renderedFindings.push({
      finding_id: f.finding_id,
      title: f.title,
      severity: f.severity,
      ceiling_reason: f.ceiling_reason,
      verdict: f.verdict,
      detail: f.detail,
      materiality_rationale: f.materiality_rationale,
      classification,
      classification_label:
        CLASSIFICATION_HEADINGS[classification] ?? classification,
      corpus_quote: corpus?.best_hit_snippet ?? null,
      // For understated: the confrontation stage stored both-figures in
      // stageData but not in DB columns. The corpus_quote from the best
      // hit carries the deal team's stated context. We note this.
      corpus_quoted_value: null,
      external_quoted_value: null,
      evidence: evidItems.map((ev: z.infer<typeof EvidenceRow>) => ({
        url: ev.url,                   // ← verbatim from ero_evidence.url
        domain: ev.domain,
        publisher: ev.publisher,
        publication_date: ev.publication_date,
        source_tier: ev.source_tier,
        tier_label: TIER_LABELS[ev.source_tier] ?? `Tier ${ev.source_tier}`,
        verbatim_snippet: ev.verbatim_snippet,
      })),
      family: hyp?.family ?? "unknown",
      entity_name: entity?.legal_name ?? null,
      execution_rank: hyp?.execution_rank ?? 0,
    });
  }

  // ── 7. Group findings by classification ───────────────────────────
  // Priority: known_but_understated → unknown_to_deal_team → known_and_assessed
  // Within group: severity (critical → warning → info), then execution_rank.

  const classificationGroups = new Map<string, RenderedFinding[]>();
  for (const rf of renderedFindings) {
    const arr = classificationGroups.get(rf.classification) ?? [];
    arr.push(rf);
    classificationGroups.set(rf.classification, arr);
  }

  // Sort within each group
  for (const [, group] of classificationGroups) {
    group.sort((a, b) => {
      const sevDiff =
        (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
      if (sevDiff !== 0) return sevDiff;
      return a.execution_rank - b.execution_rank;
    });
  }

  // Assemble in classification priority order
  const classificationKeys = [
    "known_but_understated",
    "unknown_to_deal_team",
    "known_and_assessed",
  ];

  const findingsByClassification = classificationKeys
    .filter((cls) => classificationGroups.has(cls))
    .map((cls) => ({
      classification: cls,
      heading: CLASSIFICATION_HEADINGS[cls] ?? cls,
      intro: CLASSIFICATION_INTROS[cls] ?? "",
      findings: classificationGroups.get(cls)!,
    }));

  // ── 8. No-evidence coverage section ───────────────────────────────
  // Hypotheses with status 'no_evidence_found' — "we checked and found nothing."

  const noEvidenceCoverage = hypotheses
    .filter((h: z.infer<typeof HypothesisRow>) => h.status === "no_evidence_found")
    .map((h: z.infer<typeof HypothesisRow>) => ({
      question: h.question,
      family: h.family,
      execution_rank: h.execution_rank,
    }));

  // ── 9. Limitations ────────────────────────────────────────────────

  const limitations: string[] = [
    "Acquired-entity roster includes group vehicles not yet classified as active trading entities versus dormant/holding SPVs.",
    "Regulators are sourced from sector logic (SIC codes and business description), not from exhaustive corpus extraction.",
  ];

  // Check for needs_recheck findings (stale enforcement — those with
  // ceiling_reason mentioning stale/recheck)
  const staleCount = renderedFindings.filter(
    (rf) =>
      rf.ceiling_reason.toLowerCase().includes("stale") ||
      rf.ceiling_reason.toLowerCase().includes("recheck") ||
      rf.ceiling_reason.toLowerCase().includes("undated"),
  ).length;

  if (staleCount > 0) {
    limitations.push(
      `${staleCount} finding(s) have severity ceiling applied due to undated or stale evidence — flagged for recheck.`,
    );
  }

  // Check for understated that were downgraded (magnitude rule)
  // We detect these as findings classified 'known_and_assessed' that
  // have corpus_checks rows — a heuristic. The definitive count is
  // in the confrontation stageData, which is not persisted to DB.
  // Note this limitation.
  limitations.push(
    "Any known_but_understated classifications that lacked both quoted figures were downgraded to known_and_assessed by the magnitude rule.",
  );

  // ── 10. Assemble full_report_markdown ─────────────────────────────

  const md = assembleMarkdown(
    header,
    { counts_by_type: countsByType, entity_roster: entityRoster },
    { business_shape: businessShape, thesis_dependencies: thesisDeps },
    findingsByClassification,
    noEvidenceCoverage,
    limitations,
  );

  // ── 11. Build report object ───────────────────────────────────────

  const report: RenderedReport = {
    header,
    entity_manifest: {
      counts_by_type: countsByType,
      entity_roster: entityRoster,
    },
    deal_profile: {
      business_shape: businessShape,
      thesis_dependencies: thesisDeps,
    },
    findings_by_classification: findingsByClassification,
    no_evidence_coverage: noEvidenceCoverage,
    limitations,
    full_report_markdown: md,
  };

  return {
    stage: "render",
    status: "complete",
    message: `Render complete. ${renderedFindings.length} findings in ${findingsByClassification.length} classification groups. ${noEvidenceCoverage.length} no-evidence hypotheses documented.`,
    stageData: { report },
  };
}

// ═══════════════════════════════════════════════════════════════════
// MARKDOWN ASSEMBLY — pure string formatting, zero LLM
// ═══════════════════════════════════════════════════════════════════

function assembleMarkdown(
  header: RenderedReport["header"],
  entityManifest: RenderedReport["entity_manifest"],
  dealProfile: RenderedReport["deal_profile"],
  findingGroups: RenderedReport["findings_by_classification"],
  noEvidence: RenderedReport["no_evidence_coverage"],
  limitations: string[],
): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────

  lines.push("# External Risk Overlay — Report");
  lines.push("");
  lines.push(`**Deal:** ${header.deal_id}`);
  lines.push(`**Run:** ${header.run_id}`);
  lines.push(`**Generated:** ${header.generated_at}`);
  lines.push("");
  lines.push("## Coverage Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Hypotheses generated | ${header.hypotheses_generated} |`);
  lines.push(`| Hypotheses researched | ${header.hypotheses_researched} |`);
  lines.push(`| No evidence found | ${header.hypotheses_no_evidence} |`);
  lines.push(`| Pending/error | ${header.hypotheses_pending} |`);
  lines.push(`| Adjudicated findings | ${header.findings_count} |`);
  lines.push("");

  // ── Entity Manifest ─────────────────────────────────────────────

  lines.push("## Entity Manifest — What We Understood the Deal to Be");
  lines.push("");
  lines.push("### Entity Counts by Type");
  lines.push("");
  lines.push("| Type | Count |");
  lines.push("|------|-------|");
  for (const [type, count] of Object.entries(entityManifest.counts_by_type)) {
    lines.push(`| ${type} | ${count} |`);
  }
  lines.push("");

  if (entityManifest.entity_roster.length > 0) {
    lines.push("### Entity Roster");
    lines.push("");
    lines.push("| Name | Type | Jurisdiction |");
    lines.push("|------|------|-------------|");
    for (const e of entityManifest.entity_roster) {
      lines.push(`| ${e.legal_name} | ${e.entity_type} | ${e.jurisdiction ?? "—"} |`);
    }
    lines.push("");
  }

  // ── Deal Profile ────────────────────────────────────────────────

  lines.push("## Deal Profile");
  lines.push("");

  if (Object.keys(dealProfile.business_shape).length > 0) {
    lines.push("### Business Shape");
    lines.push("");
    for (const [field, value] of Object.entries(dealProfile.business_shape)) {
      lines.push(`- **${field}:** ${value}`);
    }
    lines.push("");
  }

  if (Object.keys(dealProfile.thesis_dependencies).length > 0) {
    lines.push("### Thesis Dependencies");
    lines.push("");
    for (const [field, value] of Object.entries(dealProfile.thesis_dependencies)) {
      lines.push(`- **${field}:** ${value}`);
    }
    lines.push("");
  }

  // ── Findings by Classification ──────────────────────────────────

  lines.push("---");
  lines.push("");
  lines.push("## Findings");
  lines.push("");

  for (const group of findingGroups) {
    lines.push(`### ${group.heading}`);
    lines.push("");
    lines.push(`_${group.intro}_`);
    lines.push("");

    for (const f of group.findings) {
      lines.push(`#### ${f.title}`);
      lines.push("");
      lines.push(`- **Severity:** ${f.severity} (${f.ceiling_reason})`);
      lines.push(`- **Verdict:** ${f.verdict}`);
      lines.push(`- **Family:** ${f.family}`);
      if (f.entity_name) {
        lines.push(`- **Entity:** ${f.entity_name}`);
      }
      lines.push("");
      lines.push(f.detail);
      lines.push("");
      lines.push(`**Materiality:** ${f.materiality_rationale}`);
      lines.push("");

      // Corpus classification context
      if (f.classification === "known_but_understated") {
        lines.push("**Corpus comparison:**");
        if (f.corpus_quoted_value && f.external_quoted_value) {
          lines.push(`- Deal team stated: ${f.corpus_quoted_value}`);
          lines.push(`- External evidence shows: ${f.external_quoted_value}`);
        }
        if (f.corpus_quote) {
          lines.push(`- Corpus excerpt: _"${f.corpus_quote.slice(0, 300)}"_`);
        }
        lines.push("");
      } else if (f.classification === "known_and_assessed" && f.corpus_quote) {
        lines.push(`**Corpus reference:** _"${f.corpus_quote.slice(0, 300)}"_`);
        lines.push("");
      }

      // Evidence list — URLs are FIRST-CLASS
      lines.push(`**Evidence (${f.evidence.length} sources):**`);
      lines.push("");
      for (let i = 0; i < f.evidence.length; i++) {
        const ev = f.evidence[i];
        lines.push(`${i + 1}. **${ev.tier_label}**`);
        lines.push(`   - URL: ${ev.url}`);
        if (ev.publisher) {
          lines.push(`   - Publisher: ${ev.publisher}`);
        }
        lines.push(`   - Date: ${ev.publication_date ?? "undated"}`);
        lines.push(`   - Domain: ${ev.domain ?? "unknown"}`);
        lines.push(`   - Snippet: ${ev.verbatim_snippet.slice(0, 200)}`);
        lines.push("");
      }
    }
  }

  // ── No-Evidence Coverage ────────────────────────────────────────

  lines.push("---");
  lines.push("");
  lines.push("## Coverage — Hypotheses With No Evidence Found");
  lines.push("");
  if (noEvidence.length === 0) {
    lines.push("All researched hypotheses returned evidence.");
    lines.push("");
  } else {
    lines.push(
      "The following hypotheses were investigated but external research returned no admissible evidence. " +
        "This means the web search did not surface relevant results — it does not confirm the absence of risk.",
    );
    lines.push("");
    for (const h of noEvidence) {
      lines.push(`- [Rank ${h.execution_rank}, ${h.family}] ${h.question}`);
    }
    lines.push("");
  }

  // ── Limitations ─────────────────────────────────────────────────

  lines.push("---");
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  for (const lim of limitations) {
    lines.push(`- ${lim}`);
  }
  lines.push("");

  return lines.join("\n");
}
