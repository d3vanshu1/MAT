/**
 * SRI v2 — Render Stage (final stage)
 *
 * DETERMINISTIC. ZERO LLM CALLS. Pure row-reading and string assembly.
 *
 * Assembles the Social & Reputation Intelligence report from structured
 * rows produced by stages 1–3. Claims, findings, and evidence are already
 * judged; render only arranges them.
 *
 * Report structure: claim-centric (Option A)
 *   1. Header — target profile, claim/finding counts
 *   2. Findings by severity (critical → warning → info), then verdict
 *   3. Per finding — composed display title, claim context, evidence list
 *   4. Coverage — unverifiable / not_searched claims
 *   5. Limitations — dropped evidence counts, standing caveats
 *
 * WHY NO LLM: every LLM pass over a finished finding is a chance to
 * drop a URL or soften evidence. Render reads rows and formats.
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./sri-stage-contract.js";

// ═══════════════════════════════════════════════════════════════════
// DB ROW SCHEMAS
// ═══════════════════════════════════════════════════════════════════

const ClaimRow = z.object({
  claim_id: z.string(),
  claim_text: z.string(),
  claim_type: z.string(),
  subject_entity: z.string().nullable(),
  attribution: z.string().nullable(),
  thesis_dependence: z.string().nullable(),
  locator: z.string().nullable(),
  subject_unverified: z.boolean().nullable(),
  member_count: z.coerce.number().nullable(),
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

const DroppedRow = z.object({
  drop_reason: z.string(),
  cnt: z.coerce.number(),
});

const IdentityRow = z.object({
  identity_type: z.string(),
  identity_value: z.string(),
  confidence: z.string().nullable(),
});

const PipelineStateRow = z.object({
  created_at: z.string(),
});

const CountRow = z.object({ cnt: z.coerce.number() });

const StagesCompletedRow = z.object({ stages_completed: z.array(z.string()) });

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const STAGE_NAME = "render";
const LOG_PREFIX = "[SRI render]";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const VERDICT_ORDER: Record<string, number> = {
  contradicted: 0,
  mixed: 1,
  corroborated: 2,
  unverifiable: 3,
  not_searched: 4,
};

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

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

interface RenderedEvidence {
  url: string;
  platform: string;
  domain: string | null;
  publisher: string | null;
  publication_date: string | null;
  snippet: string | null;
  stance: string | null;
  entity_match: string | null;
}

interface RenderedFinding {
  finding_id: string;
  display_title: string;
  verdict: string;
  verdict_label: string;
  severity: string;
  entity_confidence: string | null;
  claim_text: string;
  claim_type: string;
  claim_type_label: string;
  subject_entity: string | null;
  attribution: string | null;
  thesis_dependence: string | null;
  locator: string | null;
  pointer_text: string | null;
  evidence: RenderedEvidence[];
  supports_count: number;
  contradicts_count: number;
}

interface RenderedReport {
  header: {
    deal_id: string;
    run_id: string;
    generated_at: string;
    total_claims: number;
    total_findings: number;
    findings_by_severity: Record<string, number>;
    findings_by_verdict: Record<string, number>;
    profile_fields: Array<{ field: string; value: string; confidence: string | null }>;
    trading_names: string[];
  };
  findings_by_severity: Array<{
    severity: string;
    findings: RenderedFinding[];
  }>;
  coverage: Array<{
    claim_text: string;
    claim_type: string;
    subject_entity: string | null;
    verdict: string;
    reason: string;
  }>;
  limitations: string[];
  full_report_markdown: string;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

export async function renderSriReport(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  const db = ctx.integrations.db;

  // ── Idempotency: check stages_completed ─────────────────────────
  const completedRows = await db.query(
    "SELECT stages_completed FROM sri_pipeline_state WHERE run_id = $1 LIMIT 1",
    StagesCompletedRow,
    [runId],
    { label: LOG_PREFIX + " check stages_completed" },
  );
  if (completedRows.length > 0 && completedRows[0].stages_completed.indexOf(STAGE_NAME) !== -1) {
    return {
      stage: STAGE_NAME,
      status: "complete",
      message: "Render already complete. Skipped.",
      stageData: { alreadyComplete: true },
    };
  }

  // ── 1. Load all SRI rows for this run ─────────────────────────────

  const [claims, findings, evidence, droppedCounts, identities, pipelineState] =
    await Promise.all([
      db.query(
        `SELECT claim_id, claim_text, claim_type, subject_entity, attribution,
                thesis_dependence, locator, subject_unverified, member_count, document_id
         FROM sri_claims WHERE run_id = $1
         ORDER BY claim_type, created_at ASC`,
        ClaimRow, [runId],
        { label: LOG_PREFIX + " load claims" },
      ),
      db.query(
        `SELECT finding_id, claim_id, verdict, severity, title, detail,
                entity_confidence, pointer_text
         FROM sri_findings WHERE run_id = $1
         ORDER BY created_at ASC`,
        FindingRow, [runId],
        { label: LOG_PREFIX + " load findings" },
      ),
      db.query(
        `SELECT e.evidence_id, e.claim_id, e.platform, e.url, e.domain,
                e.publisher, e.publication_date::text AS publication_date,
                e.snippet, e.stance, e.entity_match
         FROM sri_evidence e
         JOIN sri_claims c ON c.claim_id = e.claim_id
         WHERE c.run_id = $1
         ORDER BY e.claim_id, e.retrieved_at ASC`,
        EvidenceRow, [runId],
        { label: LOG_PREFIX + " load evidence" },
      ),
      db.query(
        `SELECT drop_reason, count(*)::int AS cnt
         FROM sri_dropped_evidence WHERE run_id = $1
         GROUP BY drop_reason ORDER BY cnt DESC`,
        DroppedRow, [runId],
        { label: LOG_PREFIX + " load dropped counts" },
      ),
      db.query(
        `SELECT identity_type, identity_value, confidence
         FROM sri_target_identity WHERE run_id = $1
           AND identity_type IN ('profile_field', 'trading_name')
         ORDER BY identity_type, identity_value`,
        IdentityRow, [runId],
        { label: LOG_PREFIX + " load identities" },
      ),
      db.query(
        `SELECT created_at::text AS created_at
         FROM sri_pipeline_state WHERE run_id = $1`,
        PipelineStateRow, [runId],
        { label: LOG_PREFIX + " load pipeline created_at" },
      ),
    ]);

  // ── 2. Build lookup maps ──────────────────────────────────────────

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

  // ── 3. Build header ───────────────────────────────────────────────

  const profileFields: Array<{ field: string; value: string; confidence: string | null }> = [];
  const tradingNames: string[] = [];
  for (const id of identities) {
    if (id.identity_type === "profile_field") {
      profileFields.push({ field: id.identity_value.split(":")[0] ?? id.identity_value, value: id.identity_value, confidence: id.confidence });
    } else if (id.identity_type === "trading_name") {
      tradingNames.push(id.identity_value);
    }
  }

  const findingsBySeverity: Record<string, number> = {};
  const findingsByVerdict: Record<string, number> = {};
  for (const f of findings) {
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1;
    findingsByVerdict[f.verdict] = (findingsByVerdict[f.verdict] ?? 0) + 1;
  }

  const generatedAt = pipelineState.length > 0
    ? pipelineState[0].created_at
    : new Date().toISOString();

  const header: RenderedReport["header"] = {
    deal_id: dealId,
    run_id: runId,
    generated_at: generatedAt,
    total_claims: claims.length,
    total_findings: findings.length,
    findings_by_severity: findingsBySeverity,
    findings_by_verdict: findingsByVerdict,
    profile_fields: profileFields,
    trading_names: tradingNames,
  };

  // ── 4. Build rendered findings ────────────────────────────────────

  const renderedFindings: RenderedFinding[] = [];

  for (const f of findings) {
    const claim = claimMap.get(f.claim_id);
    if (!claim) continue;

    const evidItems = evidenceByClaimId.get(f.claim_id) ?? [];

    // Compose a display title from claim context, not the generic title
    const displayTitle = composeDisplayTitle(claim, f, evidItems.length);

    const supportsCount = evidItems.filter((e) => e.stance === "supports").length;
    const contradictsCount = evidItems.filter((e) => e.stance === "contradicts").length;

    renderedFindings.push({
      finding_id: f.finding_id,
      display_title: displayTitle,
      verdict: f.verdict,
      verdict_label: VERDICT_LABELS[f.verdict] ?? f.verdict,
      severity: f.severity,
      entity_confidence: f.entity_confidence,
      claim_text: claim.claim_text,
      claim_type: claim.claim_type,
      claim_type_label: CLAIM_TYPE_LABELS[claim.claim_type] ?? claim.claim_type,
      subject_entity: claim.subject_entity,
      attribution: claim.attribution,
      thesis_dependence: claim.thesis_dependence,
      locator: claim.locator,
      pointer_text: f.pointer_text,
      evidence: evidItems.map((ev) => ({
        url: ev.url,
        platform: ev.platform,
        domain: ev.domain,
        publisher: ev.publisher,
        publication_date: ev.publication_date,
        snippet: ev.snippet,
        stance: ev.stance,
        entity_match: ev.entity_match,
      })),
      supports_count: supportsCount,
      contradicts_count: contradictsCount,
    });
  }

  // ── 5. Group by severity → sort by verdict within ─────────────────

  const severityGroups = new Map<string, RenderedFinding[]>();
  for (const rf of renderedFindings) {
    // Skip coverage items (not_searched / unverifiable) — they go in §7
    if (rf.verdict === "not_searched" || rf.verdict === "unverifiable") continue;
    const arr = severityGroups.get(rf.severity) ?? [];
    arr.push(rf);
    severityGroups.set(rf.severity, arr);
  }

  // Sort within each severity group by verdict priority
  for (const [, group] of severityGroups) {
    group.sort((a, b) => {
      const vDiff = (VERDICT_ORDER[a.verdict] ?? 9) - (VERDICT_ORDER[b.verdict] ?? 9);
      if (vDiff !== 0) return vDiff;
      return a.display_title.localeCompare(b.display_title);
    });
  }

  const severityKeys = ["critical", "warning", "info"];
  const findingsBySeverityArr = severityKeys
    .filter((sev) => severityGroups.has(sev))
    .map((sev) => ({
      severity: sev,
      findings: severityGroups.get(sev)!,
    }));

  // ── 6. Coverage — not_searched and unverifiable ───────────────────

  const coverage = renderedFindings
    .filter((rf) => rf.verdict === "not_searched" || rf.verdict === "unverifiable")
    .map((rf) => ({
      claim_text: rf.claim_text,
      claim_type: rf.claim_type,
      subject_entity: rf.subject_entity,
      verdict: rf.verdict,
      reason: rf.verdict === "not_searched"
        ? (rf.subject_entity ? "No platform routing for claim type" : "No subject entity on claim")
        : "No public evidence found after search",
    }));

  // ── 7. Limitations ────────────────────────────────────────────────

  const limitations: string[] = [];

  if (droppedCounts.length > 0) {
    const totalDropped = droppedCounts.reduce((sum: number, d: z.infer<typeof DroppedRow>) => sum + d.cnt, 0);
    limitations.push(
      totalDropped + " evidence item(s) were dropped during verification. " +
      "Top reasons: " + droppedCounts.slice(0, 3).map((d: z.infer<typeof DroppedRow>) => d.drop_reason + " (" + d.cnt + ")").join("; ") + ".",
    );
  }

  limitations.push(
    "Absence of public evidence is not evidence of absence. Claims marked 'unverifiable' may still be accurate — public data sources simply did not surface relevant information.",
  );

  limitations.push(
    "Entity matching is performed against trading names and profile fields extracted from deal documents. Ambiguous or unconfirmed entity matches lower the severity ceiling.",
  );

  if (coverage.filter((c) => c.verdict === "not_searched").length > 0) {
    limitations.push(
      "Some claims were not searched because they lacked a subject entity or had no platform routing for their claim type.",
    );
  }

  // ── 8. Assemble markdown ──────────────────────────────────────────

  const md = assembleMarkdown(header, findingsBySeverityArr, coverage, limitations);

  // ── 9. Write stages_completed marker ──────────────────────────────

  await db.execute(
    "UPDATE sri_pipeline_state SET stages_completed = array_append(stages_completed, $2), updated_at = now() WHERE run_id = $1 AND NOT ($2 = ANY(stages_completed))",
    [runId, STAGE_NAME],
    { label: LOG_PREFIX + " write stages_completed marker" },
  );

  // ── 10. Build report object ───────────────────────────────────────

  const report: RenderedReport = {
    header,
    findings_by_severity: findingsBySeverityArr,
    coverage,
    limitations,
    full_report_markdown: md,
  };

  const actionableCount = renderedFindings.filter(
    (rf) => rf.verdict !== "not_searched" && rf.verdict !== "unverifiable",
  ).length;

  return {
    stage: STAGE_NAME,
    status: "complete",
    message: "Render complete. " + actionableCount + " actionable findings, " + coverage.length + " coverage items.",
    stageData: { report },
  };
}

// ═══════════════════════════════════════════════════════════════════
// DISPLAY TITLE COMPOSER
// ═══════════════════════════════════════════════════════════════════

/**
 * Compose a human-readable title from claim metadata, not the generic
 * "Public evidence contradicts claim" title stored in sri_findings.
 *
 * Format: "{ClaimType} claim {verdict} — {entity} ({N} sources)"
 */
