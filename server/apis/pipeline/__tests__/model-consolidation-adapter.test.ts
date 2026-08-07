/**
 * MG-3 Model Consolidation Adapter — Unit tests.
 *
 * Tests modelConsolidate with a STUB grouping function (no real model calls).
 * Validates: FamilyDedupResult shape, conservation, representative selection,
 * fingerprint stability, and completeness.
 *
 * Run via: npx tsx server/apis/pipeline/__tests__/model-consolidation-adapter.test.ts
 */

import { modelConsolidate, _mapToFamilyDedupResult, _buildRefMap } from "../model-consolidation-adapter.js";
import type { FamilyDedupResult, FamilyRecord, KnownFamilyId, OccurrenceRecord } from "../canonical-family-dedup.js";
import type { CanonicalFinding } from "../canonical-finding.js";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function makeFinding(overrides?: Partial<CanonicalFinding>): CanonicalFinding {
  return {
    finding_id: randomUUID(),
    title: "Test finding",
    detail: "Test detail text",
    severity: "medium",
    category: "omission",
    source_docs: [],
    ...overrides,
  } as CanonicalFinding;
}

// ---------------------------------------------------------------------------
// Fixtures: 10 synthetic findings
// ---------------------------------------------------------------------------

const findings: CanonicalFinding[] = [
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000001", title: "Missing GDPR consent mechanism" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000002", title: "GDPR consent not documented" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000003", title: "Change of control clause customer" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000004", title: "Customer change of control termination" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000005", title: "Customer CoC termination right" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000006", title: "IP assignment gap" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000007", title: "Trademark registration missing" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000008", title: "FCA section 19 breach" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000009", title: "Restrictive covenant enforceability" }),
  makeFinding({ finding_id: "aaaa0000-0000-0000-0000-000000000010", title: "Property lease title defect" }),
];

// Stub model response: groups 1+2 (GDPR), groups 3+4+5 (customer CoC), rest ungrouped
const STUB_MODEL_RESPONSE = {
  groups: [
    { group_id: 1, member_refs: ["f000", "f001"], reason: "Both about GDPR consent documentation gaps" },
    { group_id: 2, member_refs: ["f002", "f003", "f004"], reason: "All about customer change of control termination" },
  ],
  ungrouped_refs: ["f005", "f006", "f007", "f008", "f009"],
};

