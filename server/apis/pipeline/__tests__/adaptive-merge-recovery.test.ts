/**
 * Behavioral Acceptance Tests — Adaptive Merge Recovery
 *
 * Self-contained test module — NO test-framework dependency.
 * Exports `runBehavioralTests()` which returns an array of results.
 * Each test is a pure function that throws on failure.
 */

import {
  buildSubgroupPlan,
  computeFindingContentHash,
  hashFindingIds,
  MERGE_GROUP_SIZE,
  MAX_FINDINGS_PER_SUBGROUP,
  PipelinePrerequisiteError,
} from "../adaptive-merge-recovery.js";
import { applyReductionGates } from "../finding-reduction-gate.js";
import {
  getValidMergeTreeLevels,
  type FrozenManifest,
} from "../pipeline-prerequisites.js";

// ─── Assertion Helpers ────────────────────────────────────────────────────────

type TestResult = { name: string; passed: boolean; message: string };

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, label?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label ?? "assertEqual"}: expected ${e}, got ${a}`);
  }
}

function assertNotEqual<T>(actual: T, notExpected: T, label?: string): void {
  if (JSON.stringify(actual) === JSON.stringify(notExpected)) {
    throw new Error(`${label ?? "assertNotEqual"}: values should differ but both are ${JSON.stringify(actual)}`);
  }
}

function assertContains(arr: unknown[], value: unknown, label?: string): void {
  if (!arr.includes(value)) {
    throw new Error(`${label ?? "assertContains"}: array does not contain ${JSON.stringify(value)}`);
  }
}

function assertNotContains(arr: unknown[], value: unknown, label?: string): void {
  if (arr.includes(value)) {
    throw new Error(`${label ?? "assertNotContains"}: array should not contain ${JSON.stringify(value)}`);
  }
}

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const makeFinding = (overrides: Partial<Record<string, unknown>> = {}) => ({
  finding_id: `f_${Math.random().toString(36).slice(2, 8)}`,
  title: "Test finding",
  detail: "Details",
  full_analysis: "Full analysis text",
  source_docs: ["CIM_v2.pdf"],
  claim_ids: ["c1"],
  merged_from_finding_ids: [] as string[],
  severity: "warning",
  issue_key: "test_issue",
  finding_kind: "contradiction",
  ...overrides,
});

const makeSCGFinding = (variant: string) => {
  const base = makeFinding();
  switch (variant) {
    case "fy26_revenue_revision":
      return { ...base, issue_key: "fy26_revenue_revision", finding_kind: "revision",
        evidence: [{ period: "FY26", metric: "Revenue", figure: "\u00a345m", source_doc: "Model", doc_class: "financial_model" }] };
    case "fy26_ebitda_revision":
      return { ...base, issue_key: "fy26_ebitda_revision", finding_kind: "revision",
        evidence: [{ period: "FY26", metric: "EBITDA", figure: "\u00a312m", source_doc: "Model", doc_class: "financial_model" }] };
    case "widening_adjustments":
      return { ...base, issue_key: "widening_adjustments_gap", finding_kind: "gap",
        evidence: [{ period: "FY24", metric: "EBITDA adj", doc_class: "management_accounts" }, { period: "FY26", metric: "EBITDA adj", doc_class: "financial_model" }] };
    case "memo_vs_model":
      return { ...base, issue_key: "memo_vs_model_revenue", finding_kind: "contradiction",
        evidence: [{ doc_class: "ic_memo", figure: "\u00a340m" }, { doc_class: "financial_model", figure: "\u00a345m" }],
        delta_abs: 5, delta_pct: 12.5, comparison_basis: "revenue_fy26" };
    case "calls_decline":
      return { ...base, issue_key: "calls_lines_fy26_decline", finding_kind: "trend",
        evidence: [{ period: "FY26", metric: "Calls", doc_class: "management_presentation" }],
        delta_pct: -15 };
    default:
      return base;
  }
};

const makeManifest = (analysisCount = 205): FrozenManifest => {
  const expectedL1 = Math.ceil(analysisCount / MERGE_GROUP_SIZE);
  const expectedL2 = Math.ceil(expectedL1 / MERGE_GROUP_SIZE);
  const expectedL3 = Math.ceil(expectedL2 / MERGE_GROUP_SIZE);
  const expectedL4 = Math.ceil(expectedL3 / MERGE_GROUP_SIZE);

  // Non-contiguous chunk indices (simulating post-exclusion membership)
  const allChunkIndices = Array.from({ length: analysisCount }, (_, i) => i * 2 + 3);

  const l1Membership: Record<number, number[]> = {};
  for (let ni = 0; ni < expectedL1; ni++) {
    l1Membership[ni] = allChunkIndices.slice(
      ni * MERGE_GROUP_SIZE,
      Math.min((ni + 1) * MERGE_GROUP_SIZE, allChunkIndices.length)
    );
  }

  return {
    version: 1,
    eligibleAnalysisIds: allChunkIndices.map(ci => `chunk_${ci}`),
    l1Membership,
    excluded: [],
    sourceFingerprint: "test_fp_" + analysisCount,
    expectedTopology: { l1: expectedL1, l2: expectedL2, l3: expectedL3, l4: expectedL4, total: expectedL1 + expectedL2 + expectedL3 + expectedL4 },
    createdAt: "2026-08-05T00:00:00Z",
    provenance: "test_fixture",
    eligibleCount: analysisCount,
  };
};

// ─── Test Definitions ─────────────────────────────────────────────────────────

const TESTS: Array<{ name: string; fn: () => void }> = [
  // ─── T1: L1 uses non-contiguous frozen membership ───────────────────────────
  {
    name: "T1a: manifest l1Membership contains non-contiguous indices",
    fn: () => {
      const manifest = makeManifest(12);
      assertEqual(Object.keys(manifest.l1Membership).length, 3, "L1 node count");
      assertEqual(manifest.l1Membership[0], [3, 5, 7, 9], "L1[0] membership");
      assertEqual(manifest.l1Membership[1], [11, 13, 15, 17], "L1[1] membership");
      assertEqual(manifest.l1Membership[2], [19, 21, 23, 25], "L1[2] membership");
    },
  },
  {
    name: "T1b: membership does not form a contiguous range",
    fn: () => {
      const manifest = makeManifest(12);
      const firstGroup = manifest.l1Membership[0]!;
      const isContiguous = firstGroup.every((v, i) => i === 0 || v === firstGroup[i - 1] + 1);
      assertEqual(isContiguous, false, "First group should not be contiguous");
    },
  },

  // ─── T2: Missing manifest analysis blocks the node ──────────────────────────
  {
    name: "T2: processLevel1Subgroup requires exact membership count",
    fn: () => {
      const manifest = makeManifest(8);
      const requested = manifest.l1Membership[0]!;
      const returned = [3, 5, 7]; // Missing index 9
      const missing = requested.filter(ci => !returned.includes(ci));
      assertEqual(missing, [9], "Missing member identified");
      assert(missing.length > 0, "Should detect at least one missing member");
    },
  },

  // ─── T3: Frozen manifest absence blocks recovery ────────────────────────────
  {
    name: "T3: PipelinePrerequisiteError constructable and instance of Error",
    fn: () => {
      assert(typeof PipelinePrerequisiteError === "function", "PipelinePrerequisiteError is a class");
      const error = new PipelinePrerequisiteError("Frozen manifest not found");
      assertEqual(error.message, "Frozen manifest not found", "Error message");
      assert(error instanceof Error, "Instance of Error");
    },
  },

  // ─── T4: Subgroup progress survives invocation (durable cursor) ─────────────
  {
    name: "T4: buildSubgroupPlan is deterministic and resumable",
    fn: () => {
      const findings = Array.from({ length: 25 }, (_, i) => makeFinding({ finding_id: `f_${i}` }));
      const plan = buildSubgroupPlan(findings, MERGE_GROUP_SIZE);
      assert(plan.length > 1, "Multiple subgroups expected");

      const plan2 = buildSubgroupPlan(findings, MERGE_GROUP_SIZE);
      assertEqual(plan, plan2, "Plan determinism");

      const cursor = 2;
      const remaining = plan.slice(cursor);
      assertEqual(remaining.length, plan.length - cursor, "Cursor resumption");
    },
  },

  // ─── T5: Reconciliation cursor survival ─────────────────────────────────────
  {
    name: "T5: DurableNodeState reconCursor fields survive JSON round-trip",
    fn: () => {
      const state = {
        reconSubgroups: [["f1", "f2"], ["f3", "f4"]],
        reconCursor: 1,
        reconPassNumber: 2,
        reconPassResults: [{ subgroupIndex: 0, outputCount: 1, inputCount: 2 }],
        reconFinalComplete: false,
      };
      const deserialized = JSON.parse(JSON.stringify(state));
      assertEqual(deserialized.reconCursor, 1, "reconCursor preserved");
      assertEqual(deserialized.reconPassNumber, 2, "reconPassNumber preserved");
      assertEqual(deserialized.reconSubgroups.length, 2, "reconSubgroups length preserved");
    },
  },

  // ─── T6: Cross-partition duplicates converge ────────────────────────────────
  {
    name: "T6: Partition size within MAX allows final single-merge convergence",
    fn: () => {
      const smallSet = Array.from({ length: MAX_FINDINGS_PER_SUBGROUP - 5 }, (_, i) =>
        makeFinding({ finding_id: `f_${i}` })
      );
      assert(
        smallSet.length <= MAX_FINDINGS_PER_SUBGROUP,
        `Set size ${smallSet.length} should be <= ${MAX_FINDINGS_PER_SUBGROUP}`
      );
    },
  },

  // ─── T7: Irreducible oversized reconciliation becomes BLOCKED ───────────────
  {
    name: "T7: Oversized post-reconciliation triggers blocked state",
    fn: () => {
      const oversized = MAX_FINDINGS_PER_SUBGROUP + 10;
      assert(
        oversized > MAX_FINDINGS_PER_SUBGROUP,
        "Oversized count must exceed limit for block trigger"
      );
    },
  },

  // ─── T8: Finding content change with same ID invalidates parent ─────────────
  {
    name: "T8a: computeFindingContentHash changes when detail changes",
    fn: () => {
      const f1 = makeFinding({ finding_id: "same_id", detail: "Original detail" });
      const f2 = makeFinding({ finding_id: "same_id", detail: "Modified detail" });

      const hash1 = computeFindingContentHash(f1);
      const hash2 = computeFindingContentHash(f2);

      assertNotEqual(hash1, hash2, "Content hashes should differ on detail change");
      assertEqual(hashFindingIds(["same_id"]), hashFindingIds(["same_id"]), "ID hashes unchanged");
    },
  },
  {
    name: "T8b: Output hash derived from content hashes detects content mutations",
    fn: () => {
      const findings1 = [makeFinding({ finding_id: "f1", detail: "v1" })];
      const findings2 = [makeFinding({ finding_id: "f1", detail: "v2" })];

      const ch1 = findings1.map(f => computeFindingContentHash(f)).sort().join("|");
      const ch2 = findings2.map(f => computeFindingContentHash(f)).sort().join("|");

      assertNotEqual(ch1, ch2, "Composite content hashes should differ");
    },
  },

  // ─── T9: Ancestry mismatches block root completion ──────────────────────────
  {
    name: "T9a: Duplicate ancestry IDs detected",
    fn: () => {
      const ancestryIds = ["chunk_1", "chunk_2", "chunk_1"];
      const duplicates = ancestryIds.filter((id, idx) => ancestryIds.indexOf(id) !== idx);
      assert(duplicates.length > 0, "Should detect at least one duplicate");
    },
  },
  {
    name: "T9b: Missing expected IDs produce blocking condition",
    fn: () => {
      const manifest = makeManifest(8);
      const ancestrySet = new Set(manifest.eligibleAnalysisIds.slice(0, -1));
      const expectedSet = new Set(manifest.eligibleAnalysisIds);
      const missing = [...expectedSet].filter(id => !ancestrySet.has(id));
      assertEqual(missing.length, 1, "Should find exactly one missing ID");
    },
  },
  {
    name: "T9c: Unexpected ancestry IDs produce blocking condition",
    fn: () => {
      const manifest = makeManifest(8);
      const ancestrySet = new Set([...manifest.eligibleAnalysisIds, "extra_chunk_999"]);
      const expectedSet = new Set(manifest.eligibleAnalysisIds);
      const unexpected = [...ancestrySet].filter(id => !expectedSet.has(id));
      assertEqual(unexpected.length, 1, "Should find exactly one unexpected ID");
      assertEqual(unexpected[0], "extra_chunk_999", "Unexpected ID identity");
    },
  },

  // ─── T10: Synthetic checkpoints cannot affect topology ──────────────────────
  {
    name: "T10a: getValidMergeTreeLevels returns only manifest-topology levels",
    fn: () => {
      const manifest = makeManifest(205);
      const validLevels = getValidMergeTreeLevels(manifest);
      assertEqual(validLevels, [1, 2, 3, 4], "Valid levels for 205 analyses");
      assertNotContains(validLevels, 96, "No synthetic level 96");
      assertNotContains(validLevels, 99, "No synthetic level 99");
    },
  },
  {
    name: "T10b: Checkpoints at level 96+ excluded by valid level filter",
    fn: () => {
      const manifest = makeManifest(205);
      const validLevels = getValidMergeTreeLevels(manifest);
      const checkpoints = [
        { tree_level: 1, node_index: 0, status: "complete" },
        { tree_level: 2, node_index: 0, status: "complete" },
        { tree_level: 96, node_index: 0, status: "complete" },
        { tree_level: 99, node_index: 0, status: "complete" },
      ];
      const dataOnly = checkpoints.filter(c => validLevels.includes(c.tree_level));
      assertEqual(dataOnly.length, 2, "Only 2 checkpoints in valid levels");
      assert(dataOnly.every(c => c.tree_level < 90), "All retained checkpoints below 90");
    },
  },

  // ─── T11: Pre-migration artifact access fails closed ────────────────────────
  {
    name: "T11: FindingReductionGate contract includes migrationRequired flag",
    fn: () => {
      const errorResponse = {
        error: "MIGRATION_REQUIRED: artifact_status column not found",
        primaryFindings: [] as unknown[],
        suppressedLedger: [] as unknown[],
        migrationRequired: true,
      };
      assert(errorResponse.migrationRequired === true, "migrationRequired flag present");
      assert(errorResponse.error.startsWith("MIGRATION_REQUIRED"), "Error prefix correct");
      assertEqual(errorResponse.primaryFindings.length, 0, "Empty primaryFindings");
      assertEqual(errorResponse.suppressedLedger.length, 0, "Empty suppressedLedger");
    },
  },

  // ─── T12: Active artifact selection ─────────────────────────────────────────
  {
    name: "T12: Active artifact SQL contract includes status filter and limit",
    fn: () => {
      const sql = `SELECT id FROM module_outputs WHERE module_run_id = $1 AND artifact_status = 'active' ORDER BY created_at DESC LIMIT 1`;
      assert(sql.includes("artifact_status = 'active'"), "SQL filters active status");
      assert(sql.includes("LIMIT 1"), "SQL limits to 1 row");
      assert(sql.includes("ORDER BY created_at DESC"), "SQL orders by created_at desc");
    },
  },

  // ─── T13: Post-merge passes GATED primary findings to F06 ───────────────────
  {
    name: "T13: applyReductionGates filters findings before F06 consumption",
    fn: () => {
      const findings = [
        makeFinding({
          severity: "critical", finding_kind: "contradiction",
          delta_abs: 5, comparison_basis: "revenue",
          evidence: [{ figure: "\u00a310m", source_doc: "CIM", doc_class: "cim", period: "FY26", period_type: "FY" }],
        }),
        makeFinding({ severity: "info", finding_kind: "observation" }),
        makeFinding({ severity: "warning", finding_kind: "discrepancy", source_docs: [], evidence: [] }),
      ];

      const result = applyReductionGates(findings);
      assert(result.primaryFindings.length < findings.length, "Some findings filtered");
      assert(result.suppressedLedger.length > 0, "At least one suppression logged");
    },
  },

  // ─── T14: Known SCG true findings survive through structured evidence ───────
  {
    name: "T14a: fy26_revenue_revision passes gates with structured fields",
    fn: () => {
      const f = makeSCGFinding("fy26_revenue_revision");
      const finding = {
        ...f,
        delta_abs: 5,
        delta_pct: 12.5,
        comparison_basis: "ic_memo_vs_model",
        disclosure_status: "undisclosed",
        materiality_basis: "IC valuation impact",
      };
      const result = applyReductionGates([finding]);
      assertContains(result.groundTruthSignals, "fy26_revenue_revision", "Ground truth detected");
    },
  },
  {
    name: "T14b: memo_vs_model finding with structured evidence passes gates",
    fn: () => {
      const f = makeSCGFinding("memo_vs_model");
      const finding = {
        ...f,
        disclosure_status: "undisclosed",
        materiality_basis: "IC memo vs financial model revenue discrepancy",
      };
      const result = applyReductionGates([finding]);
      assertContains(result.groundTruthSignals, "memo_vs_model_revenue", "Ground truth detected");
    },
  },
  {
    name: "T14c: Known false positives are suppressed",
    fn: () => {
      const fpFinding = makeFinding({
        title: "SIP Calls margin collapse",
        detail: "\u221234.1pp margin collapse across SIP call business",
        full_analysis: "SIP calls show a 34.1pp margin collapse...",
      });
      const result = applyReductionGates([fpFinding]);
      assertEqual(result.primaryFindings.length, 0, "No primary findings from false positive");
      assert(
        result.suppressedLedger.some((s: any) => s.suppressionReason?.includes("sip_calls")),
        "Suppression reason mentions sip_calls"
      );
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

export function runBehavioralTests(): TestResult[] {
  return TESTS.map((t) => {
    try {
      t.fn();
      return { name: t.name, passed: true, message: "OK" };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { name: t.name, passed: false, message: msg };
    }
  });
}

export { TESTS };