function composeDisplayTitle(
  claim: z.infer<typeof ClaimRow>,
  finding: z.infer<typeof FindingRow>,
  evidenceCount: number,
): string {
  const typeLabel = CLAIM_TYPE_LABELS[claim.claim_type] ?? claim.claim_type;

  const verdictVerb: Record<string, string> = {
    contradicted: "contradicted",
    mixed: "mixed evidence",
    corroborated: "corroborated",
    unverifiable: "unverifiable",
    not_searched: "not searched",
  };
  const verb = verdictVerb[finding.verdict] ?? finding.verdict;

  const entityPart = claim.subject_entity ? " — " + claim.subject_entity : "";
  const sourcePart = evidenceCount > 0 ? " (" + evidenceCount + " source" + (evidenceCount === 1 ? "" : "s") + ")" : "";

  return typeLabel + " claim " + verb + entityPart + sourcePart;
}

// ═══════════════════════════════════════════════════════════════════
// MARKDOWN ASSEMBLY — pure string formatting, zero LLM
// ═══════════════════════════════════════════════════════════════════

function assembleMarkdown(
  header: RenderedReport["header"],
  findingGroups: RenderedReport["findings_by_severity"],
  coverage: RenderedReport["coverage"],
  limitations: string[],
): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────

  lines.push("# Social & Reputation Intelligence — Report");
  lines.push("");
  lines.push("**Deal:** " + header.deal_id);
  lines.push("**Run:** " + header.run_id);
  lines.push("**Generated:** " + header.generated_at);
  lines.push("");

  // Target profile
  if (header.trading_names.length > 0) {
    lines.push("**Trading names:** " + header.trading_names.join(", "));
    lines.push("");
  }

  if (header.profile_fields.length > 0) {
    lines.push("### Target Profile");
    lines.push("");
    for (const pf of header.profile_fields) {
      lines.push("- " + pf.value);
    }
    lines.push("");
  }

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push("| Claims extracted | " + header.total_claims + " |");
  lines.push("| Findings | " + header.total_findings + " |");

  for (const sev of ["critical", "warning", "info"]) {
    if (header.findings_by_severity[sev]) {
      lines.push("| " + sev.charAt(0).toUpperCase() + sev.slice(1) + " | " + header.findings_by_severity[sev] + " |");
    }
  }

  for (const v of ["contradicted", "mixed", "corroborated", "unverifiable", "not_searched"]) {
    if (header.findings_by_verdict[v]) {
      lines.push("| " + (VERDICT_LABELS[v] ?? v) + " | " + header.findings_by_verdict[v] + " |");
    }
  }
  lines.push("");

  // ── Findings by severity ────────────────────────────────────────

  lines.push("---");
  lines.push("");
  lines.push("## Findings");
  lines.push("");

  for (const group of findingGroups) {
    lines.push("### " + group.severity.charAt(0).toUpperCase() + group.severity.slice(1));
    lines.push("");

    for (const f of group.findings) {
      lines.push("#### " + f.display_title);
      lines.push("");
      lines.push("- **Verdict:** " + f.verdict_label);
      lines.push("- **Severity:** " + f.severity);
      lines.push("- **Claim type:** " + f.claim_type_label);
      if (f.subject_entity) {
        lines.push("- **Entity:** " + f.subject_entity);
      }
      if (f.entity_confidence) {
        lines.push("- **Entity confidence:** " + f.entity_confidence);
      }
      if (f.thesis_dependence) {
        lines.push("- **Thesis dependence:** " + f.thesis_dependence);
      }
      if (f.attribution) {
        lines.push("- **Source:** " + f.attribution);
      }
      lines.push("");

      lines.push("**Claim:** _\"" + f.claim_text.slice(0, 500) + "\"_");
      lines.push("");

      if (f.locator) {
        lines.push("**Locator:** " + f.locator);
        lines.push("");
      }

      if (f.pointer_text) {
        lines.push("**Assessment:** " + f.pointer_text);
        lines.push("");
      }

      // Evidence list
      if (f.evidence.length > 0) {
        lines.push("**Evidence (" + f.supports_count + " supports, " + f.contradicts_count + " contradicts):**");
        lines.push("");
        for (let i = 0; i < f.evidence.length; i++) {
          const ev = f.evidence[i];
          const stanceTag = ev.stance ? " [" + ev.stance + "]" : "";
          const matchTag = ev.entity_match && ev.entity_match !== "confirmed" ? " (entity: " + ev.entity_match + ")" : "";
          lines.push((i + 1) + ". **" + ev.platform + "**" + stanceTag + matchTag);
          lines.push("   - URL: " + ev.url);
          if (ev.domain) lines.push("   - Domain: " + ev.domain);
          if (ev.publication_date) lines.push("   - Date: " + ev.publication_date);
          if (ev.snippet) lines.push("   - Snippet: " + ev.snippet.slice(0, 300));
          lines.push("");
        }
      }
    }
  }

  // ── Coverage ────────────────────────────────────────────────────

  lines.push("---");
  lines.push("");
  lines.push("## Coverage — Claims Not Verified");
  lines.push("");

  if (coverage.length === 0) {
    lines.push("All claims were verified against public sources.");
    lines.push("");
  } else {
    lines.push("The following claims could not be verified. This does not confirm or deny the claim — public data sources did not provide relevant results.");
    lines.push("");

    const notSearched = coverage.filter((c) => c.verdict === "not_searched");
    const unverifiable = coverage.filter((c) => c.verdict === "unverifiable");

    if (notSearched.length > 0) {
      lines.push("### Not Searched (" + notSearched.length + ")");
      lines.push("");
      for (const c of notSearched) {
        lines.push("- [" + c.claim_type + "] " + c.claim_text.slice(0, 150) + " — _" + c.reason + "_");
      }
      lines.push("");
    }

    if (unverifiable.length > 0) {
      lines.push("### Unverifiable (" + unverifiable.length + ")");
      lines.push("");
      for (const c of unverifiable) {
        lines.push("- [" + c.claim_type + "] " + c.claim_text.slice(0, 150));
      }
      lines.push("");
    }
  }

  // ── Limitations ─────────────────────────────────────────────────

  lines.push("---");
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  for (const lim of limitations) {
    lines.push("- " + lim);
  }
  lines.push("");

  return lines.join("\n");
}