// Stub aiFn that returns the known response
const stubAiFn: any = async (req: any, opts: any, meta?: any) => {
  return {
    id: "msg_stub",
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: JSON.stringify(STUB_MODEL_RESPONSE) }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 500 },
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("\n=== MG-3: Model Consolidation Adapter Tests ===\n");

  // --- Test 1: Basic shape and field presence ---
  console.log("Test 1: FamilyDedupResult shape and all fields present");
  const result = await modelConsolidate(findings, stubAiFn);

  assert(Array.isArray(result.families), "families is an array");
  assert(Array.isArray(result.ungroupedFindingIds), "ungroupedFindingIds is an array");
  assert(typeof result.totalInputFindings === "number", "totalInputFindings is number");
  assert(typeof result.totalFamiliesCreated === "number", "totalFamiliesCreated is number");
  assert(typeof result.totalSuppressed === "number", "totalSuppressed is number");
  assert(typeof result.resultFingerprint === "string", "resultFingerprint is string");
  assert(typeof result.ruleVersion === "string", "ruleVersion is string");
  assert(Array.isArray(result.familyCatalogue), "familyCatalogue is array");
  assert(result.ruleVersion === "model-grouping-v1", "ruleVersion is model-grouping-v1");

  // --- Test 2: Correct family/ungrouped split ---
  console.log("\nTest 2: Correct families and ungrouped split");
  assert(result.totalFamiliesCreated === 2, `totalFamiliesCreated = 2 (got ${result.totalFamiliesCreated})`);
  assert(result.ungroupedFindingIds.length === 5, `ungrouped count = 5 (got ${result.ungroupedFindingIds.length})`);
  assert(result.totalInputFindings === 10, `totalInputFindings = 10 (got ${result.totalInputFindings})`);

  // --- Test 3: Representative is lexicographically smallest finding_id in group ---
  console.log("\nTest 3: Representative = lexicographic min per group");
  const gdprFamily = result.families.find(f => f.memberFindingIds.includes("aaaa0000-0000-0000-0000-000000000001"));
  assert(!!gdprFamily, "GDPR family found");
  if (gdprFamily) {
    assert(
      gdprFamily.representativeFindingId === "aaaa0000-0000-0000-0000-000000000001",
      `GDPR representative = ...0001 (got ${gdprFamily.representativeFindingId})`
    );
    assert(gdprFamily.memberFindingIds.length === 2, `GDPR family has 2 members`);
  }

  const cocFamily = result.families.find(f => f.memberFindingIds.includes("aaaa0000-0000-0000-0000-000000000003"));
  assert(!!cocFamily, "CoC family found");
  if (cocFamily) {
    assert(
      cocFamily.representativeFindingId === "aaaa0000-0000-0000-0000-000000000003",
      `CoC representative = ...0003 (got ${cocFamily.representativeFindingId})`
    );
    assert(cocFamily.memberFindingIds.length === 3, `CoC family has 3 members`);
  }

  // --- Test 4: totalSuppressed correct ---
  console.log("\nTest 4: totalSuppressed correct");
  // GDPR: 2 members, 1 suppressed. CoC: 3 members, 2 suppressed. Total = 3.
  assert(result.totalSuppressed === 3, `totalSuppressed = 3 (got ${result.totalSuppressed})`);

  // --- Test 5: Conservation — every input finding accounted for exactly once ---
  console.log("\nTest 5: Conservation (every finding exactly once)");
  const allAccountedIds = new Set<string>([
    ...result.ungroupedFindingIds,
    ...result.families.flatMap(f => f.memberFindingIds),
  ]);
  assert(allAccountedIds.size === findings.length, `All ${findings.length} findings accounted (got ${allAccountedIds.size})`);
  for (const f of findings) {
    assert(allAccountedIds.has(f.finding_id), `Finding ${f.finding_id.slice(-4)} accounted`);
  }

  // --- Test 6: Fingerprint stability across two identical calls ---
  console.log("\nTest 6: Fingerprint stability (deterministic)");
  const result2 = await modelConsolidate(findings, stubAiFn);
  assert(
    result.resultFingerprint === result2.resultFingerprint,
    `Fingerprints match: ${result.resultFingerprint} === ${result2.resultFingerprint}`
  );

  // --- Test 7: FamilyRecord has all required fields ---
  console.log("\nTest 7: FamilyRecord shape completeness");
  if (result.families.length > 0) {
    const fam = result.families[0];
    assert(typeof fam.familyRecordId === "string", "familyRecordId present");
    assert(typeof fam.issueFamilyKey === "string", "issueFamilyKey present");
    assert(typeof fam.ruleId === "string", "ruleId present");
    assert(typeof fam.ruleVersion === "string", "ruleVersion present");
    assert(typeof fam.representativeOccurrenceId === "string", "representativeOccurrenceId present");
    assert(typeof fam.representativeFindingId === "string", "representativeFindingId present");
    assert(Array.isArray(fam.memberOccurrenceIds), "memberOccurrenceIds array");
    assert(Array.isArray(fam.memberFindingIds), "memberFindingIds array");
    assert(Array.isArray(fam.memberDispositions), "memberDispositions array");
    assert(Array.isArray(fam.evidenceIds), "evidenceIds array");
    assert(Array.isArray(fam.evidenceRecords), "evidenceRecords array");
    assert(Array.isArray(fam.claimIds), "claimIds array");
    assert(Array.isArray(fam.disclosureIds), "disclosureIds array");
    assert(Array.isArray(fam.sourceCoordinates), "sourceCoordinates array");
    assert(Array.isArray(fam.affectedEntities), "affectedEntities array");
    assert(Array.isArray(fam.counterparties), "counterparties array");
    assert(Array.isArray(fam.properties), "properties array");
    assert(Array.isArray(fam.products), "products array");
    assert(Array.isArray(fam.contracts), "contracts array");
    assert(fam.sourceAuthority === null, "sourceAuthority null");
    assert(typeof fam.sourceAuthorityMissingReason === "string", "sourceAuthorityMissingReason present");
    assert(Array.isArray(fam.recursiveLeafAncestry), "recursiveLeafAncestry array");
    assert(typeof fam.rationaleCode === "string", "rationaleCode present");
    assert(typeof fam.matchedDimensions === "object", "matchedDimensions object");
    assert(typeof fam.semanticHash === "string", "semanticHash present");
  }

  // --- Test 8: Member dispositions correct ---
  console.log("\nTest 8: Member dispositions (retained/suppressed)");
  if (gdprFamily) {
    const repDisp = gdprFamily.memberDispositions.find(d => d.findingId === gdprFamily.representativeFindingId);
    assert(repDisp?.disposition === "retained", "Representative disposition = retained");
    const suppressedDisps = gdprFamily.memberDispositions.filter(d => d.disposition === "suppressed");
    assert(suppressedDisps.length === 1, `1 suppressed in GDPR family (got ${suppressedDisps.length})`);
  }

  // --- Test 9: Empty input ---
  console.log("\nTest 9: Empty input returns valid empty result");
  const emptyResult = await modelConsolidate([], stubAiFn);
  assert(emptyResult.families.length === 0, "Empty: 0 families");
  assert(emptyResult.ungroupedFindingIds.length === 0, "Empty: 0 ungrouped");
  assert(emptyResult.totalInputFindings === 0, "Empty: totalInput = 0");

  // --- Test 10: Single finding input ---
  console.log("\nTest 10: Single finding returns as ungrouped");
  const singleResult = await modelConsolidate([findings[0]], stubAiFn);
  assert(singleResult.families.length === 0, "Single: 0 families");
  assert(singleResult.ungroupedFindingIds.length === 1, "Single: 1 ungrouped");
  assert(singleResult.ungroupedFindingIds[0] === findings[0].finding_id, "Single: correct finding ID");

  // --- Test 11: familyCatalogue is empty (option b) ---
  console.log("\nTest 11: familyCatalogue is empty (option b)");
  assert(result.familyCatalogue.length === 0, `familyCatalogue = [] (got length ${result.familyCatalogue.length})`);

  // --- Summary ---
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
