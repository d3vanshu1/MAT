/**
 * Corrective F — Tests for consolidation compatibility derived from
 * canonical structured identity (evidence + structured_impact arrays).
 *
 * Run: npx tsx server/apis/pipeline/__tests__/corrective-f-structured-identity.test.ts
 */

import {
  extractFindingIdentity,
  findingIdentitiesAreCompatible,
} from "../pipeline-core.js";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; } else { console.log(`PASS: ${msg}`); passed++; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a finding with evidence-derived identity */
function makeFinding(opts: {
  finding_kind?: string;
  metric?: string;
  period?: string;
  scope?: string;
  entity?: string;
  legal_clause?: string;
  legal_consequence?: string;
  evidence?: Array<Record<string, any>>;
  structured_impact?: Array<Record<string, any>>;
  claim_ids?: string[];
  issue_key?: string;
  title?: string;
}) {
  return {
    finding_id: crypto.randomUUID?.() ?? Math.random().toString(36),
    severity: "warning",
    title: opts.title ?? "Test finding",
    detail: "test detail",
    full_analysis: "test analysis",
    source_docs: ["doc.pdf"],
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// --- Test 1: Same claim_id but different periods remains separate ---
{
  const findingA = makeFinding({
    claim_ids: ["shared-claim-1"],
    evidence: [{ metric: "revenue", period: "FY2024", scope: "group", sheet_or_page: "P&L" }],
  });
  const findingB = makeFinding({
    claim_ids: ["shared-claim-1"],
    evidence: [{ metric: "revenue", period: "FY2025", scope: "group", sheet_or_page: "P&L" }],
  });

  const idA = extractFindingIdentity(findingA);
  const idB = extractFindingIdentity(findingB);
  const compatible = findingIdentitiesAreCompatible(idA, idB);
  assert(!compatible, "Test 1: Same claim_id but different periods → incompatible");
}

// --- Test 2: Same claim_id but different metrics remains separate ---
{
  const findingA = makeFinding({
    claim_ids: ["shared-claim-2"],
    evidence: [{ metric: "revenue", period: "FY2024", scope: "group" }],
  });
  const findingB = makeFinding({
    claim_ids: ["shared-claim-2"],
    evidence: [{ metric: "ebitda", period: "FY2024", scope: "group" }],
  });

  const idA = extractFindingIdentity(findingA);
  const idB = extractFindingIdentity(findingB);
  const compatible = findingIdentitiesAreCompatible(idA, idB);
  assert(!compatible, "Test 2: Same claim_id but different metrics → incompatible");
}

// --- Test 3: Same issue_key but different sheets/cells remains separate ---
{
  const findingA = makeFinding({
    issue_key: "revenue_discrepancy",
    evidence: [{ metric: "revenue", period: "FY2024", sheet_or_page: "P&L", cell_coordinate: "B12" }],
  });
  const findingB = makeFinding({
    issue_key: "revenue_discrepancy",
    evidence: [{ metric: "revenue", period: "FY2024", sheet_or_page: "Cash Flow", cell_coordinate: "D8" }],
  });

  const idA = extractFindingIdentity(findingA);
  const idB = extractFindingIdentity(findingB);
  const compatible = findingIdentitiesAreCompatible(idA, idB);
  assert(!compatible, "Test 3: Same issue_key but different sheets/cells → incompatible");
}

// --- Test 4: Ownership and licence findings remain separate ---
{
  const findingA = makeFinding({
    issue_key: "legal_risk",
    legal_clause: "IP ownership clause 4.2",
    evidence: [{ metric: "ownership", period: "current" }],
  });
  const findingB = makeFinding({
    issue_key: "legal_risk",
    legal_clause: "Software licence clause 7.1",
    evidence: [{ metric: "licence_compliance", period: "current" }],
  });

  const idA = extractFindingIdentity(findingA);
  const idB = extractFindingIdentity(findingB);
  const compatible = findingIdentitiesAreCompatible(idA, idB);
  assert(!compatible, "Test 4: Ownership vs licence findings → incompatible (different clauses + metrics)");
}

// --- Test 5: Different legal clauses or consequences remain separate ---
{
  const findingA = makeFinding({
    claim_ids: ["contract-clause-1"],
    legal_clause: "termination for convenience",
    legal_consequence: "6 month notice",
  });
  const findingB = makeFinding({
    claim_ids: ["contract-clause-1"],
    legal_clause: "change of control",
    legal_consequence: "immediate termination right",
  });

  const idA = extractFindingIdentity(findingA);
  const idB = extractFindingIdentity(findingB);
  const compatible = findingIdentitiesAreCompatible(idA, idB);
  assert(!compatible, "Test 5: Different legal clauses + consequences → incompatible");
}

// --- Test 6: Findings with matching canonical identities consolidate ---
{
  const findingA = makeFinding({
    claim_ids: ["same-claim"],
    evidence: [{ metric: "revenue", period: "FY2024", scope: "group", sheet_or_page: "P&L" }],
  });
  const findingB = makeFinding({
    claim_ids: ["same-claim"],
    evidence: [{ metric: "revenue", period: "FY2024", scope: "group", sheet_or_page: "P&L" }],
  });

  const idA = extractFindingIdentity(findingA);
  const idB = extractFindingIdentity(findingB);
  const compatible = findingIdentitiesAreCompatible(idA, idB);
  assert(compatible, "Test 6: Matching canonical identities → compatible (can consolidate)");
}

// --- Test 7: A-B compatible and B-C compatible but A-C conflict cannot bridge merge ---
{
  // A: revenue FY2024 group
  const findingA = makeFinding({
    claim_ids: ["bridge-test"],
    evidence: [{ metric: "revenue", period: "FY2024", scope: "group" }],
    title: "Revenue 2024",
  });
  // B: revenue FY2024 group AND FY2025 group (overlaps with both A and C)
  const findingB = makeFinding({
    claim_ids: ["bridge-test"],
    evidence: [
      { metric: "revenue", period: "FY2024", scope: "group" },
      { metric: "revenue", period: "FY2025", scope: "group" },
    ],
    title: "Revenue 2024-2025",
  });
  // C: revenue FY2025 group only
  const findingC = makeFinding({
    claim_ids: ["bridge-test"],
    evidence: [{ metric: "revenue", period: "FY2025", scope: "group" }],
    title: "Revenue 2025",
  });

  // A-B compatible? B has both periods so A's FY2024 overlaps with B
  const idA = extractFindingIdentity(findingA);
  const idB = extractFindingIdentity(findingB);
  const idC = extractFindingIdentity(findingC);

  const abCompat = findingIdentitiesAreCompatible(idA, idB);
  const bcCompat = findingIdentitiesAreCompatible(idB, idC);
  const acCompat = findingIdentitiesAreCompatible(idA, idC);

  // A and C have different periods (FY2024 vs FY2025) with no overlap
  assert(!acCompat, "Test 7: A-C are incompatible (different periods, no overlap)");
  // The transitive bridge prevention means: even if A-B and B-C are individually
  // compatible, the cluster validation ensures A and C are checked against each other
  // before joining the same cluster.
  // Note: A-B may or may not be compatible depending on whether B having both periods
  // creates overlap. In our implementation, both A and B have "fy2024" so they overlap.
  assert(abCompat, "Test 7b: A-B are compatible (period overlap on FY2024)");
  assert(bcCompat, "Test 7c: B-C are compatible (period overlap on FY2025)");
}

// --- Test 8: Existing Saint duplicate-family fixtures still consolidate appropriately ---
// Saint duplicates have the same issue_key and same structured coordinates
{
  const findingA = makeFinding({
    issue_key: "fca_authorisation_risk",
    finding_kind: "source_stated_risk",
    evidence: [{ metric: "regulatory", period: "current", scope: "fca" }],
    title: "FCA authorisation gap (version A)",
  });
  const findingB = makeFinding({
    issue_key: "fca_authorisation_risk",
    finding_kind: "source_stated_risk",
    evidence: [{ metric: "regulatory", period: "current", scope: "fca" }],
    title: "FCA authorisation gap (version B)",
  });

  const idA = extractFindingIdentity(findingA);
  const idB = extractFindingIdentity(findingB);
  const compatible = findingIdentitiesAreCompatible(idA, idB);
  assert(compatible, "Test 8: Saint duplicate-family with matching identities → compatible");
}

// --- Test 9: Consolidation is deterministic and idempotent ---
// Running identity extraction twice produces same result
{
  const finding = makeFinding({
    claim_ids: ["idem-1"],
    evidence: [
      { metric: "ebitda", period: "FY2024", scope: "uk", sheet_or_page: "Financials" },
      { metric: "ebitda", period: "FY2025", scope: "uk", sheet_or_page: "Financials" },
    ],
    structured_impact: [
      { amount: 5000000, role: "delta", currency: "GBP" },
    ],
  });

  const id1 = extractFindingIdentity(finding);
  const id2 = extractFindingIdentity(finding);

  // Same dimensions extracted
  assert(id1.size === id2.size, "Test 9: Same number of dimensions extracted");

  // Same values in each dimension
  let allMatch = true;
  for (const [dim, set1] of id1.entries()) {
    const set2 = id2.get(dim);
    if (!set2 || set1.size !== set2.size) { allMatch = false; break; }
    for (const v of set1) {
      if (!set2.has(v)) { allMatch = false; break; }
    }
  }
  assert(allMatch, "Test 9b: Identity extraction is deterministic (idempotent)");

  // Self-compatibility
  const selfCompat = findingIdentitiesAreCompatible(id1, id2);
  assert(selfCompat, "Test 9c: A finding is always compatible with itself");
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}\nResults: ${passed} passed, ${failed} failed\n${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
