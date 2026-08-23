/**
 * Fix 25 — Coordinate-Level Dedup at the Fix 16 Carry-Forward Point
 *
 * Fix 16 guarantees no input finding is ever silently dropped: anything the model
 * fails to account for is carried forward verbatim. It never asked whether the
 * node already held an equivalent finding, so counts grew monotonically up the
 * tree. Run 13e9c0d6 reached 84–93% code-carried findings at L6:0/L7:0/L8:0, the
 * root's emission requirement passed what the merge call could produce inside its
 * timeout, and the tree deadlocked at MAX_PARTIAL_RETRIES.
 *
 * Fix 25 folds a carried finding into an existing one at the same coordinate
 * (metric|scope|period) when the compatibility gate passes, merging PROVENANCE
 * instead of appending a duplicate.
 *
 * These tests pin down the two properties that matter:
 *   A. It actually collapses duplicates (the revision family).
 *   B. It never collapses two things that are not the same finding, and never
 *      loses a finding_id — Fix 16's contract survives.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix25-carry-forward-dedup.test.ts
 */

import {
  dedupCarryForward,
  coordinateKey,
  areCompatibleForMerge,
  absorbInto,
  rankSeverity,
  extractStructuredIdentity,
  identitiesAreCompatible,
  type AnyFinding,
} from "../finding-coordinate-dedup.js";

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

/** Minimal finding factory. */
function f(overrides: AnyFinding): AnyFinding {
  return {
    finding_id: "f-unknown",
    title: "untitled",
    severity: "warning",
    finding_kind: "numeric_discrepancy",
    ...overrides,
  };
}

/**
 * Fix 16's contract, restated as a check: every input id must appear in the
 * output either as a finding_id or inside some finding's merged_from_finding_ids.
 */
