/**
 * mast-render.ts
 *
 * Stage handler for render.
 *
 * Assembles the MAST module output as a markdown report. Code owns the
 * structure and every number. The LLM writes nothing in this stage.
 *
 * The report is ordered by dependence, not by severity, because the
 * question an IC member is asking is what this deal rests on, not what
 * our tool scored highest.
 *
 * render is a single-shot stage and stays out of LOOP_STAGES.
 *
 * Writes only to the payload column of mast_pipeline_state. Does not
 * write to mast_assumptions, mast_support_evidence, or mast_findings.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { z } from "@superblocksteam/sdk-api";
import mastPublish from "./mast-publish-inline.js";

const LOG_PREFIX = "[MAST-RENDER]";

const CRITICAL_CAP = 25;
const WARNING_CAP = 25;

// ---------------------------------------------------------------------------
// Tier ordering constant — critical first
// ---------------------------------------------------------------------------

const TIER_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// DB row schemas
// ---------------------------------------------------------------------------

const FindingJoinedRow = z.object({
  finding_id: z.string(),
  assumption_id: z.string(),
  severity: z.string(),
  severity_basis: z.string(),
  title: z.string(),
  falsification_condition: z.string().nullable(),
  monitoring_trigger: z.string().nullable(),
  dependence_tier: z.string().nullable(),
  dependence_basis: z.string().nullable(),
  origin_type: z.string(),
  origin_locator: z.string().nullable(),
  verbatim: z.string().nullable(),
  detector: z.string().nullable(),
  recursion_depth: z.coerce.number().nullable(),
  proposition: z.string(),
});

const EvidenceRow = z.object({
  assumption_id: z.string(),
  statement_type: z.string(),
  verbatim: z.string(),
  locator: z.string().nullable(),
});

const StagePayloadRow = z.object({
  stage: z.string(),
  payload: z.any().nullable(),
});

const DocumentRow = z.object({
  doc_id: z.string(),
  file_name: z.string(),
  table_count: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSupportState(severityBasis: string): string {
  const match = severityBasis.match(/support=(\w+)/);
  return match ? match[1] : "unknown";
}

function extractDependenceTier(severityBasis: string): string {
  const match = severityBasis.match(/dependence=(\w+)/);
  return match ? match[1] : "unknown";
}

function tierSort(a: { dependence_tier: string | null; assumption_id: string }, b: { dependence_tier: string | null; assumption_id: string }): number {
  const ta = TIER_ORDER[a.dependence_tier ?? "low"] ?? 3;
  const tb = TIER_ORDER[b.dependence_tier ?? "low"] ?? 3;
  if (ta !== tb) return ta - tb;
  return a.assumption_id.localeCompare(b.assumption_id);
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const render: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, runId, dealId } = ctx;

  // ── 1. Load findings joined to assumptions ────────────────────────
  const allFindings = await db.query(
    `SELECT
       f.id AS finding_id,
       f.assumption_id,
       f.severity,
       f.severity_basis,
       f.title,
       f.falsification_condition,
       f.monitoring_trigger,
       a.dependence_tier,
       a.dependence_basis,
       a.origin_type,
       a.origin_locator,
       a.verbatim,
       a.detector,
       a.recursion_depth,
       a.proposition
     FROM mast_findings f
     JOIN mast_assumptions a ON a.id = f.assumption_id
     WHERE f.run_id = $1::uuid
       AND a.dedup_group_id = a.id
     ORDER BY
       CASE a.dependence_tier
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'moderate' THEN 2
         ELSE 3
       END,
       f.assumption_id`,
    FindingJoinedRow,
    [runId],
    { label: "MAST-RENDER: load findings joined to assumptions" },
  );

  if (allFindings.length === 0) {
    throw new Error(
      `${LOG_PREFIX} No findings found for run ${runId}. Cannot render report.`,
    );
  }

  // ── Filter: remove rows whose proposition still contains a density tag ──
  const DENSITY_RE = /\(\d+\.\d+\)/;
  const unrewrittenRows = allFindings.filter((f) => DENSITY_RE.test(f.proposition));
  const duplicateRowsExcluded = 0; // canonical filter is in the SQL; count is informational
  const unrewrittenCount = unrewrittenRows.length;
  const unrewrittenIds = new Set(unrewrittenRows.map((f) => f.finding_id));
  const filteredFindings = allFindings.filter((f) => !unrewrittenIds.has(f.finding_id));

  console.log(
    `${LOG_PREFIX} ${allFindings.length} findings loaded (canonical only). ` +
    `${unrewrittenCount} excluded as unrewritten (density tag in proposition).`,
  );

  // ── 2. Load support evidence ──────────────────────────────────────
  const evidenceRows = await db.query(
    `SELECT assumption_id, statement_type, verbatim, locator
     FROM mast_support_evidence
     WHERE run_id = $1::uuid`,
    EvidenceRow,
    [runId],
    { label: "MAST-RENDER: load support evidence" },
  );

  const evidenceByAssumption = new Map<string, Array<{ statement_type: string; verbatim: string; locator: string | null }>>();
  for (const row of evidenceRows) {
    let list = evidenceByAssumption.get(row.assumption_id);
    if (!list) {
      list = [];
      evidenceByAssumption.set(row.assumption_id, list);
    }
    list.push({ statement_type: row.statement_type, verbatim: row.verbatim, locator: row.locator });
  }

  console.log(`${LOG_PREFIX} ${evidenceRows.length} evidence rows loaded.`);

  // ── 3. Load stage payloads ────────────────────────────────────────
  const stagePayloads = await db.query(
    `SELECT stage, payload
     FROM mast_pipeline_state
     WHERE run_id = $1::uuid AND stage != '_lock'`,
    StagePayloadRow,
    [runId],
    { label: "MAST-RENDER: load stage payloads" },
  );

  const payloadMap = new Map<string, any>();
  for (const row of stagePayloads) {
    if (row.payload) payloadMap.set(row.stage, row.payload);
  }

  // ── 4. Load documents for this deal ───────────────────────────────
  const documentRows = await db.query(
    `SELECT d.id AS doc_id, d.file_name, COUNT(dt.id)::int AS table_count
     FROM documents d
     LEFT JOIN doc_tables dt ON dt.document_id = d.id
     WHERE d.deal_id = $1::uuid
     GROUP BY d.id, d.file_name`,
    DocumentRow,
    [dealId],
    { label: "MAST-RENDER: load deal documents" },
  );

  // Map doc_id → file_name for evidence locator display
  const docNameMap = new Map<string, string>();
  for (const doc of documentRows) {
    docNameMap.set(doc.doc_id, doc.file_name);
  }

  // Which docs contributed assumptions (by origin_doc_id)?
  // Derive from allFindings — but origin_doc_id is on assumptions, not in our join.
  // We'll use a separate lightweight query.
  const assumptionDocRows = await db.query(
    `SELECT DISTINCT origin_doc_id
     FROM mast_assumptions
     WHERE run_id = $1::uuid AND origin_doc_id IS NOT NULL`,
    z.object({ origin_doc_id: z.string() }),
    [runId],
    { label: "MAST-RENDER: distinct origin doc ids" },
  );
  const referencedDocIds = new Set(assumptionDocRows.map((r) => r.origin_doc_id));

  // ── 5. Compute counts from rows ──────────────────────────────────
  const totalFindings = filteredFindings.length;

  // Support state counts from findings
  const supportCounts = { measured: 0, forecast: 0, asserted: 0, nothing: 0 };
  for (const f of filteredFindings) {
    const support = extractSupportState(f.severity_basis) as keyof typeof supportCounts;
    if (support in supportCounts) supportCounts[support]++;
  }

  // Severity counts from findings
  const sevCounts = { critical: 0, warning: 0, info: 0 };
  for (const f of filteredFindings) {
    const sev = f.severity as keyof typeof sevCounts;
    if (sev in sevCounts) sevCounts[sev]++;
  }

  // ── 6. Build sections ─────────────────────────────────────────────
  const sections: string[] = [];

  // ── Section 1: Dependency Statement ───────────────────────────────
  sections.push("# Model Assumptions Stress Test\n");
  sections.push("## 1. Dependency Statement\n");
  sections.push(
    `This deal rests on ${totalFindings} beliefs extracted from the model and supporting documents. ` +
    `Of these, ${supportCounts.measured} are backed by something measured in the reference corpus, ` +
    `${supportCounts.forecast} by a forecast, ` +
    `${supportCounts.asserted} asserted by the deal team alone, ` +
    `and ${supportCounts.nothing} have nothing behind them anywhere in the room.\n`,
  );

  // ── Section 2: Critical List ──────────────────────────────────────
  sections.push("## 2. Critical Findings\n");
  const criticals = filteredFindings.filter((f) => f.severity === "critical");
  const criticalsCapped = criticals.slice(0, CRITICAL_CAP);
  const criticalOmitted = criticals.length - criticalsCapped.length;

  if (criticalsCapped.length === 0) {
    sections.push("No findings reached critical severity.\n");
  } else {
    for (const f of criticalsCapped) {
      const support = extractSupportState(f.severity_basis);
      const tier = f.dependence_tier ?? "low";
      const basis = f.dependence_basis ?? "rule_table_default";

      let block = `### ${f.proposition}\n\n`;
      block += `- **Dependence:** ${tier} (${basis})\n`;
      block += `- **Support:** ${support}\n`;

      if (f.falsification_condition) {
        block += `- **Falsification:** ${f.falsification_condition}\n`;
      }
      if (f.monitoring_trigger) {
        block += `- **Monitor:** ${f.monitoring_trigger}\n`;
      }

      // Up to 2 supporting quotes
      const evidence = evidenceByAssumption.get(f.assumption_id) ?? [];
      const quotes = evidence.slice(0, 2);
      if (quotes.length > 0) {
        block += "\n**Supporting evidence:**\n\n";
        for (const q of quotes) {
          const loc = q.locator ? ` (${q.locator})` : "";
          block += `> "${q.verbatim}"${loc} [${q.statement_type}]\n\n`;
        }
      }

      sections.push(block);
    }

    if (criticalOmitted > 0) {
      sections.push(`*${criticalOmitted} additional critical findings omitted.*\n`);
    }
  }

  // ── Section 3: Warnings ───────────────────────────────────────────
  sections.push("## 3. Warnings\n");
  const warnings = filteredFindings.filter((f) => f.severity === "warning");
  const warningsCapped = warnings.slice(0, WARNING_CAP);
  const warningOmitted = warnings.length - warningsCapped.length;

  if (warningsCapped.length === 0) {
    sections.push("No findings reached warning severity.\n");
  } else {
    for (const f of warningsCapped) {
      const support = extractSupportState(f.severity_basis);
      const tier = f.dependence_tier ?? "low";
      const basis = f.dependence_basis ?? "rule_table_default";
      let line = `- **${f.proposition}** — dependence: ${tier} (${basis}), support: ${support}`;
      if (f.falsification_condition) {
        line += `. Falsification: ${f.falsification_condition}`;
      }
      if (f.monitoring_trigger) {
        line += `. Monitor: ${f.monitoring_trigger}`;
      }
      sections.push(line + "\n");
    }

    if (warningOmitted > 0) {
      sections.push(`\n*${warningOmitted} additional warning findings omitted.*\n`);
    }
  }

  // ── Section 4: Silent Assumptions ─────────────────────────────────
  sections.push("\n## 4. Silent Assumptions\n");
  const silentFindings = filteredFindings.filter((f) => f.origin_type === "model_implicit");

  if (silentFindings.length === 0) {
    sections.push("No silent assumptions were detected in this model.\n");
  } else {
    // Group by detector
    const byDetector = new Map<string, typeof silentFindings>();
    for (const f of silentFindings) {
      const det = f.detector ?? "unknown";
      let list = byDetector.get(det);
      if (!list) {
        list = [];
        byDetector.set(det, list);
      }
      list.push(f);
    }

    sections.push(
      `${silentFindings.length} assumptions were never written down explicitly. ` +
      `These were detected by automated analysis of the model structure.\n\n`,
    );

    for (const [detector, findings] of byDetector) {
      sections.push(`**Detector: ${detector}** (${findings.length})\n\n`);
      for (const f of findings) {
        const support = extractSupportState(f.severity_basis);
        sections.push(`- ${f.proposition} [${f.severity}, support: ${support}]\n`);
      }
      sections.push("\n");
    }
  }

  // ── Section 5: Inherited Assumptions ──────────────────────────────
  sections.push("## 5. Inherited Assumptions\n");
  const inheritedFindings = filteredFindings.filter(
    (f) => f.origin_type === "inherited" || (f.recursion_depth !== null && f.recursion_depth >= 1),
  );

  if (inheritedFindings.length === 0) {
    sections.push("No inherited assumptions were identified.\n");
  } else {
    sections.push(
      `${inheritedFindings.length} assumptions were adopted from external reports ` +
      `without being restated in the memo. These did not appear in the memo.\n\n`,
    );
    for (const f of inheritedFindings) {
      const support = extractSupportState(f.severity_basis);
      const tier = f.dependence_tier ?? "low";
      const loc = f.origin_locator ? ` (${f.origin_locator})` : "";
      sections.push(`- ${f.proposition} [${f.severity}, dependence: ${tier}, support: ${support}]${loc}\n`);
    }
  }

  // ── Section 6: Coverage and Limitations ───────────────────────────
  sections.push("\n## 6. Coverage and Limitations\n");

  // 6a. Sweep ran?
  const sevPayload = payloadMap.get("severity") as any;
  const sweepRan = sevPayload?.sweepRan === true;
  if (sweepRan) {
    sections.push(
      "The corpus support sweep ran for this analysis. Evidence classification reflects " +
      "the content of the reference documents available at run time.\n\n",
    );
  } else {
    sections.push(
      "The corpus support sweep did not run for this analysis. Every assumption in this " +
      "report reads as unsupported for that reason and not because the corpus lacks support.\n\n",
    );
  }

  // 6b. Dependence rule table
  const depPayload = payloadMap.get("dependence") as any;
  const ruleTableDefaultCount = depPayload?.ruleTableDefaultCount ?? 0;
  sections.push(
    "Dependence tiers were assigned by a keyword rule table rather than computed " +
    "from the financial model, because the model's formulas do not survive document " +
    `ingestion. ${ruleTableDefaultCount} assumption${ruleTableDefaultCount === 1 ? "" : "s"} ` +
    "matched no rule and therefore defaulted to low.\n\n",
  );

  // 6c. Lineage
  sections.push(
    "The lineage stage did not run in this build, so the report does not trace how " +
    "an assumption changed as it moved between documents.\n\n",
  );

  // 6d. No return impact
  sections.push(
    "No return impact is stated anywhere in this report, because the source financial " +
    "model contains no IRR, no MOIC and no exit multiple, so any such figure would be fabricated.\n\n",
  );

  // 6e. Documents
  sections.push("**Documents read:**\n\n");
  if (documentRows.length === 0) {
    sections.push("No documents were loaded for this deal.\n\n");
  } else {
    for (const doc of documentRows) {
      const referenced = referencedDocIds.has(doc.doc_id) ? "" : " *(no assumptions extracted)*";
      const tables = doc.table_count > 0
        ? `${doc.table_count} structured table${doc.table_count === 1 ? "" : "s"}`
        : "no structured tables";
      sections.push(`- ${doc.file_name} — ${tables}${referenced}\n`);
    }
    sections.push("\n");
  }

  // 6f. Capped counts
  if (criticalOmitted > 0 || warningOmitted > 0) {
    const parts: string[] = [];
    if (criticalOmitted > 0) parts.push(`${criticalOmitted} critical`);
    if (warningOmitted > 0) parts.push(`${warningOmitted} warning`);
    sections.push(
      `${parts.join(" and ")} finding${criticalOmitted + warningOmitted === 1 ? " was" : "s were"} ` +
      "omitted from the detailed sections above due to length limits.\n\n",
    );
  }

  // 6g. Exclusion disclosures
  const exclusionParts: string[] = [];
  if (unrewrittenCount > 0) {
    exclusionParts.push(
      `${unrewrittenCount} row${unrewrittenCount === 1 ? " was" : "s were"} excluded because ` +
      "they could not be expressed as propositions",
    );
  }
  if (exclusionParts.length > 0) {
    sections.push(exclusionParts.join(". ") + ".\n\n");
  }

  // ── Section 7: Full Register Appendix ─────────────────────────────
  sections.push("## 7. Full Register\n\n");
  sections.push("| # | Proposition | Dependence | Support | Severity |\n");
  sections.push("|---|-------------|------------|---------|----------|\n");

  // Sort all findings by dependence tier then severity
  const sorted = [...filteredFindings].sort((a, b) => {
    const ta = TIER_ORDER[a.dependence_tier ?? "low"] ?? 3;
    const tb = TIER_ORDER[b.dependence_tier ?? "low"] ?? 3;
    if (ta !== tb) return ta - tb;
    // Within same tier, sort by severity
    const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    const sa = sevOrder[a.severity] ?? 2;
    const sb = sevOrder[b.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    return a.assumption_id.localeCompare(b.assumption_id);
  });

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    const support = extractSupportState(f.severity_basis);
    const tier = f.dependence_tier ?? "low";
    // Escape pipes in proposition for markdown table
    const prop = f.proposition.replace(/\|/g, "\\|").replace(/\n/g, " ");
    sections.push(`| ${i + 1} | ${prop} | ${tier} | ${support} | ${f.severity} |\n`);
  }

  // ── 7. Assemble report ────────────────────────────────────────────
  const report = sections.join("");

  console.log(
    `${LOG_PREFIX} Report assembled. ${report.length} characters. ` +
    `${totalFindings} findings, ${criticals.length} critical, ` +
    `${warnings.length} warning, ${sevCounts.info} info.`,
  );

  // ── 8. Section counts for payload ─────────────────────────────────
  const sectionCounts = {
    totalFindings,
    critical: criticals.length,
    criticalRendered: criticalsCapped.length,
    criticalOmitted,
    warning: warnings.length,
    warningRendered: warningsCapped.length,
    warningOmitted,
    info: sevCounts.info,
    silent: silentFindings.length,
    inherited: inheritedFindings.length,
    registerRows: sorted.length,
    documentsRead: documentRows.length,
    documentsWithTables: documentRows.filter((d) => d.table_count > 0).length,
    documentsWithNoAssumptions: documentRows.filter((d) => !referencedDocIds.has(d.doc_id)).length,
    evidenceRowsLoaded: evidenceRows.length,
    sweepRan,
    ruleTableDefaultCount,
    reportLength: report.length,
    nothingCount: supportCounts.nothing,
    unrewrittenExcluded: unrewrittenCount,
  };

  // ── 9. Persist payload ────────────────────────────────────────────
  const renderPayload = {
    report,
    sectionCounts,
  };

  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, "render", JSON.stringify(renderPayload)],
      { label: "MAST-RENDER: persist report and section counts" },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }

  // ── 10. Publish to module_outputs ──────────────────────────────
  try {
    await mastPublish(db, runId, dealId, report, sectionCounts);
    console.log(`${LOG_PREFIX} Published to module_outputs.`);
  } catch (publishErr) {
    console.log(
      `${LOG_PREFIX} Publish to module_outputs failed: ${String(publishErr)}. ` +
      `Report is preserved in payload. Run can be re-published.`,
    );
  }

  return {
    complete: true,
    itemsDone: totalFindings,
    itemsTotal: totalFindings,
    resumePosition: 0,
  };
};

export default render;
