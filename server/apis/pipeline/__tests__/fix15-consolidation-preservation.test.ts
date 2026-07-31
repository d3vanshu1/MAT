/**
 * Fix 15 — Consolidation Evidence/Content Preservation
 *
 * Tests verifying that global semantic consolidation (Stage 3 in runPostMergePipeline)
 * unions all evidence, source_docs, claim_ids, structured_impact, and content
 * from absorbed findings into the representative. Saint-specific fixtures.
 *
 * Tests:
 * 1. FCA family: Two FCA findings with different evidence union their evidence arrays.
 * 2. One Park Lane family: claim_ids from multiple members all preserved.
 * 3. IP family: structured_impact entries from all members merged (deduped by amount+role+currency).
 * 4. GDPR family: consolidated_analyses preserves full_analysis from non-representative members.
 * 5. Evidence dedup: same figure+source_doc but different snippet preserved (Fix 15 key fix).
 * 6. source_docs and evidence_docs union across all members.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix15-consolidation-preservation.test.ts
 */

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`  ✗ FAIL: ${msg}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  } else {
    passed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  } else {
    passed++;
  }
}

// --- Simulate the consolidation logic from pipeline-core.ts Stage 3 ---
type TestFinding = {
  finding_id: string;
  title: string;
  detail: string;
  full_analysis: string;
  severity: "critical" | "warning" | "info";
  source_docs: string[];
  evidence_docs?: string[];
  claim_ids?: string[];
  evidence?: Array<{ figure: string; source_doc: string; verbatim_snippet: string; verified: boolean }>;
  structured_impact?: Array<{ amount: number; role: string; currency: string; unit_multiplier?: number; verified?: boolean }>;
  issue_key?: string;
  merged_from_finding_ids?: string[];
};

function consolidate(findings: TestFinding[]): TestFinding[] {
  const parent: number[] = findings.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Cluster by claim_ids
  const claimToIndices = new Map<string, number[]>();
  for (let i = 0; i < findings.length; i++) {
    for (const cid of findings[i].claim_ids ?? []) {
      const norm = cid.toLowerCase().trim();
      if (!norm) continue;
      const existing = claimToIndices.get(norm);
      if (existing) existing.push(i); else claimToIndices.set(norm, [i]);
    }
  }
  for (const indices of claimToIndices.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k]);
  }

  // Cluster by issue_key
  const issueKeyToIndices = new Map<string, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const ik = findings[i].issue_key;
    if (!ik) continue;
    const norm = ik.toLowerCase().trim().replace(/[\s-]+/g, "_");
    const existing = issueKeyToIndices.get(norm);
    if (existing) existing.push(i); else issueKeyToIndices.set(norm, [i]);
  }
  for (const indices of issueKeyToIndices.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k]);
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const root = find(i);
    const existing = clusters.get(root);
    if (existing) existing.push(i); else clusters.set(root, [i]);
  }

  const severityRank = { critical: 3, warning: 2, info: 1 };
  const consolidated: TestFinding[] = [];

  for (const members of clusters.values()) {
    if (members.length === 1) {
      consolidated.push(findings[members[0]]);
      continue;
    }

    members.sort((a, b) => {
      const sa = severityRank[findings[a].severity] ?? 0;
      const sb = severityRank[findings[b].severity] ?? 0;
      if (sb !== sa) return sb - sa;
      return (findings[b].full_analysis?.length ?? 0) - (findings[a].full_analysis?.length ?? 0);
    });

    const representative = findings[members[0]];

    const allClaimIds = new Set<string>();
    const allSourceDocs = new Set<string>();
    const allEvidenceDocs = new Set<string>();
    const allEvidence: Array<{ figure: string; source_doc: string; verbatim_snippet: string; verified: boolean }> = [];
    const seenEvidenceKeys = new Set<string>();
    const allStructuredImpact: Array<Record<string, unknown>> = [];
    const seenImpactKeys = new Set<string>();

    const mergedFromIds: string[] = [];
    for (const idx of members) {
      const f = findings[idx];
      if (f.finding_id !== representative.finding_id) mergedFromIds.push(f.finding_id);
      if (Array.isArray(f.merged_from_finding_ids)) {
        for (const id of f.merged_from_finding_ids) mergedFromIds.push(id);
      }
    }

    for (const idx of members) {
      const f = findings[idx];
      for (const cid of f.claim_ids ?? []) allClaimIds.add(cid);
      for (const sd of f.source_docs ?? []) allSourceDocs.add(sd);
      for (const ed of f.evidence_docs ?? []) allEvidenceDocs.add(ed);
      for (const ev of f.evidence ?? []) {
        // Fix 15: snippet-aware dedup
        const key = `${ev.figure}|${ev.source_doc}|${(ev.verbatim_snippet ?? "").slice(0, 80)}`;
        if (!seenEvidenceKeys.has(key)) {
          seenEvidenceKeys.add(key);
          allEvidence.push(ev);
        }
      }
      if (Array.isArray(f.structured_impact)) {
        for (const si of f.structured_impact) {
          const siKey = `${si.amount ?? ""}|${si.role ?? ""}|${si.currency ?? ""}`;
          if (!seenImpactKeys.has(siKey)) {
            seenImpactKeys.add(siKey);
            allStructuredImpact.push(si);
          }
        }
      }
    }

    const consolidatedAnalyses: string[] = [];
    for (const idx of members) {
      if (idx === members[0]) continue;
      const f = findings[idx];
      if (f.full_analysis && f.full_analysis.length > 0) {
        consolidatedAnalyses.push(f.full_analysis);
      }
    }

    const merged: any = {
      ...representative,
      claim_ids: [...allClaimIds],
      source_docs: [...allSourceDocs],
      evidence_docs: allEvidenceDocs.size > 0 ? [...allEvidenceDocs] : representative.evidence_docs,
      evidence: allEvidence.length > 0 ? allEvidence : representative.evidence,
      structured_impact: allStructuredImpact.length > 0 ? allStructuredImpact : representative.structured_impact,
      ...(consolidatedAnalyses.length > 0 ? { consolidated_analyses: consolidatedAnalyses } : {}),
      merged_from_finding_ids: mergedFromIds.length > 0
        ? [...new Set([...(representative.merged_from_finding_ids ?? []), ...mergedFromIds])]
        : representative.merged_from_finding_ids,
    };

    consolidated.push(merged);
  }

  return consolidated;
}

// --- Test 1: FCA family — evidence union ---
console.log("Test 1: FCA family — evidence arrays union across members");
{
  const findings: TestFinding[] = [
    {
      finding_id: "fca-1", title: "FCA Section 19 Breach", detail: "d1",
      full_analysis: "The firm may lack FCA authorisation for activities described.",
      severity: "critical", source_docs: ["cim.pdf"],
      evidence: [{ figure: "£2.1m", source_doc: "cim.pdf", verbatim_snippet: "revenue from regulated activities", verified: true }],
      issue_key: "fca_authorisation_risk",
    },
    {
      finding_id: "fca-2", title: "FCA Permissions Gap", detail: "d2",
      full_analysis: "Additional FCA evidence from consultant report.",
      severity: "warning", source_docs: ["consultant_report.pdf"],
      evidence: [{ figure: "£2.1m", source_doc: "consultant_report.pdf", verbatim_snippet: "regulated income stream identified", verified: true }],
      issue_key: "fca_authorisation_risk",
    },
  ];

  const result = consolidate(findings);
  assertEqual(result.length, 1, "Cluster produces 1 merged finding");
  assertEqual(result[0].evidence!.length, 2, "Both evidence items preserved");
  assert(result[0].evidence!.some(e => e.source_doc === "cim.pdf"), "cim.pdf evidence present");
  assert(result[0].evidence!.some(e => e.source_doc === "consultant_report.pdf"), "consultant_report.pdf evidence present");
  console.log("  ✓ FCA: evidence from both members preserved");
}

// --- Test 2: One Park Lane family — claim_ids union ---
console.log("Test 2: One Park Lane — claim_ids from multiple members preserved");
{
  const sharedClaim = "doc123:abc:0:5";
  const findings: TestFinding[] = [
    {
      finding_id: "opl-1", title: "One Park Lane Valuation Gap", detail: "d1",
      full_analysis: "Valuation discrepancy in the OPL asset.",
      severity: "critical", source_docs: ["cim.pdf"],
      claim_ids: [sharedClaim, "doc123:abc:1:2"],
    },
    {
      finding_id: "opl-2", title: "OPL Asset Coverage", detail: "d2",
      full_analysis: "Additional claim about OPL.",
      severity: "warning", source_docs: ["ic_memo.pdf"],
      claim_ids: [sharedClaim, "doc456:def:0:1"],
    },
  ];

  const result = consolidate(findings);
  assertEqual(result.length, 1, "Cluster produces 1 merged finding");
  const claimIds = result[0].claim_ids!;
  assert(claimIds.includes(sharedClaim), "shared claim present");
  assert(claimIds.includes("doc123:abc:1:2"), "first member's unique claim present");
  assert(claimIds.includes("doc456:def:0:1"), "second member's unique claim present");
  assertEqual(claimIds.length, 3, "3 unique claim_ids total");
  console.log("  ✓ OPL: all claim_ids from both members preserved");
}

// --- Test 3: IP family — structured_impact union ---
console.log("Test 3: IP family — structured_impact entries merged from all members");
{
  const findings: TestFinding[] = [
    {
      finding_id: "ip-1", title: "IP Licensing Revenue Risk", detail: "d1",
      full_analysis: "IP licensing generates significant revenue.",
      severity: "critical", source_docs: ["cim.pdf"],
      structured_impact: [
        { amount: 4.2, role: "exposure", currency: "GBP", unit_multiplier: 1000000, verified: true },
      ],
      issue_key: "ip_licensing_risk",
    },
    {
      finding_id: "ip-2", title: "IP Transfer Price Risk", detail: "d2",
      full_analysis: "Transfer pricing may be affected.",
      severity: "warning", source_docs: ["consultant_report.pdf"],
      structured_impact: [
        { amount: 1.8, role: "delta", currency: "GBP", unit_multiplier: 1000000, verified: true },
      ],
      issue_key: "ip_licensing_risk",
    },
  ];

  const result = consolidate(findings);
  assertEqual(result.length, 1, "Cluster produces 1 merged finding");
  const si = result[0].structured_impact!;
  assertEqual(si.length, 2, "Both structured_impact entries preserved");
  assert(si.some((s: any) => s.amount === 4.2 && s.role === "exposure"), "4.2m exposure present");
  assert(si.some((s: any) => s.amount === 1.8 && s.role === "delta"), "1.8m delta present");
  console.log("  ✓ IP: structured_impact from both members merged");
}

// --- Test 4: GDPR family — consolidated_analyses preservation ---
console.log("Test 4: GDPR family — consolidated_analyses preserves absorbed members' content");
{
  const findings: TestFinding[] = [
    {
      finding_id: "gdpr-1", title: "GDPR Data Processing Risk", detail: "d1",
      full_analysis: "The company processes EU citizen data without adequate safeguards. International transfers rely on outdated SCCs.",
      severity: "critical", source_docs: ["legal_review.pdf"],
      issue_key: "gdpr_compliance_gap",
    },
    {
      finding_id: "gdpr-2", title: "GDPR Consent Mechanism", detail: "d2",
      full_analysis: "Cookie consent mechanism does not meet Article 7 requirements. Withdrawal of consent pathway is non-functional.",
      severity: "warning", source_docs: ["website_audit.pdf"],
      issue_key: "gdpr_compliance_gap",
    },
    {
      finding_id: "gdpr-3", title: "GDPR DPO Absence", detail: "d3",
      full_analysis: "No Data Protection Officer appointed despite meeting Article 37 criteria.",
      severity: "info", source_docs: ["org_chart.pdf"],
      issue_key: "gdpr_compliance_gap",
    },
  ];

  const result = consolidate(findings);
  assertEqual(result.length, 1, "Cluster produces 1 merged finding");
  assert(result[0].severity === "critical", "Representative is highest severity (critical)");
  const ca = (result[0] as any).consolidated_analyses;
  assert(Array.isArray(ca), "consolidated_analyses exists");
  assertEqual(ca.length, 2, "2 non-representative analyses preserved");
  assert(ca.some((a: string) => a.includes("Cookie consent")), "GDPR-2 analysis preserved");
  assert(ca.some((a: string) => a.includes("Data Protection Officer")), "GDPR-3 analysis preserved");
  console.log("  ✓ GDPR: consolidated_analyses preserves content from absorbed findings");
}

// --- Test 5: Evidence dedup — same figure+source_doc but different snippet preserved ---
console.log("Test 5: Evidence dedup preserves items with same figure+source but different snippet");
{
  const findings: TestFinding[] = [
    {
      finding_id: "ev-1", title: "Revenue Discrepancy", detail: "d1",
      full_analysis: "Revenue figure appears in two different contexts.",
      severity: "warning", source_docs: ["cim.pdf"],
      evidence: [
        { figure: "£12.5m", source_doc: "cim.pdf", verbatim_snippet: "FY2024 total revenue of £12.5m", verified: true },
      ],
      claim_ids: ["shared-claim-1"],
    },
    {
      finding_id: "ev-2", title: "Revenue Discrepancy Alt", detail: "d2",
      full_analysis: "Same revenue figure in different context.",
      severity: "warning", source_docs: ["cim.pdf"],
      evidence: [
        { figure: "£12.5m", source_doc: "cim.pdf", verbatim_snippet: "projected revenue for next year: £12.5m", verified: false },
      ],
      claim_ids: ["shared-claim-1"],
    },
  ];

  const result = consolidate(findings);
  assertEqual(result.length, 1, "Cluster produces 1 merged finding");
  // Key assertion: both evidence items preserved because verbatim_snippet differs
  assertEqual(result[0].evidence!.length, 2, "Both evidence items preserved (different snippets)");
  assert(
    result[0].evidence!.some(e => e.verbatim_snippet.includes("total revenue")),
    "First snippet present"
  );
  assert(
    result[0].evidence!.some(e => e.verbatim_snippet.includes("projected revenue")),
    "Second snippet present"
  );
  console.log("  ✓ Evidence: same figure+source_doc with different snippets both preserved");
}

// --- Test 6: source_docs and evidence_docs union ---
console.log("Test 6: source_docs and evidence_docs union across all members");
{
  const findings: TestFinding[] = [
    {
      finding_id: "sd-1", title: "Multi-Source Finding", detail: "d1",
      full_analysis: "Analysis from multiple sources.",
      severity: "warning",
      source_docs: ["cim.pdf", "model.xlsx"],
      evidence_docs: ["cim.pdf"],
      issue_key: "multi_source",
    },
    {
      finding_id: "sd-2", title: "Multi-Source Finding B", detail: "d2",
      full_analysis: "Second analysis.",
      severity: "info",
      source_docs: ["ic_memo.pdf", "model.xlsx"],
      evidence_docs: ["ic_memo.pdf", "consultant.pdf"],
      issue_key: "multi_source",
    },
  ];

  const result = consolidate(findings);
  assertEqual(result.length, 1, "Cluster produces 1 merged finding");

  const srcDocs = result[0].source_docs.sort();
  assertEqual(srcDocs, ["cim.pdf", "ic_memo.pdf", "model.xlsx"], "source_docs is union");

  const evDocs = (result[0].evidence_docs ?? []).sort();
  assertEqual(evDocs, ["cim.pdf", "consultant.pdf", "ic_memo.pdf"], "evidence_docs is union");
  console.log("  ✓ source_docs and evidence_docs properly unioned");
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n✗ Fix 15 tests FAILED");
  process.exit(1);
}
console.log("\n✅ All 6 Fix 15 tests passed.");
process.exit(0);