function accountedIds(findings: AnyFinding[]): Set<string> {
  const ids = new Set<string>();
  for (const fi of findings) {
    if (typeof fi.finding_id === "string") ids.add(fi.finding_id);
    if (Array.isArray(fi.merged_from_finding_ids)) {
      for (const id of fi.merged_from_finding_ids) if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

// ===========================================================================
console.log("\n── coordinateKey ──────────────────────────────────────────────");
// ===========================================================================

{
  assertEqual(
    coordinateKey(f({ metric: "Revenue", scope: "Consolidated", period: "FY 2026" })),
    "revenue|consolidated|fy2026",
    "coordinateKey normalizes case and strips whitespace from period"
  );

  assertEqual(
    coordinateKey(f({ metric: "revenue", period: "FY2026" })),
    "revenue|-|fy2026",
    "absent scope renders as '-' so scoped and unscoped never share a key"
  );

  assert(
    coordinateKey(f({ metric: "revenue", scope: "consolidated", period: "FY2026" })) !==
      coordinateKey(f({ metric: "revenue", period: "FY2026" })),
    "a scoped finding and an unscoped finding have different coordinates"
  );

  assertEqual(
    coordinateKey(f({ scope: "consolidated", period: "FY2026" })),
    null,
    "missing metric → undetermined coordinate (null)"
  );

  assertEqual(
    coordinateKey(f({ metric: "revenue", scope: "consolidated" })),
    null,
    "missing period → undetermined coordinate (null)"
  );

  // Evidence fallback: derive from evidence[] when top-level fields are absent.
  assertEqual(
    coordinateKey(f({
      evidence: [{ metric: "EBITDA", period: "FY2027", scope: "Consolidated", figure: "12.4" }],
    })),
    "ebitda|consolidated|fy2027",
    "coordinate falls back to evidence[] when top-level fields are absent"
  );

  // Ambiguous evidence must NOT resolve — two different periods is not one coordinate.
  assertEqual(
    coordinateKey(f({
      evidence: [
        { metric: "revenue", period: "FY2026" },
        { metric: "revenue", period: "FY2027" },
      ],
    })),
    null,
    "evidence disagreeing on period → undetermined, not an arbitrary pick"
  );
}

// ===========================================================================
console.log("\n── compatibility gate ─────────────────────────────────────────");
// ===========================================================================

{
  assert(
    areCompatibleForMerge(
      f({ metric: "revenue", period: "FY2026", currency: "USD" }),
      f({ metric: "revenue", period: "FY2026", currency: "USD" })
    ),
    "identical gate fields are compatible"
  );

  assert(
    !areCompatibleForMerge(
      f({ metric: "revenue", period: "FY2026", currency: "USD" }),
      f({ metric: "revenue", period: "FY2026", currency: "EUR" })
    ),
    "conflicting currency blocks a merge"
  );

  assert(
    !areCompatibleForMerge(
      f({ metric: "revenue", period: "FY2026", actual_vs_forecast: "actual" }),
      f({ metric: "revenue", period: "FY2026", actual_vs_forecast: "forecast" })
    ),
    "an actual and a forecast at the same coordinate are NOT the same finding"
  );

  assert(
    !areCompatibleForMerge(
      f({ metric: "revenue", period: "FY2026", finding_kind: "numeric_discrepancy" }),
      f({ metric: "revenue", period: "FY2026", finding_kind: "legal_risk" })
    ),
    "differing finding_kind blocks a merge"
  );

  assert(
    areCompatibleForMerge(
      f({ metric: "revenue", period: "FY2026" }),
      f({ metric: "revenue", period: "FY2026", currency: "USD" })
    ),
    "a field present on only one side is neutral when it is not discriminating"
  );

  // Bridge-merge prevention: asymmetric population of a DISCRIMINATING dimension.
  assert(
    !identitiesAreCompatible(
      extractStructuredIdentity(f({
        metric: "revenue", period: "FY2026",
        evidence: [{ metric: "revenue", period: "FY2026", cell_coordinate: "B14" }],
      })),
      extractStructuredIdentity(f({ metric: "revenue", period: "FY2026" }))
    ),
    "a cell-specific finding does not bridge-merge with a generic one"
  );
}

// ===========================================================================
console.log("\n── absorbInto: provenance union ───────────────────────────────");
// ===========================================================================

{
  const rep = f({
    finding_id: "rep-1",
    title: "FY2026 revenue revised down",
    full_analysis: "Representative analysis.",
    claim_ids: ["c1", "c2"],
    source_docs: ["deck.pdf"],
    evidence: [{ figure: "100", source_doc: "deck.pdf", verbatim_snippet: "revenue of 100" }],
    structured_impact: [{ amount: 100, role: "before", currency: "USD" }],
  });
  const abs = f({
    finding_id: "abs-1",
    title: "Revenue restated",
    full_analysis: "Absorbed analysis.",
    claim_ids: ["c2", "c3"],
    source_docs: ["model.xlsx"],
    evidence: [{ figure: "92", source_doc: "model.xlsx", verbatim_snippet: "revenue of 92" }],
    structured_impact: [{ amount: 92, role: "after", currency: "USD" }],
  });

  const merged = absorbInto(rep, abs);

  assertEqual(merged.finding_id, "rep-1", "representative keeps its own finding_id");
  assertEqual(merged.title, "FY2026 revenue revised down", "absorption never rewrites the representative's prose");
  assertEqual([...merged.claim_ids].sort(), ["c1", "c2", "c3"], "claim_ids are unioned without duplicates");
  assertEqual([...merged.source_docs].sort(), ["deck.pdf", "model.xlsx"], "source_docs are unioned");
  assertEqual(merged.evidence.length, 2, "both evidence items survive — distinct figures are not collapsed");
  assertEqual(merged.structured_impact.length, 2, "before and after impacts both survive");
  assertEqual(merged.merged_from_finding_ids, ["abs-1"], "absorbed id is recorded in merged_from_finding_ids");
  assert(
    merged.consolidated_analyses.includes("Absorbed analysis."),
    "the absorbed narrative is retained for the audit trail, not discarded"
  );

  // Fix 15 dedup keys: identical evidence/impact is not duplicated.
  const twin = absorbInto(rep, { ...rep, finding_id: "abs-2" });
  assertEqual(twin.evidence.length, 1, "identical evidence is deduped on figure|source_doc|snippet");
  assertEqual(twin.structured_impact.length, 1, "identical structured_impact is deduped on amount|role|currency");

  // Provenance chains survive multi-level absorption.
  const chained = absorbInto(rep, f({ finding_id: "abs-3", merged_from_finding_ids: ["deep-1", "deep-2"] }));
  assertEqual(
    [...chained.merged_from_finding_ids].sort(),
    ["abs-3", "deep-1", "deep-2"],
    "ids the absorbed finding had itself absorbed are carried through"
  );

  // A representative never lists itself.
  const selfRef = absorbInto(rep, f({ finding_id: "abs-4", merged_from_finding_ids: ["rep-1"] }));
  assert(
    !selfRef.merged_from_finding_ids.includes("rep-1"),
    "representative is never listed inside its own merged_from_finding_ids"
  );
}

// ===========================================================================
console.log("\n── severity ranking ──────────────────────────────────────────");
// ===========================================================================

{
  assert(rankSeverity(f({ severity: "critical" })) > rankSeverity(f({ severity: "warning" })), "critical outranks warning");
  assert(rankSeverity(f({ severity: "warning" })) > rankSeverity(f({ severity: "info" })), "warning outranks info");
  assertEqual(rankSeverity(f({ severity: "nonsense" })), 0, "an unknown severity ranks lowest");
  assertEqual(rankSeverity({}), 0, "a missing severity ranks lowest");
}

// ===========================================================================
console.log("\n── dedupCarryForward: absorption ─────────────────────────────");
// ===========================================================================

{
  // 1. Exact coordinate match → absorbed, not appended.
  const existing = [f({ finding_id: "node-1", metric: "revenue", scope: "consolidated", period: "FY2026" })];
  const carried = [f({ finding_id: "cf-1", metric: "Revenue", scope: "Consolidated", period: "FY 2026" })];

  const r1 = dedupCarryForward({ findings: existing, carried });
  assertEqual(r1.absorbedCount, 1, "a carried finding at an existing coordinate is absorbed");
  assertEqual(r1.carryForward.length, 0, "nothing is appended when everything is absorbed");
  assertEqual(r1.findings.length, 1, "node finding count does not grow");
  assertEqual(r1.findings[0]!.merged_from_finding_ids, ["cf-1"], "absorbed id lands in the representative");
  assertEqual(r1.diagnostics[0]!.coordinate, "revenue|consolidated|fy2026", "diagnostic names the coordinate");
  assert(
    accountedIds(r1.findings).has("cf-1"),
    "FIX 16 CONTRACT: absorbed id is still accounted for in the output"
  );

  // 2. Different coordinate → passes through untouched.
  const r2 = dedupCarryForward({
    findings: [f({ finding_id: "node-1", metric: "revenue", scope: "consolidated", period: "FY2026" })],
    carried: [f({ finding_id: "cf-1", metric: "ebitda", scope: "consolidated", period: "FY2026" })],
  });
  assertEqual(r2.absorbedCount, 0, "a different metric is a different coordinate — no absorption");
  assertEqual(r2.carryForward.length, 1, "the carried finding is still carried forward");
  assert(accountedIds([...r2.findings, ...r2.carryForward]).has("cf-1"), "FIX 16 CONTRACT: nothing lost on pass-through");

  // 3. Same coordinate, gate fails → NOT absorbed. This is the safety property.
  const r3 = dedupCarryForward({
    findings: [f({ finding_id: "node-1", metric: "revenue", scope: "consolidated", period: "FY2026", currency: "USD" })],
    carried: [f({ finding_id: "cf-1", metric: "revenue", scope: "consolidated", period: "FY2026", currency: "EUR" })],
  });
  assertEqual(r3.absorbedCount, 0, "matching coordinate does NOT override a failing compatibility gate");
  assertEqual(r3.carryForward.length, 1, "gate failure means carry forward verbatim, exactly as before Fix 25");

  // 4. Undetermined coordinate → never absorbed (fail-safe toward preservation).
  const r4 = dedupCarryForward({
    findings: [f({ finding_id: "node-1", metric: "revenue", scope: "consolidated", period: "FY2026" })],
    carried: [f({ finding_id: "cf-1", scope: "consolidated", period: "FY2026" })], // no metric
  });
  assertEqual(r4.absorbedCount, 0, "an undetermined coordinate is never absorbed");
  assertEqual(r4.undeterminedCoordinateCount, 1, "undetermined coordinates are counted for diagnostics");
  assertEqual(r4.carryForward.length, 1, "undetermined coordinate → carried forward verbatim");

  // 5. Higher-severity carried finding takes the representative seat.
  const r5 = dedupCarryForward({
    findings: [f({ finding_id: "node-1", severity: "info", metric: "revenue", scope: "consolidated", period: "FY2026" })],
    carried: [f({ finding_id: "cf-1", severity: "critical", metric: "revenue", scope: "consolidated", period: "FY2026" })],
  });
  assertEqual(r5.absorbedCount, 1, "severity difference does not prevent absorption");
  assertEqual(r5.findings[0]!.finding_id, "cf-1", "the critical becomes the representative");
  assertEqual(r5.findings[0]!.severity, "critical", "a critical is never demoted into a warning's provenance");
  assertEqual(r5.findings[0]!.merged_from_finding_ids, ["node-1"], "the incumbent is absorbed into the critical");
  assert(
    accountedIds(r5.findings).has("node-1") && accountedIds(r5.findings).has("cf-1"),
    "FIX 16 CONTRACT: both ids remain accounted for after a representative swap"
  );

  // 6. Carried findings dedup against EACH OTHER — a family arriving together collapses.
  const r6 = dedupCarryForward({
    findings: [],
    carried: [
      f({ finding_id: "cf-1", metric: "revenue", scope: "consolidated", period: "FY2026" }),
      f({ finding_id: "cf-2", metric: "revenue", scope: "consolidated", period: "FY2026" }),
      f({ finding_id: "cf-3", metric: "revenue", scope: "consolidated", period: "FY2026" }),
    ],
  });
  assertEqual(r6.absorbedCount, 2, "a family of three duplicates collapses to one representative");
  assertEqual(r6.carryForward.length, 1, "only one finding is appended for the whole family");
  assertEqual(
    [...r6.carryForward[0]!.merged_from_finding_ids].sort(),
    ["cf-2", "cf-3"],
    "both absorbed siblings are recorded on the representative"
  );
  assert(
    ["cf-1", "cf-2", "cf-3"].every(id => accountedIds([...r6.findings, ...r6.carryForward]).has(id)),
    "FIX 16 CONTRACT: no id is lost when a family collapses"
  );
}

// ===========================================================================
console.log("\n── the FY2026 revision family (the observed case) ────────────");
// ===========================================================================

{
  // Devanshu's observation: the last gate run passed all 78 findings, including
  // three describing the SAME FY2026 revenue revision at three severities. The
  // dedup gate in finding-reduction-gate.ts is a `return { passed: true }` stub
  // and consolidateFamilies only builds an advisory map, so nothing collapsed
  // them.
  //
  // Fix 25 collapses this family ONLY when the findings do not cite mutually
  // exclusive source documents. See the "source_doc" block below — that is a
  // real, pinned limitation of the lifted gate, not an oversight.
  const revisionFamily = [
    f({
      finding_id: "rev-critical", severity: "critical",
      metric: "revenue", scope: "consolidated", period: "FY2026",
      full_analysis: "FY2026 revenue guidance revised down 8%.",
      claim_ids: ["c-deck-1"], source_docs: ["IC Deck v3.pdf"],
    }),
    f({
      finding_id: "rev-warning", severity: "warning",
      metric: "Revenue", scope: "Consolidated", period: "FY 2026",
      full_analysis: "FY2026 topline restated in the operating model.",
      claim_ids: ["c-model-1"], source_docs: ["Operating Model.xlsx"],
    }),
    f({
      finding_id: "rev-info", severity: "info",
      metric: "revenue", scope: "consolidated", period: "FY2026",
      full_analysis: "Minor note on FY2026 revenue presentation.",
      claim_ids: ["c-memo-1"], source_docs: ["Memo.docx"],
    }),
  ];

  const result = dedupCarryForward({ findings: [], carried: revisionFamily });
  const after = result.findings.length + result.carryForward.length;

  assertEqual(revisionFamily.length, 3, "the family starts as three separate findings");
  assertEqual(after, 1, "the family collapses to one finding");
  assertEqual(result.absorbedCount, 2, "two of the three are absorbed as provenance");

  const rep = result.carryForward[0]!;
  assertEqual(rep.finding_id, "rev-critical", "the critical is the surviving representative");
  assertEqual(rep.severity, "critical", "the highest severity is preserved");
  assertEqual(
    [...rep.claim_ids].sort(),
    ["c-deck-1", "c-memo-1", "c-model-1"],
    "claims from all three findings are preserved on the representative"
  );
  assertEqual(
    [...rep.source_docs].sort(),
    ["IC Deck v3.pdf", "Memo.docx", "Operating Model.xlsx"],
    "all three source documents remain attributable via source_docs"
  );
  assertEqual(rep.consolidated_analyses.length, 2, "both absorbed narratives are kept for the audit trail");
  assert(
    ["rev-critical", "rev-warning", "rev-info"].every(id => accountedIds([rep]).has(id)),
    "FIX 16 CONTRACT: all three original ids are accounted for by the single representative"
  );
}

// ===========================================================================
console.log("\n── PINNED LIMITATION: evidence[].source_doc blocks merges ───");
// ===========================================================================

{
  // The gate lifted from `runPostMergePipeline` treats `evidence[].source_doc`
  // as an IDENTITY dimension under the "both present → require overlap" rule.
  // `source_doc` is NOT in DISCRIMINATING_DIMENSIONS, so asymmetric population
  // is tolerated — but two findings that BOTH cite evidence, from DIFFERENT
  // documents, conflict and can never merge.
  //
  // The consequence is specific and worth stating plainly: a cross-document
  // revision family — the $100m figure in the deck vs the $92m figure in the
  // model, which is the canonical thing this pipeline exists to surface — is
  // NOT collapsed once both sides carry evidence[] entries. Only the
  // no-evidence or same-document cases collapse.
  //
  // This test pins that behaviour deliberately. It is NOT an endorsement.
  // Whether `source_doc` belongs in identity at all (it is arguably provenance,
  // not identity) changes which findings merge, and therefore changes report
  // composition — a product decision, not a refactor. Left verbatim pending that
  // decision. If it is later removed from identity, THIS TEST SHOULD FLIP and
  // the assertion below should become `absorbedCount === 1`.
  const deckSide = f({
    finding_id: "ev-deck", severity: "critical",
    metric: "revenue", scope: "consolidated", period: "FY2026",
    evidence: [{ figure: "100.0", source_doc: "IC Deck v3.pdf", verbatim_snippet: "FY26E revenue $100.0m" }],
  });
  const modelSide = f({
    finding_id: "ev-model", severity: "warning",
    metric: "revenue", scope: "consolidated", period: "FY2026",
    evidence: [{ figure: "92.0", source_doc: "Operating Model.xlsx", verbatim_snippet: "FY26 revenue 92.0" }],
  });

  assertEqual(
    coordinateKey(deckSide),
    coordinateKey(modelSide),
    "both sides sit at the SAME coordinate — the prefilter matches them"
  );

  assert(
    !areCompatibleForMerge(deckSide, modelSide),
    "PINNED: differing evidence[].source_doc blocks the merge despite identical coordinates"
  );

  const blocked = dedupCarryForward({ findings: [deckSide], carried: [modelSide] });
  assertEqual(blocked.absorbedCount, 0, "PINNED: the cross-document revision pair is NOT collapsed today");
  assertEqual(blocked.carryForward.length, 1, "PINNED: the model-side finding is carried forward verbatim");
  assert(
    accountedIds([...blocked.findings, ...blocked.carryForward]).has("ev-model"),
    "FIX 16 CONTRACT: the un-absorbed finding is still fully accounted for"
  );

  // Same document on both sides DOES collapse — this is the accumulation case,
  // where the identical finding object is carried up level after level and its
  // evidence (and therefore its source_doc set) is preserved exactly.
  const sameDocA = f({
    finding_id: "ev-same-a", severity: "warning",
    metric: "revenue", scope: "consolidated", period: "FY2026",
    evidence: [{ figure: "100.0", source_doc: "IC Deck v3.pdf", verbatim_snippet: "FY26E revenue $100.0m" }],
  });
  const sameDocB = { ...sameDocA, finding_id: "ev-same-b" };

  const collapsed = dedupCarryForward({ findings: [sameDocA], carried: [sameDocB] });
  assertEqual(collapsed.absorbedCount, 1, "the same finding carried up twice DOES collapse");
  assertEqual(collapsed.carryForward.length, 0, "the repeat is absorbed, not appended");
  assertEqual(collapsed.findings[0]!.evidence.length, 1, "identical evidence is not duplicated by the union");
}

// ===========================================================================
console.log("\n── accumulation: the property the tree actually needed ───────");
// ===========================================================================

{
  // Simulate the shape of the failure. A node emits a handful of findings and
  // carries the rest forward; the carried set contains many duplicates of what
  // was emitted. Before Fix 25 the node's output was emitted + carried. After,
  // duplicates fold into the emitted set.
  const emitted = [
    f({ finding_id: "e-1", metric: "revenue", scope: "consolidated", period: "FY2026" }),
    f({ finding_id: "e-2", metric: "ebitda", scope: "consolidated", period: "FY2026" }),
    f({ finding_id: "e-3", metric: "net_debt", scope: "consolidated", period: "FY2025" }),
  ];

  // 12 carried: 9 duplicates of the emitted coordinates, 3 genuinely novel.
  const carried: AnyFinding[] = [];
  for (let i = 0; i < 3; i++) {
    carried.push(f({ finding_id: `d-rev-${i}`, metric: "revenue", scope: "consolidated", period: "FY2026" }));
    carried.push(f({ finding_id: `d-ebitda-${i}`, metric: "ebitda", scope: "consolidated", period: "FY2026" }));
    carried.push(f({ finding_id: `d-debt-${i}`, metric: "net_debt", scope: "consolidated", period: "FY2025" }));
  }
  carried.push(f({ finding_id: "n-1", metric: "capex", scope: "consolidated", period: "FY2026" }));
  carried.push(f({ finding_id: "n-2", metric: "working_capital", scope: "consolidated", period: "FY2026" }));
  carried.push(f({ finding_id: "n-3", metric: "revenue", scope: "north_america", period: "FY2026" }));

  const naiveCount = emitted.length + carried.length; // old Fix 16 behaviour
  const result = dedupCarryForward({ findings: emitted, carried });
  const dedupedCount = result.findings.length + result.carryForward.length;

  assertEqual(naiveCount, 15, "old behaviour: the node would hold 15 findings");
  assertEqual(dedupedCount, 6, "new behaviour: 3 emitted + 3 genuinely novel");
  assertEqual(result.absorbedCount, 9, "all nine duplicates became provenance");
  assert(dedupedCount < naiveCount, "ACCUMULATION IS BROKEN: the node no longer grows by every carried finding");

  // The segment-level revenue finding must NOT have been folded into the
  // consolidated one — different scope is a different coordinate.
  const allOut = [...result.findings, ...result.carryForward];
  assert(
    allOut.some(x => x.finding_id === "n-3"),
    "a north_america revenue finding survives alongside the consolidated one"
  );

  // And nothing was lost.
  const out = accountedIds(allOut);
  const allInputIds = [...emitted, ...carried].map(x => x.finding_id as string);
  const unaccounted = allInputIds.filter(id => !out.has(id));
  assertEqual(unaccounted, [], "FIX 16 CONTRACT: zero unaccounted findings across 15 inputs");
}

// ===========================================================================
console.log("\n── idempotence and no-op safety ──────────────────────────────");
// ===========================================================================

{
  // No carried findings → the node is returned untouched.
  const nodeFindings = [f({ finding_id: "node-1", metric: "revenue", scope: "consolidated", period: "FY2026" })];
  const noop = dedupCarryForward({ findings: nodeFindings, carried: [] });
  assertEqual(noop.absorbedCount, 0, "an empty carried set absorbs nothing");
  assertEqual(noop.findings.length, 1, "an empty carried set leaves the node unchanged");
  assertEqual(noop.carryForward.length, 0, "an empty carried set produces an empty carry-forward");

  // The input arrays are not mutated — the caller reassigns from the result.
  const originalFindings = [f({ finding_id: "node-1", metric: "revenue", scope: "consolidated", period: "FY2026" })];
  const snapshot = JSON.stringify(originalFindings);
  dedupCarryForward({
    findings: originalFindings,
    carried: [f({ finding_id: "cf-1", metric: "revenue", scope: "consolidated", period: "FY2026" })],
  });
  assertEqual(JSON.stringify(originalFindings), snapshot, "the caller's findings array is not mutated in place");

  // Running twice on an already-deduped result absorbs nothing new.
  const first = dedupCarryForward({
    findings: [f({ finding_id: "node-1", metric: "revenue", scope: "consolidated", period: "FY2026" })],
    carried: [f({ finding_id: "cf-1", metric: "revenue", scope: "consolidated", period: "FY2026" })],
  });
  const second = dedupCarryForward({ findings: first.findings, carried: [] });
  assertEqual(second.absorbedCount, 0, "dedup is idempotent — a second pass finds nothing to absorb");
  assertEqual(second.findings.length, first.findings.length, "a second pass does not change the finding count");
}

// ===========================================================================
console.log(`\n${"═".repeat(66)}`);
console.log(`Fix 25 — carry-forward dedup:  ${passed} passed, ${failed} failed`);
console.log("═".repeat(66));
if (failed > 0) process.exit(1);
