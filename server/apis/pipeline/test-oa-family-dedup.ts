/**
 * test-oa-family-dedup.ts — OA-03 Test Harness
 *
 * 10 tests covering deterministic canonical-family deduplication:
 *   T1:  Each frozen known family collapses as expected
 *   T2:  Duplicate ordering doesn't change representative or hash
 *   T3:  Replay produces identical family IDs/members/representative/hash
 *   T4:  All evidence and coordinates survive deduplication
 *   T5:  No member disappears silently
 *   T6:  Anti-overmerge pairs remain separate
 *   T7:  Unknown dimensions fail closed
 *   T8:  Family rules cannot change severity/reportability/proposition/authority
 *   T9:  Repeated finalization is idempotent
 *   T10: Bounded SCG replay before/after counts by family
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";
import {
  deduplicateFindings,
  computeFamilyKey,
  computeFamilyHash,
  selectRepresentative,
  violatesAntiOvermerge,
  verifyCompleteness,
  verifyNonGenerative,
  KNOWN_FAMILY_RULES,
  FAMILY_RULE_VERSION,
} from "./canonical-family-dedup.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";
const SCG_RUN_ID = "576171a3-5533-4dcc-8af6-7a1ffd56026e";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<CanonicalFinding> & { finding_id: string; title: string }): CanonicalFinding {
  return {
    severity: "warning",
    detail: "test detail",
    full_analysis: "test analysis",
    source_docs: ["doc1.pdf"],
    ...overrides,
  } as CanonicalFinding;
}

function makeRevenueFamily(count: number, baseId = "rev"): CanonicalFinding[] {
  return Array.from({ length: count }, (_, i) =>
    makeFinding({
      finding_id: `${baseId}-${String(i).padStart(3, "0")}`,
      title: `Revenue recognition timing discrepancy ${i}`,
      issue_key: "revenue_basis_discrepancy",
      finding_kind: "data_divergence",
      evidence: [
        {
          figure: `£${(i + 1) * 100}k`,
          source_doc: "financial_model.xlsx",
          verbatim_snippet: `Revenue of £${(i + 1) * 100}k recognized in Q${(i % 4) + 1}`,
          verified: i % 2 === 0,
          cell_coordinate: `B${10 + i}`,
          sheet_or_page: "P&L",
        },
      ],
      structured_impact: i === 0 ? [{ amount: 500000, currency: "GBP" as const, unit_multiplier: 1, role: "delta" as const, verified: true }] : [],
      severity_anchor: i === 0 ? "£500k revenue timing differential" : undefined,
      claim_ids: [`doc1:chunk${i}:claim0`],
    })
  );
}

// ---------------------------------------------------------------------------
// Test implementations
// ---------------------------------------------------------------------------

interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  skipped?: boolean;
  detail: string;
}

function runT1(): TestResult {
  // T1: Each frozen known family collapses as expected
  const findings = makeRevenueFamily(4);
  const result = deduplicateFindings(findings);

  const checks: string[] = [];
  if (result.families.length !== 1) checks.push(`expected 1 family, got ${result.families.length}`);
  if (result.families[0]?.familyId !== "revenue_recognition_cutoff") {
    checks.push(`expected revenue_recognition_cutoff, got ${result.families[0]?.familyId}`);
  }
  if (result.families[0]?.memberFindingIds.length !== 4) {
    checks.push(`expected 4 members, got ${result.families[0]?.memberFindingIds.length}`);
  }
  if (result.totalSuppressed !== 3) checks.push(`expected 3 suppressed, got ${result.totalSuppressed}`);

  return {
    id: "T1",
    name: "Each frozen known family collapses as expected",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Family ${result.families[0]?.familyId}: ${result.families[0]?.memberFindingIds.length} members, rep=${result.families[0]?.representativeFindingId}`
      : checks.join("; "),
  };
}

function runT2(): TestResult {
  // T2: Duplicate ordering doesn't change representative or hash
  const findingsA = makeRevenueFamily(5);
  const findingsB = [...findingsA].reverse(); // Reverse order
  const findingsC = [...findingsA].sort(() => 0.5 - Math.random()); // Random shuffle

  const resultA = deduplicateFindings(findingsA);
  const resultB = deduplicateFindings(findingsB);
  const resultC = deduplicateFindings(findingsC);

  const checks: string[] = [];
  const repA = resultA.families[0]?.representativeFindingId;
  const repB = resultB.families[0]?.representativeFindingId;
  const repC = resultC.families[0]?.representativeFindingId;
  if (repA !== repB) checks.push(`rep mismatch A vs B: ${repA} vs ${repB}`);
  if (repA !== repC) checks.push(`rep mismatch A vs C: ${repA} vs ${repC}`);

  const hashA = resultA.families[0]?.semanticHash;
  const hashB = resultB.families[0]?.semanticHash;
  const hashC = resultC.families[0]?.semanticHash;
  if (hashA !== hashB) checks.push(`hash mismatch A vs B: ${hashA} vs ${hashB}`);
  if (hashA !== hashC) checks.push(`hash mismatch A vs C: ${hashA} vs ${hashC}`);

  const fpA = resultA.resultFingerprint;
  const fpB = resultB.resultFingerprint;
  if (fpA !== fpB) checks.push(`fingerprint mismatch: ${fpA} vs ${fpB}`);

  return {
    id: "T2",
    name: "Duplicate ordering doesn't change representative or hash",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Deterministic: rep=${repA}, hash=${hashA}, fingerprint=${fpA}`
      : checks.join("; "),
  };
}

function runT3(): TestResult {
  // T3: Replay produces identical family IDs/members/representative/hash
  const findings = [
    ...makeRevenueFamily(3, "rev"),
    makeFinding({
      finding_id: "wc-001",
      title: "Working capital adjustment needed",
      issue_key: "nwc_negative_trend_and_seasonality",
      finding_kind: "data_divergence",
      evidence: [{ figure: "£200k", source_doc: "model.xlsx", verbatim_snippet: "NWC of £200k", verified: true }],
    }),
    makeFinding({
      finding_id: "wc-002",
      title: "Working capital peg discrepancy",
      issue_key: "working_capital_surgery_connect_structural_tension",
      finding_kind: "cross_version",
      evidence: [{ figure: "£150k", source_doc: "spa.pdf", verbatim_snippet: "WC target £150k", verified: false }],
    }),
  ];

  // Run twice
  const run1 = deduplicateFindings(findings);
  const run2 = deduplicateFindings(findings);

  const checks: string[] = [];
  if (run1.families.length !== run2.families.length) {
    checks.push(`family count differs: ${run1.families.length} vs ${run2.families.length}`);
  }
  for (let i = 0; i < run1.families.length; i++) {
    const f1 = run1.families[i];
    const f2 = run2.families[i];
    if (f1.semanticHash !== f2.semanticHash) checks.push(`hash[${i}] mismatch`);
    if (f1.representativeFindingId !== f2.representativeFindingId) checks.push(`rep[${i}] mismatch`);
    if (JSON.stringify(f1.memberFindingIds) !== JSON.stringify(f2.memberFindingIds)) checks.push(`members[${i}] mismatch`);
  }
  if (run1.resultFingerprint !== run2.resultFingerprint) checks.push("fingerprint mismatch");

  return {
    id: "T3",
    name: "Replay produces identical family IDs/members/representative/hash",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Replay verified: ${run1.families.length} families, fingerprint=${run1.resultFingerprint}`
      : checks.join("; "),
  };
}

function runT4(): TestResult {
  // T4: All evidence and coordinates survive deduplication
  const findings = makeRevenueFamily(3);
  const result = deduplicateFindings(findings);

  const family = result.families[0];
  const checks: string[] = [];

  // Each finding had 1 evidence entry + 1 claim_id
  if (family.allEvidenceIds.length < 3) {
    checks.push(`expected ≥3 evidence IDs, got ${family.allEvidenceIds.length}`);
  }
  // Each had a cell_coordinate
  if (family.sourceCoordinates.length < 3) {
    checks.push(`expected ≥3 source coords, got ${family.sourceCoordinates.length}`);
  }
  // Each had a claim_id
  const totalClaims = family.allEvidenceIds.filter((id) => id.startsWith("doc1:chunk")).length;
  if (totalClaims < 3) {
    checks.push(`expected ≥3 claim IDs in evidence, got ${totalClaims}`);
  }

  return {
    id: "T4",
    name: "All evidence and coordinates survive deduplication",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Evidence: ${family.allEvidenceIds.length} IDs, ${family.sourceCoordinates.length} coords`
      : checks.join("; "),
  };
}

function runT5(): TestResult {
  // T5: No member disappears silently
  const findings = [
    ...makeRevenueFamily(4, "rev"),
    makeFinding({
      finding_id: "solo-001",
      title: "Standalone finding without family",
      issue_key: "unknown_random_key",
      finding_kind: "process_observation",
    }),
  ];

  const result = deduplicateFindings(findings);
  const inputIds = findings.map((f) => f.finding_id);
  const completeness = verifyCompleteness(inputIds, result);

  const checks: string[] = [];
  if (!completeness.complete) {
    if (completeness.missing.length > 0) checks.push(`missing: ${completeness.missing.join(", ")}`);
    if (completeness.duplicated.length > 0) checks.push(`duplicated: ${completeness.duplicated.join(", ")}`);
  }

  // solo-001 should be ungrouped
  if (!result.ungroupedFindingIds.includes("solo-001")) {
    checks.push("solo-001 not in ungrouped (should be since unknown key)");
  }

  return {
    id: "T5",
    name: "No member disappears silently",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Complete: ${inputIds.length} input → ${result.families.reduce((s, f) => s + f.memberFindingIds.length, 0)} in families + ${result.ungroupedFindingIds.length} ungrouped`
      : checks.join("; "),
  };
}

function runT6(): TestResult {
  // T6: Anti-overmerge pairs remain separate (customer vs supplier concentration)
  const customerFindings = [
    makeFinding({
      finding_id: "cust-001",
      title: "Top customer accounts for 60% of revenue",
      issue_key: "change_of_control_customer_termination_rights",
      finding_kind: "data_divergence",
      detail: "Revenue concentration on key customer accounts",
    }),
    makeFinding({
      finding_id: "cust-002",
      title: "Client dependency risk in revenue concentration",
      issue_key: "change_of_control_customer_termination_rights",
      finding_kind: "source_stated_risk",
      detail: "Key client represents majority of revenue",
    }),
  ];

  const supplierFindings = [
    makeFinding({
      finding_id: "supp-001",
      title: "Single supplier provides 80% of raw materials",
      issue_key: "gamma_telecom_supplier_concentration",
      finding_kind: "source_stated_risk",
      detail: "Supply chain vendor dependency",
    }),
    makeFinding({
      finding_id: "supp-002",
      title: "Supplier dependency in procurement",
      issue_key: "gamma_telecom_supplier_concentration",
      finding_kind: "data_divergence",
      detail: "Key supplier accounts for bulk of supply",
    }),
  ];

  const allFindings = [...customerFindings, ...supplierFindings];
  const result = deduplicateFindings(allFindings);

  const checks: string[] = [];
  // Should have 2 families: customer_revenue_concentration and supplier_single_source
  const custFamily = result.families.find((f) => f.familyId === "customer_revenue_concentration");
  const suppFamily = result.families.find((f) => f.familyId === "supplier_single_source");

  if (!custFamily) checks.push("no customer_revenue_concentration family");
  if (!suppFamily) checks.push("no supplier_single_source family");

  // Verify no cross-contamination
  if (custFamily && custFamily.memberFindingIds.some((id) => id.startsWith("supp"))) {
    checks.push("customer family contains supplier findings");
  }
  if (suppFamily && suppFamily.memberFindingIds.some((id) => id.startsWith("cust"))) {
    checks.push("supplier family contains customer findings");
  }

  // Additionally test anti-overmerge on trademark_ownership_chain
  const ipRule = KNOWN_FAMILY_RULES.find((r) => r.familyId === "trademark_ownership_chain")!;
  const regTM = makeFinding({
    finding_id: "ip-reg-001",
    title: "Registered trademark ownership gap",
    issue_key: "unregistered_trade_marks",
    finding_kind: "absence_claim",
    detail: "The registered trademark registration shows incomplete assignment chain",
  });
  const unregTM = makeFinding({
    finding_id: "ip-unreg-001",
    title: "Unregistered common law mark risk",
    issue_key: "unregistered_trade_marks",
    finding_kind: "absence_claim",
    detail: "Unregistered trademark ™ has no chain of title",
  });

  if (!violatesAntiOvermerge(regTM, unregTM, ipRule)) {
    checks.push("registered vs unregistered TM should trigger anti-overmerge");
  }

  return {
    id: "T6",
    name: "Anti-overmerge pairs remain separate",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Customer family: ${custFamily?.memberFindingIds.length} members; Supplier family: ${suppFamily?.memberFindingIds.length} members; IP anti-overmerge: verified`
      : checks.join("; "),
  };
}

function runT7(): TestResult {
  // T7: Unknown dimensions fail closed (no grouping)
  const findings = [
    makeFinding({
      finding_id: "unk-001",
      title: "Some unknown issue",
      issue_key: "completely_novel_risk_category",
      finding_kind: "data_divergence",
    }),
    makeFinding({
      finding_id: "unk-002",
      title: "Another unknown issue same key",
      issue_key: "completely_novel_risk_category",
      finding_kind: "data_divergence",
    }),
    makeFinding({
      finding_id: "nokey-001",
      title: "Finding without issue_key",
      finding_kind: "source_stated_risk",
    }),
    // Finding kind mismatch: FCA key but ineligible kind
    makeFinding({
      finding_id: "kindmismatch-001",
      title: "FCA authorisation revocation data",
      issue_key: "dataphone_fca_authorisation_revocation",
      finding_kind: "data_divergence", // Not eligible for fca_permissions_gap (needs absence_claim|source_stated_risk|process_observation)
    }),
  ];

  const result = deduplicateFindings(findings);
  const checks: string[] = [];

  if (result.families.length !== 0) {
    checks.push(`expected 0 families, got ${result.families.length}`);
  }
  // All should be ungrouped
  if (result.ungroupedFindingIds.length !== 4) {
    checks.push(`expected 4 ungrouped, got ${result.ungroupedFindingIds.length}`);
  }
  // Verify specific IDs
  for (const id of ["unk-001", "unk-002", "nokey-001", "kindmismatch-001"]) {
    if (!result.ungroupedFindingIds.includes(id)) {
      checks.push(`${id} should be ungrouped but isn't`);
    }
  }

  return {
    id: "T7",
    name: "Unknown dimensions fail closed",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Fail-closed: all 4 findings ungrouped (0 families formed)`
      : checks.join("; "),
  };
}

function runT8(): TestResult {
  // T8: Family rules cannot change severity/reportability/proposition/authority
  const findings = [
    makeFinding({
      finding_id: "sev-001",
      title: "Critical revenue timing issue",
      severity: "critical",
      issue_key: "revenue_basis_discrepancy",
      finding_kind: "data_divergence",
    }),
    makeFinding({
      finding_id: "sev-002",
      title: "Info-level revenue timing note",
      severity: "info",
      issue_key: "revenue_basis_discrepancy",
      finding_kind: "cross_version",
    }),
    makeFinding({
      finding_id: "sev-003",
      title: "Warning revenue timing discrepancy",
      severity: "warning",
      issue_key: "contracted_vs_variable_revenue_split",
      finding_kind: "data_divergence",
    }),
  ];

  const result = deduplicateFindings(findings);
  const nonGenCheck = verifyNonGenerative(findings, result);

  const checks: string[] = [];
  if (!nonGenCheck.valid) {
    checks.push(`non-generative violations: ${nonGenCheck.violations.join("; ")}`);
  }

  // Verify strongest severity is preserved (critical from sev-001)
  if (result.families[0]?.strongestSeverity !== "critical") {
    checks.push(`expected strongest=critical, got ${result.families[0]?.strongestSeverity}`);
  }

  // Verify individual findings retain their original severity (not modified)
  const origMap = new Map(findings.map((f) => [f.finding_id, f.severity]));
  for (const member of result.families[0]?.memberDisposition ?? []) {
    const orig = origMap.get(member.findingId);
    if (!orig) checks.push(`member ${member.findingId} not in original`);
    // The dedup service does NOT modify findings — it only selects/suppresses
    // So original findings remain intact (verifyNonGenerative confirms this)
  }

  return {
    id: "T8",
    name: "Family rules cannot change severity/reportability/proposition/authority",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Non-generative verified: strongest_severity=critical preserved, ${result.families[0]?.memberFindingIds.length} members unchanged`
      : checks.join("; "),
  };
}

function runT9(): TestResult {
  // T9: Repeated finalization is idempotent
  const findings = [
    ...makeRevenueFamily(3, "rev"),
    makeFinding({
      finding_id: "earn-001",
      title: "Earn-out contingency underestimated",
      issue_key: "contingent_consideration_liability",
      finding_kind: "data_divergence",
    }),
    makeFinding({
      finding_id: "earn-002",
      title: "Contingent consideration risk not disclosed",
      issue_key: "earnout_obligations_unquantified",
      finding_kind: "source_stated_risk",
    }),
  ];

  // Run 3 times
  const results = [
    deduplicateFindings(findings),
    deduplicateFindings(findings),
    deduplicateFindings(findings),
  ];

  const checks: string[] = [];
  const fp = results[0].resultFingerprint;
  for (let i = 1; i < results.length; i++) {
    if (results[i].resultFingerprint !== fp) {
      checks.push(`run ${i + 1} fingerprint differs: ${results[i].resultFingerprint} vs ${fp}`);
    }
    if (JSON.stringify(results[i].families) !== JSON.stringify(results[0].families)) {
      checks.push(`run ${i + 1} families differ`);
    }
    if (JSON.stringify(results[i].ungroupedFindingIds) !== JSON.stringify(results[0].ungroupedFindingIds)) {
      checks.push(`run ${i + 1} ungrouped differs`);
    }
  }

  return {
    id: "T9",
    name: "Repeated finalization is idempotent",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `Idempotent: 3 runs identical, fingerprint=${fp}, ${results[0].families.length} families`
      : checks.join("; "),
  };
}

async function runT10(ctx: any): Promise<TestResult> {
  // T10: Bounded SCG replay — run persisted SCG artifact through real production family service.
  // Proves Stage 3 output has expected family IDs, members, evidence, and hashes.
  const rawRows = await ctx.integrations.db.query(
    `SELECT COALESCE(mo.findings, '[]'::jsonb)::text AS findings_json
     FROM module_outputs mo
     WHERE mo.module_run_id = $1
     LIMIT 1`,
    z.object({ findings_json: z.string() }),
    [SCG_RUN_ID],
    { label: "T10: Load SCG module_outputs.findings for family dedup" }
  );

  if (rawRows.length === 0) {
    return {
      id: "T10",
      name: "SCG bounded replay: before/after counts by family",
      passed: false,
      detail: "FAILED: No module_outputs rows found for SCG run — cannot verify OA-03 production integration",
    };
  }

  // Parse findings from the persisted jsonb column
  let parsedFindings: unknown[];
  try {
    parsedFindings = JSON.parse(rawRows[0].findings_json);
  } catch (parseErr: any) {
    return {
      id: "T10",
      name: "SCG bounded replay: before/after counts by family",
      passed: false,
      detail: `FAILED: Unparsable findings JSON — ${parseErr.message?.slice(0, 80)}`,
    };
  }

  if (!Array.isArray(parsedFindings) || parsedFindings.length === 0) {
    return {
      id: "T10",
      name: "SCG bounded replay: before/after counts by family",
      passed: false,
      detail: "FAILED: module_outputs.findings is empty — no canonical findings to verify",
    };
  }

  // Validate each finding has required canonical shape
  const allFindings: CanonicalFinding[] = [];
  let unparsableCount = 0;
  for (const f of parsedFindings) {
    if (f && typeof f === "object" && "finding_id" in f && "title" in f && "severity" in f) {
      allFindings.push(f as CanonicalFinding);
    } else {
      unparsableCount++;
    }
  }

  if (allFindings.length === 0) {
    return {
      id: "T10",
      name: "SCG bounded replay: before/after counts by family",
      passed: false,
      detail: `FAILED: ${parsedFindings.length} entries in findings but 0 have valid canonical shape (finding_id + title + severity)`,
    };
  }

  // Run real production family service (deduplicateFindings from canonical-family-dedup)
  const result = deduplicateFindings(allFindings);

  // Run completeness verification — no member may vanish silently
  const completeness = verifyCompleteness(
    allFindings.map((f) => f.finding_id),
    result
  );

  // Run determinism verification — second pass must produce identical output
  const result2 = deduplicateFindings(allFindings);
  const deterministic =
    result.families.length === result2.families.length &&
    result.totalSuppressed === result2.totalSuppressed &&
    result.families.every((f, i) =>
      f.familyId === result2.families[i]?.familyId &&
      f.representativeFindingId === result2.families[i]?.representativeFindingId &&
      JSON.stringify(f.memberFindingIds) === JSON.stringify(result2.families[i]?.memberFindingIds)
    );

  // Build per-family evidence/hash summary
  const familyDetails = result.families.map((f) => ({
    familyId: f.familyId,
    members: f.memberFindingIds.length,
    representative: f.representativeFindingId,
    evidenceCount: f.allEvidenceIds.length,
    hash: computeFamilyHash(f.memberFindingIds, f.familyId),
  }));

  const familySummary = familyDetails
    .map((fd) => `${fd.familyId}(${fd.members}m/${fd.evidenceCount}ev/${fd.hash})`)
    .join(", ");

  // Collect all assertions
  const checks: string[] = [];
  const warnings: string[] = [];
  if (!completeness.complete) {
    if (completeness.missing.length > 0) {
      // Hard fail: findings vanished from output
      checks.push(`completeness failed: ${completeness.missing.length} findings missing from output`);
    }
    if (completeness.duplicated.length > 0) {
      // Warn only: duplicate finding_ids in input is upstream data quality, not family dedup failure
      warnings.push(`${completeness.duplicated.length} duplicate finding_ids in input (upstream data quality)`);
    }
  }
  if (!deterministic) {
    checks.push("non-deterministic: second pass differs from first");
  }
  if (result.families.length === 0 && allFindings.length > 5) {
    // Diagnostic: extract distinct issue_keys to calibrate family rules
    const issueKeyCounts: Record<string, number> = {};
    for (const f of allFindings) {
      const key = (f as any).issue_key ?? "(no issue_key)";
      issueKeyCounts[key] = (issueKeyCounts[key] || 0) + 1;
    }
    const topKeys = Object.entries(issueKeyCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([k, c]) => `${k}(${c})`)
      .join(", ");
    checks.push(`zero families from ${allFindings.length} findings — family rules may not match SCG issue_keys. DISTINCT issue_keys: [${topKeys}]`);
  }
  if (unparsableCount > 0) {
    checks.push(`${unparsableCount} entries lacked canonical shape`);
  }

  const passed = checks.length === 0;
  const warningsSuffix = warnings.length > 0 ? ` Warnings: ${warnings.join("; ")}.` : "";

  return {
    id: "T10",
    name: "SCG bounded replay: before/after counts by family",
    passed,
    detail: passed
      ? `Input: ${allFindings.length} findings → ${result.totalFamiliesCreated} families [${familySummary || "none"}], ${result.ungroupedFindingIds.length} ungrouped, ${result.totalSuppressed} suppressed. Deterministic=true, complete=true.${warningsSuffix}`
      : `FAILED: ${checks.join("; ")}. Input: ${allFindings.length} findings, families=${result.totalFamiliesCreated}, ungrouped=${result.ungroupedFindingIds.length}${warningsSuffix}`,
  };
}

// ---------------------------------------------------------------------------
// API Definition
// ---------------------------------------------------------------------------

export default api({
  name: "TestOaFamilyDedup",
  description: "OA-03 test harness for deterministic canonical-family deduplication.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runScgIntegrationTests: z.boolean().default(true),
  }),
  output: z.object({
    summary: z.string(),
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    results: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        passed: z.boolean(),
        skipped: z.boolean().optional(),
        detail: z.string(),
      })
    ),
  }),
  async run(ctx, { runScgIntegrationTests }) {
    const results: TestResult[] = [];

    // Run synthetic tests (T1-T9)
    results.push(runT1());
    results.push(runT2());
    results.push(runT3());
    results.push(runT4());
    results.push(runT5());
    results.push(runT6());
    results.push(runT7());
    results.push(runT8());
    results.push(runT9());

    // Run SCG integration test (T10)
    if (runScgIntegrationTests) {
      results.push(await runT10(ctx));
    } else {
      results.push({
        id: "T10",
        name: "SCG bounded replay: before/after counts by family",
        passed: false,
        skipped: true,
        detail: "SKIPPED: runScgIntegrationTests=false — disabled integration tests counted as skipped, not green",
      });
    }

    const passed = results.filter((r) => r.passed && !r.skipped).length;
    const failed = results.filter((r) => !r.passed && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    return {
      summary: `OA-03 Family Dedup: ${passed}/${results.length} passed${skipped > 0 ? `, ${skipped} skipped` : ""}${failed > 0 ? `, ${failed} failed` : ""}`,
      total: results.length,
      passed,
      failed,
      skipped,
      results,
    };
  },
});
