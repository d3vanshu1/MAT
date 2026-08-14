/**
 * P9 — OA Mechanical Render
 *
 * ZERO LLM CALLS. Pure string assembly.
 *
 * Renders the final Omission Audit report from oa_findings data.
 * All text is deterministically constructed from structured data — no model
 * is invoked at any point during rendering.
 *
 * WHY: the prior architecture delegated rendering to a model, which leaked
 * internal field names into reader-facing prose (e.g. "Confidence: verified_absent").
 * This file ensures no internal identifier can reach the output.
 *
 * Report: R1 (zero LLM calls), R2 (no B2 fields in output), R3 (sample render)
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { SEEDED_TOPICS, OBLIGATION_CHECKLIST_VERSION } from "./oa-taxonomy.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// B2 — gap_kind to reader language mapping
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

// ---------------------------------------------------------------------------
// Topic label lookup
// ---------------------------------------------------------------------------

const TOPIC_LABEL_MAP: Record<string, string> = {};
SEEDED_TOPICS.forEach((t) => { TOPIC_LABEL_MAP[t.topic_id] = t.topic_label; });

function getTopicLabel(topicId: string): string {
  return TOPIC_LABEL_MAP[topicId] ?? topicId.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const FindingRow = z.object({
  finding_id: z.string(),
  topic_id: z.string(),
  gap_kind: z.string(),
  materiality_tier: z.coerce.number(),
  materiality_basis: z.string().nullable(),
  absence_basis: z.string().nullable(),
  subject_evidence: z.any(),
  reference_evidence: z.any(),
  narrative: z.string().nullable(),
});

const DealRow = z.object({
  deal_name: z.string(),
});

const DocumentCoverageRow = z.object({
  file_name: z.string(),
  fact_count: z.coerce.number(),
});

const FailedChunkRow = z.object({
  document_name: z.string(),
  failed_count: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Rendering functions
// ---------------------------------------------------------------------------

function renderEvidenceBlock(evidence: any[]): string {
  if (!evidence || evidence.length === 0) return "  *(no evidence cited)*\n";

  return evidence.map((e: any) => {
    const parts: string[] = [];
    if (e?.predicate) parts.push(e.predicate);
    if (e?.value) parts.push(`= ${e.value}`);
    if (e?.scope_qualifier && e.scope_qualifier !== "NONE_STATED" && e.scope_qualifier !== "UNSCOPED_BY_NATURE") {
      parts.push(`(${e.scope_qualifier})`);
    }
    const docName = e?.document_name ?? "Unknown document";
    return `  - ${docName}: ${parts.join(" ") || "(fact reference)"}`;
  }).join("\n") + "\n";
}

function renderAdviserRating(referenceEvidence: any[]): string {
  if (!referenceEvidence || referenceEvidence.length === 0) return "";

  const withSeverity = referenceEvidence.filter((e: any) => e?.adviser_severity);
  if (withSeverity.length === 0) return "";

  const ratings = withSeverity.map((e: any) => {
    const parts: string[] = [];
    if (e.adviser_severity) parts.push(`severity: ${e.adviser_severity}`);
    if (e.adviser_disposition) parts.push(`disposition: ${e.adviser_disposition}`);
    return parts.join(", ");
  });

  // Deduplicate
  const unique = [...new Set(ratings)];
  return `**Adviser rating:** ${unique.join("; ")}\n`;
}

function renderFinding(finding: z.infer<typeof FindingRow>, compact: boolean): string {
  const topicLabel = getTopicLabel(finding.topic_id);
  const gapLabel = renderGapKind(finding.gap_kind);

  if (compact) {
    // Tier 3: compact rendering
    const basis = finding.materiality_basis
      ? finding.materiality_basis.replace(/\[quote_validation_failed\]/g, "").trim()
      : "";
    return `- **${topicLabel}** — ${gapLabel}${basis ? ` | Basis: ${basis}` : ""}\n`;
  }

  // Full rendering for Tier 1 and 2
  const lines: string[] = [];
  lines.push(`### ${topicLabel}\n`);
  lines.push(`**Gap:** ${gapLabel}\n`);

  if (finding.narrative) {
    lines.push(`${finding.narrative}\n`);
  } else {
    lines.push(`*Narrative withheld — quote validation failed.*\n`);
  }

  lines.push(`**Evidence:**\n`);
  lines.push(renderEvidenceBlock([
    ...(finding.subject_evidence ?? []),
    ...(finding.reference_evidence ?? []),
  ]));

  const adviserRating = renderAdviserRating(finding.reference_evidence);
  if (adviserRating) lines.push(adviserRating);

  if (finding.materiality_basis) {
    const cleanBasis = finding.materiality_basis.replace(/\[quote_validation_failed\]/g, "").trim();
    if (cleanBasis) lines.push(`**Basis:** ${cleanBasis}\n`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// B3 — Stated Limitations section
// ---------------------------------------------------------------------------

interface LimitationsData {
  zeroFactDocuments: string[];
  failedChunks: Array<{ document_name: string; failed_count: number }>;
  unprobedTopics: string[];
  withheldNarratives: string[];
  checklistVersion: string;
}

function renderLimitations(data: LimitationsData): string {
  const lines: string[] = [];
  lines.push(`## Coverage Notes\n`);
  lines.push(`This section discloses what this audit did NOT cover.\n`);

  // Documents with zero facts
  if (data.zeroFactDocuments.length > 0) {
    lines.push(`**Documents contributing no analysable facts:**\n`);
    data.zeroFactDocuments.forEach((d) => lines.push(`- ${d}`));
    lines.push("");
  } else {
    lines.push(`**Documents contributing no analysable facts:** None — all documents produced facts.\n`);
  }

  // Failed chunks
  if (data.failedChunks.length > 0) {
    lines.push(`**Chunks that failed extraction:**\n`);
    data.failedChunks.forEach((c) => lines.push(`- ${c.document_name}: ${c.failed_count} chunk(s) failed`));
    lines.push("");
  } else {
    lines.push(`**Chunks that failed extraction:** None.\n`);
  }

  // Unprobed topics
  if (data.unprobedTopics.length > 0) {
    lines.push(`**Topics where the absence probe did not run:**\n`);
    data.unprobedTopics.forEach((t) => lines.push(`- ${getTopicLabel(t)}`));
    lines.push("");
  } else {
    lines.push(`**Topics where the absence probe did not run:** None — all absent topics were probed.\n`);
  }

  // Withheld narratives
  if (data.withheldNarratives.length > 0) {
    lines.push(`**Findings where narrative was withheld (quote validation failed):**\n`);
    data.withheldNarratives.forEach((t) => lines.push(`- ${getTopicLabel(t)}`));
    lines.push("");
  } else {
    lines.push(`**Findings with withheld narratives:** None.\n`);
  }

  lines.push(`**Obligation checklist version:** ${data.checklistVersion}\n`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full report assembly
// ---------------------------------------------------------------------------

interface RenderInput {
  dealName: string;
  runId: string;
  generatedAt: string;
  findings: Array<z.infer<typeof FindingRow>>;
  limitations: LimitationsData;
}

function assembleReport(input: RenderInput): string {
  const { dealName, runId, generatedAt, findings, limitations } = input;

  const tier1 = findings.filter((f) => f.materiality_tier === 1);
  const tier2 = findings.filter((f) => f.materiality_tier === 2);
  const tier3 = findings.filter((f) => f.materiality_tier === 3);

  // Count topics evaluated vs silent
  const topicsWithFindings = new Set(findings.map((f) => f.topic_id));
  const topicsEvaluated = SEEDED_TOPICS.filter((t) =>
    t.obligation_class !== "not_memo_relevant"
  ).length;
  const topicsSilent = topicsEvaluated - topicsWithFindings.size;

  const sections: string[] = [];

  // Header
  sections.push(`# Omission Audit — ${dealName}\n`);
  sections.push(`| Field | Value |`);
  sections.push(`|-------|-------|`);
  sections.push(`| Run ID | ${runId} |`);
  sections.push(`| Checklist version | ${limitations.checklistVersion} |`);
  sections.push(`| Generated | ${generatedAt} |`);
  sections.push("");

  // Summary
  sections.push(`## Summary\n`);
  sections.push(`| Tier | Count |`);
  sections.push(`|------|-------|`);
  sections.push(`| Tier 1 — Potentially Deal-Relevant | ${tier1.length} |`);
  sections.push(`| Tier 2 — Worth a Condition or Follow-Up | ${tier2.length} |`);
  sections.push(`| Tier 3 — Noted | ${tier3.length} |`);
  sections.push(`| **Total findings** | **${findings.length}** |`);
  sections.push("");
  sections.push(`Topics evaluated: ${topicsEvaluated} | Topics with findings: ${topicsWithFindings.size} | Topics silent: ${topicsSilent}\n`);

  // Tier 1
  sections.push(`## Tier 1 — Potentially Deal-Relevant\n`);
  if (tier1.length === 0) {
    sections.push(`No Tier 1 findings.\n`);
  } else {
    tier1.forEach((f) => sections.push(renderFinding(f, false)));
  }

  // Tier 2
  sections.push(`## Tier 2 — Worth a Condition or Follow-Up\n`);
  if (tier2.length === 0) {
    sections.push(`No Tier 2 findings.\n`);
  } else {
    tier2.forEach((f) => sections.push(renderFinding(f, false)));
  }

  // Tier 3
  sections.push(`## Tier 3 — Noted\n`);
  if (tier3.length === 0) {
    sections.push(`No Tier 3 findings.\n`);
  } else {
    tier3.forEach((f) => sections.push(renderFinding(f, true)));
  }

  // Limitations (B3)
  sections.push(renderLimitations(limitations));

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaRender",
  description: "Renders the final Omission Audit report from structured findings (zero LLM calls)",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    dealId: z.string(),
    runId: z.string(),
    sample: z.boolean().optional().default(false),
  }),
  output: z.object({
    report_markdown: z.string(),
    meta: z.object({
      llm_calls: z.number(),
      b2_fields_in_output: z.boolean(),
      findings_rendered: z.number(),
      tier_counts: z.object({
        tier1: z.number(),
        tier2: z.number(),
        tier3: z.number(),
      }),
    }),
  }),

  async run(ctx, { dealId, runId, sample }) {
    const { db } = ctx.integrations;

    // ─── Sample mode: hand-constructed findings for B4 verification ──────
    if (sample) {
      const sampleReport = renderSampleReport();
      return sampleReport;
    }

    // ─── Load deal name ──────────────────────────────────────────────────
    const dealRows = await db.query(
      `SELECT deal_name FROM deals WHERE id = $1`,
      DealRow,
      [dealId],
      { label: "Load deal name" }
    );
    const dealName = dealRows[0]?.deal_name ?? "Unknown Deal";

    // ─── Load findings ───────────────────────────────────────────────────
    const findings = await db.query(
      `SELECT finding_id, topic_id, gap_kind, materiality_tier, materiality_basis,
              absence_basis, subject_evidence, reference_evidence, narrative
       FROM oa_findings
       WHERE run_id = $1 AND deal_id = $2
       ORDER BY materiality_tier ASC, topic_id ASC`,
      FindingRow,
      [runId, dealId],
      { label: "Load findings for render" }
    );

    // ─── Load limitations data ───────────────────────────────────────────

    // Documents with zero facts
    const docCoverage = await db.query(
      `SELECT d.file_name, COALESCE(fc.fact_count, 0) AS fact_count
       FROM documents d
       LEFT JOIN (
         SELECT document_id, COUNT(*) AS fact_count
         FROM oa_facts WHERE deal_id = $1
         GROUP BY document_id
       ) fc ON fc.document_id = d.id
       WHERE d.deal_id = $1
       ORDER BY d.file_name`,
      DocumentCoverageRow,
      [dealId],
      { label: "Document coverage for limitations" }
    );
    const zeroFactDocuments = docCoverage
      .filter((d) => d.fact_count === 0)
      .map((d) => d.file_name);

    // Failed chunks
    const failedChunks = await db.query(
      `SELECT f.document_name, COUNT(*) AS failed_count
       FROM oa_stage_checkpoints c
       JOIN oa_facts f ON f.deal_id = $1
       WHERE c.run_id = $2 AND c.stage = 'extraction' AND c.status = 'failed'
         AND c.unit_key LIKE f.document_id || '%'
       GROUP BY f.document_name
       LIMIT 50`,
      FailedChunkRow,
      [dealId, runId],
      { label: "Failed chunks for limitations" }
    );

    // Topics where absence probe did not run
    const unprobedTopics = await db.query(
      `SELECT t.topic_id FROM oa_topics t
       WHERE t.run_id = $1 AND t.subject_coverage = 'absent'
         AND NOT EXISTS (
           SELECT 1 FROM oa_stage_checkpoints c
           WHERE c.run_id = $1 AND c.stage = 'absence_probe' AND c.unit_key = t.topic_id
         )`,
      z.object({ topic_id: z.string() }),
      [runId],
      { label: "Unprobed absent topics" }
    );

    // Findings with withheld narratives
    const withheldNarratives = findings
      .filter((f) => f.narrative === null && f.materiality_basis?.includes("quote_validation_failed"))
      .map((f) => f.topic_id);

    // ─── Assemble report ─────────────────────────────────────────────────
    const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

    const reportMarkdown = assembleReport({
      dealName,
      runId,
      generatedAt,
      findings,
      limitations: {
        zeroFactDocuments,
        failedChunks: failedChunks as any,
        unprobedTopics: unprobedTopics.map((t) => t.topic_id),
        withheldNarratives,
        checklistVersion: OBLIGATION_CHECKLIST_VERSION,
      },
    });

    // ─── B2 verification: assert no forbidden fields leaked ──────────────
    const FORBIDDEN_FIELDS = [
      "absence_basis", "retrieval_probe", "fact_id", "finding_id",
      "topic_id", "run_id",
    ];
    // Check body (skip the metadata header which intentionally shows run_id)
    const bodyStart = reportMarkdown.indexOf("## Summary");
    const bodyText = bodyStart >= 0 ? reportMarkdown.slice(bodyStart) : reportMarkdown;
    const b2Leaked = FORBIDDEN_FIELDS.some((field) => bodyText.includes(field));

    // ─── R1: Confirm zero LLM calls ─────────────────────────────────────
    // This file has NO import of anthropic and makes no AI calls.
    // The meta.llm_calls field is always 0.

    return {
      report_markdown: reportMarkdown,
      meta: {
        llm_calls: 0,
        b2_fields_in_output: b2Leaked,
        findings_rendered: findings.length,
        tier_counts: {
          tier1: findings.filter((f) => f.materiality_tier === 1).length,
          tier2: findings.filter((f) => f.materiality_tier === 2).length,
          tier3: findings.filter((f) => f.materiality_tier === 3).length,
        },
      },
    };
  },
});

// ---------------------------------------------------------------------------
// B4 — Sample report from hand-constructed findings
// ---------------------------------------------------------------------------

function renderSampleReport() {
  const sampleFindings: Array<z.infer<typeof FindingRow>> = [
    {
      finding_id: "sample-t1-001",
      topic_id: "revenue-quality.churn",
      gap_kind: "unreconciled_divergence",
      materiality_tier: 1,
      materiality_basis: "Churn figures reported in 3rd IC memo (5%) diverge from Vendor FDD (6.9% FY25) without reconciliation. At £55m EBITDA, 1.9ppts = ~£1m GP at risk.",
      absence_basis: null,
      subject_evidence: [
        { fact_id: "s1", predicate: "Annual churn rate", value: "5%", scope_qualifier: "FY25A, customers spending >£200/month", document_name: "SCG - 3rd IC Memo vS.pdf" },
      ],
      reference_evidence: [
        { fact_id: "r1", predicate: "Churn as % of opening ARR", value: "(6.9%)", scope_qualifier: "FY25", document_name: "SCG - Vendor FDD Report.pdf", adviser_severity: "medium", adviser_disposition: "noted" },
        { fact_id: "r2", predicate: "Churn as % of opening ARR", value: "(7.5%)", scope_qualifier: "FY24", document_name: "SCG - Vendor FDD Report.pdf", adviser_severity: "medium", adviser_disposition: "noted" },
      ],
      narrative: "The Vendor Financial Due Diligence report records total customer churn at 6.5% (FY23), 7.5% (FY24), and 6.9% (FY25) as a percentage of opening ARR. The 3rd IC Memo reports annual recurring revenue hard churn of 5%, but this figure applies only to customers spending more than £200 per month — a subset representing approximately 20% of the customer base. The broader churn figure, which includes all customer segments, is materially higher and shows a deteriorating trend that is not addressed in the memo narrative.",
    },
    {
      finding_id: "sample-t2-001",
      topic_id: "risk.regulatory",
      gap_kind: "not_disclosed",
      materiality_tier: 2,
      materiality_basis: "Regulatory risk around ISDN switch-off discussed extensively in FDD (£14m revenue at risk) but absent from IC memo. Capped at Tier 2 per fail-closed rule (probe confirmed absence).",
      absence_basis: "no_subject_facts_and_probe_null",
      subject_evidence: [],
      reference_evidence: [
        { fact_id: "r3", predicate: "ISDN revenue at risk from switch-off", value: "£14m", scope_qualifier: "FY25-FY27", document_name: "SCG - Vendor FDD Report.pdf", adviser_severity: "high", adviser_disposition: "flagged" },
      ],
      narrative: "The Vendor FDD dedicates a full section to regulatory risk arising from the PSTN/ISDN switch-off programme, quantifying £14m of revenue directly exposed to forced migration by January 2027. The IC memos do not address this risk. The absence probe confirmed that no text in any IC memo discusses ISDN migration, switch-off timelines, or legacy platform regulatory risk.",
    },
    {
      finding_id: "sample-t3-001",
      topic_id: "capex.requirements",
      gap_kind: "unquantified",
      materiality_tier: 3,
      materiality_basis: "Capex discussed qualitatively in memo; FDD provides specific £2.1m figure not carried forward.",
      absence_basis: null,
      subject_evidence: [
        { fact_id: "s2", predicate: "Capital expenditure requirements", value: null, scope_qualifier: "NONE_STATED", document_name: "SCG - 2nd IC Memo vS.pdf" },
      ],
      reference_evidence: [
        { fact_id: "r4", predicate: "Annual capex requirement", value: "£2.1m", scope_qualifier: "FY25 budget", document_name: "SCG - Vendor FDD Report.pdf", adviser_severity: null, adviser_disposition: null },
      ],
      narrative: null,
    },
    {
      finding_id: "sample-t3-002",
      topic_id: "supplier.concentration",
      gap_kind: "scope_mismatch",
      materiality_tier: 3,
      materiality_basis: "Memo discusses top supplier only; FDD identifies concentration across top 5.",
      absence_basis: null,
      subject_evidence: [
        { fact_id: "s3", predicate: "Primary supplier dependency", value: "Gamma (60% of margin)", scope_qualifier: "current state", document_name: "SCG - 3rd IC Memo vS.pdf" },
      ],
      reference_evidence: [
        { fact_id: "r5", predicate: "Top 5 supplier concentration", value: "87% of direct costs", scope_qualifier: "FY25", document_name: "SCG - Vendor FDD Report.pdf", adviser_severity: null, adviser_disposition: null },
      ],
      narrative: null,
    },
  ];

  const sampleLimitations: LimitationsData = {
    zeroFactDocuments: ["SCG - Financial Model v3.2.xlsx", "SCG - Financial Model (Sensitivity).xlsx"],
    failedChunks: [{ document_name: "2026-06-15 SCG - 3rd IC Memo vS.pdf", failed_count: 3 }],
    unprobedTopics: [],
    withheldNarratives: ["capex.requirements"],
    checklistVersion: OBLIGATION_CHECKLIST_VERSION,
  };

  const reportMarkdown = assembleReport({
    dealName: "Project Saint (SCG)",
    runId: "sample-run-id",
    generatedAt: "2026-08-14 16:30:00 UTC",
    findings: sampleFindings,
    limitations: sampleLimitations,
  });

  // B2 verification
  const FORBIDDEN_FIELDS = ["absence_basis", "retrieval_probe", "fact_id", "finding_id", "topic_id", "run_id"];
  const bodyStart = reportMarkdown.indexOf("## Summary");
  const bodyText = bodyStart >= 0 ? reportMarkdown.slice(bodyStart) : reportMarkdown;
  const b2Leaked = FORBIDDEN_FIELDS.some((field) => bodyText.includes(field));

  return {
    report_markdown: reportMarkdown,
    meta: {
      llm_calls: 0,
      b2_fields_in_output: b2Leaked,
      findings_rendered: sampleFindings.length,
      tier_counts: {
        tier1: sampleFindings.filter((f) => f.materiality_tier === 1).length,
        tier2: sampleFindings.filter((f) => f.materiality_tier === 2).length,
        tier3: sampleFindings.filter((f) => f.materiality_tier === 3).length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------
export { assembleReport, renderGapKind, renderFinding, renderLimitations, validateNoBannedFields };

function validateNoBannedFields(markdown: string): { clean: boolean; leaked: string[] } {
  const FORBIDDEN = ["absence_basis", "retrieval_probe", "fact_id", "finding_id", "topic_id", "run_id"];
  const bodyStart = markdown.indexOf("## Summary");
  const body = bodyStart >= 0 ? markdown.slice(bodyStart) : markdown;
  const leaked = FORBIDDEN.filter((f) => body.includes(f));
  return { clean: leaked.length === 0, leaked };
}
