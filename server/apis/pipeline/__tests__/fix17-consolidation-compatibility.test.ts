/**
 * Fix 17 — Deterministic Consolidation Compatibility Gates
 *
 * Saint-specific fixture tests verifying that consolidation requires structured
 * identity compatibility, not just shared claim_id or issue_key.
 *
 * Tests:
 * 1. FCA / section 19 duplicates consolidate (same identity).
 * 2. One Park Lane findings consolidate only when same clause and consequence.
 * 3. Change-of-control duplicates consolidate.
 * 4. 1954 Act duplicates consolidate.
 * 5. IP assignment and IP licence remain separate (distinct ownership risks).
 * 6. GDPR, cookies, and consent merge only when same underlying obligation.
 * 7. Different memo/model numeric discrepancies remain separate by metric and period.
 * 8. Same claim ID with different metric or period does not merge.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix17-consolidation-compatibility.test.ts
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

// Simulate the compatibility gate logic from pipeline-core.ts
interface TestFinding {
  finding_id: string;
  title: string;
  severity: "critical" | "warning" | "info";
  claim_ids?: string[];
  issue_key?: string;
  finding_kind?: string;
  metric?: string;
  period?: string;
  scope?: string;
  entity?: string;
  currency?: string;
  legal_clause?: string;
  legal_consequence?: string;
  impact_type?: string;
  affected_asset?: string;
  accounting_basis?: string;
  actual_vs_forecast?: string;
  counterparty?: string;
  contract_provision?: string;
  [key: string]: unknown;
}

function areCompatibleForMerge(a: TestFinding, b: TestFinding): boolean {
  const gateFields: Array<{ key: string; normalize?: (v: string) => string }> = [
    { key: "finding_kind" },
    { key: "metric", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "period", normalize: (v: string) => v.toLowerCase().trim().replace(/\s+/g, "") },
    { key: "scope", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "entity", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "currency" },
    { key: "legal_clause", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "legal_consequence", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "impact_type", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "affected_asset", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "accounting_basis", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "actual_vs_forecast", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "counterparty", normalize: (v: string) => v.toLowerCase().trim() },
    { key: "contract_provision", normalize: (v: string) => v.toLowerCase().trim() },
  ];

  for (const { key, normalize } of gateFields) {
    const valA = (a as any)[key];
    const valB = (b as any)[key];
    if (!valA || !valB) continue;
    if (typeof valA !== "string" || typeof valB !== "string") continue;
    const normA = normalize ? normalize(valA) : valA;
    const normB = normalize ? normalize(valB) : valB;
    if (normA !== normB) return false;
  }

  return true;
}

function consolidateWithGates(findings: TestFinding[]): TestFinding[][] {
  const parent: number[] = findings.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Cluster by claim_ids with compatibility check
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
    for (let k = 1; k < indices.length; k++) {
      if (areCompatibleForMerge(findings[indices[0]], findings[indices[k]])) {
        union(indices[0], indices[k]);
      }
    }
  }

  // Cluster by issue_key with compatibility check
  const issueKeyToIndices = new Map<string, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const ik = findings[i].issue_key;
    if (!ik) continue;
    const norm = ik.toLowerCase().trim().replace(/[\s-]+/g, "_");
    const existing = issueKeyToIndices.get(norm);
    if (existing) existing.push(i); else issueKeyToIndices.set(norm, [i]);
  }
  for (const indices of issueKeyToIndices.values()) {
    for (let k = 1; k < indices.length; k++) {
      if (areCompatibleForMerge(findings[indices[0]], findings[indices[k]])) {
        union(indices[0], indices[k]);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const root = find(i);
    const existing = clusters.get(root);
    if (existing) existing.push(i); else clusters.set(root, [i]);
  }

  return Array.from(clusters.values()).map(members => members.map(i => findings[i]));
}

// --- Test 1: FCA / section 19 duplicates consolidate ---
console.log("Test 1: FCA / section 19 duplicates consolidate (same identity)");
{
  const findings: TestFinding[] = [
    { finding_id: "fca-1", title: "FCA Section 19", severity: "critical",
      issue_key: "fca_authorisation_risk", legal_clause: "section 19", legal_consequence: "criminal offence" },
    { finding_id: "fca-2", title: "FCA Permission Gap", severity: "warning",
      issue_key: "fca_authorisation_risk", legal_clause: "section 19", legal_consequence: "criminal offence" },
  ];
  const clusters = consolidateWithGates(findings);
  assertEqual(clusters.length, 1, "FCA findings merge into 1 cluster");
  console.log("  ✓ FCA duplicates consolidate");
}

// --- Test 2: One Park Lane — same clause merges, different clause stays separate ---
console.log("Test 2: One Park Lane — same clause merges, different clause stays separate");
{
  const findings: TestFinding[] = [
    { finding_id: "opl-1", title: "OPL Lease Renewal", severity: "critical",
      issue_key: "one_park_lane_risk", legal_clause: "break clause 4.2", legal_consequence: "lease termination",
      affected_asset: "One Park Lane" },
    { finding_id: "opl-2", title: "OPL Break Clause", severity: "warning",
      issue_key: "one_park_lane_risk", legal_clause: "break clause 4.2", legal_consequence: "lease termination",
      affected_asset: "One Park Lane" },
    { finding_id: "opl-3", title: "OPL Dilapidations", severity: "warning",
      issue_key: "one_park_lane_risk", legal_clause: "schedule 3 dilapidations", legal_consequence: "financial liability",
      affected_asset: "One Park Lane" },
  ];
  const clusters = consolidateWithGates(findings);
  assertEqual(clusters.length, 2, "OPL: 2 clusters (same clause vs different clause)");
  const clusterSizes = clusters.map(c => c.length).sort();
  assertEqual(clusterSizes, [1, 2], "One cluster of 2 (break clause) + one of 1 (dilapidations)");
  console.log("  ✓ OPL: same clause merges, different clause stays separate");
}

// --- Test 3: Change-of-control duplicates consolidate ---
console.log("Test 3: Change-of-control duplicates consolidate");
{
  const findings: TestFinding[] = [
    { finding_id: "coc-1", title: "CoC Consent Required", severity: "critical",
      issue_key: "change_of_control", legal_clause: "clause 12.1", contract_provision: "change of control" },
    { finding_id: "coc-2", title: "CoC Risk", severity: "warning",
      issue_key: "change_of_control", legal_clause: "clause 12.1", contract_provision: "change of control" },
  ];
  const clusters = consolidateWithGates(findings);
  assertEqual(clusters.length, 1, "CoC findings merge into 1 cluster");
  console.log("  ✓ Change-of-control duplicates consolidate");
}

// --- Test 4: 1954 Act duplicates consolidate ---
console.log("Test 4: 1954 Act duplicates consolidate");
{
  const findings: TestFinding[] = [
    { finding_id: "act-1", title: "Landlord & Tenant Act 1954", severity: "warning",
      issue_key: "1954_act_exposure", legal_clause: "part II LTA 1954" },
    { finding_id: "act-2", title: "1954 Act Protection", severity: "info",
      issue_key: "1954_act_exposure", legal_clause: "part II LTA 1954" },
  ];
  const clusters = consolidateWithGates(findings);
  assertEqual(clusters.length, 1, "1954 Act findings merge into 1 cluster");
  console.log("  ✓ 1954 Act duplicates consolidate");
}

// --- Test 5: IP assignment vs IP licence remain separate ---
console.log("Test 5: IP assignment and IP licence remain separate");
{
  const findings: TestFinding[] = [
    { finding_id: "ip-1", title: "IP Assignment Gap", severity: "critical",
      issue_key: "ip_ownership_risk", impact_type: "ownership transfer",
      legal_clause: "assignment deed", affected_asset: "core software IP" },
    { finding_id: "ip-2", title: "IP Licence Restriction", severity: "warning",
      issue_key: "ip_ownership_risk", impact_type: "licence limitation",
      legal_clause: "licence agreement s3", affected_asset: "third-party SDK" },
  ];
  const clusters = consolidateWithGates(findings);
  assertEqual(clusters.length, 2, "IP findings remain separate (different impact_type, clause, asset)");
  console.log("  ✓ IP assignment and licence remain separate");
}

// --- Test 6: GDPR merge only on same obligation ---
console.log("Test 6: GDPR findings merge only when same underlying obligation");
{
  const findings: TestFinding[] = [
    { finding_id: "gdpr-1", title: "GDPR Data Transfers", severity: "critical",
      issue_key: "gdpr_compliance", legal_clause: "article 46 SCCs", legal_consequence: "regulatory fine" },
    { finding_id: "gdpr-2", title: "GDPR Transfer Impact", severity: "warning",
      issue_key: "gdpr_compliance", legal_clause: "article 46 SCCs", legal_consequence: "regulatory fine" },
    { finding_id: "gdpr-3", title: "Cookie Consent", severity: "info",
      issue_key: "gdpr_compliance", legal_clause: "PECR regulation 6", legal_consequence: "ICO enforcement" },
  ];
  const clusters = consolidateWithGates(findings);
  assertEqual(clusters.length, 2, "GDPR: 2 clusters (transfers vs cookies)");
  console.log("  ✓ GDPR: same obligation merges, different obligation stays separate");
}

// --- Test 7: Different numeric discrepancies by metric and period ---
console.log("Test 7: Different numeric discrepancies remain separate by metric and period");
{
  const findings: TestFinding[] = [
    { finding_id: "num-1", title: "Revenue FY2024", severity: "critical",
      issue_key: "financial_divergence", metric: "revenue", period: "FY2024", currency: "GBP" },
    { finding_id: "num-2", title: "EBITDA FY2024", severity: "warning",
      issue_key: "financial_divergence", metric: "ebitda", period: "FY2024", currency: "GBP" },
    { finding_id: "num-3", title: "Revenue FY2025", severity: "warning",
      issue_key: "financial_divergence", metric: "revenue", period: "FY2025", currency: "GBP" },
  ];
  const clusters = consolidateWithGates(findings);
  assertEqual(clusters.length, 3, "All 3 stay separate (different metric or period)");
  console.log("  ✓ Different metrics/periods remain separate");
}

// --- Test 8: Same claim ID with different metric or period does not merge ---
console.log("Test 8: Same claim ID with different metric or period does not merge");
{
  const sharedClaim = "doc123:abc:0:5";
  const findings: TestFinding[] = [
    { finding_id: "sc-1", title: "Revenue Gap", severity: "critical",
      claim_ids: [sharedClaim], metric: "revenue", period: "FY2024" },
    { finding_id: "sc-2", title: "Margin Gap", severity: "warning",
      claim_ids: [sharedClaim], metric: "gross_margin", period: "FY2024" },
  ];
  const clusters = consolidateWithGates(findings);
  assertEqual(clusters.length, 2, "Same claim_id but different metric: stay separate");
  console.log("  ✓ Same claim ID with different metric does not merge");
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n✗ Fix 17 tests FAILED");
  process.exit(1);
}
console.log("\n✅ All 8 Fix 17 tests passed.");
process.exit(0);
