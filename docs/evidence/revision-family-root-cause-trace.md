# Revision Family — Root-Cause Trace (verified against code)

**Finding family:** 9 of 84 findings (10.7%) — one critical, four warning, four info
**All nine assert:** "FY2026 Model Revision"
**Ground truth:** `FS Summary` is Actual across FY23-26; `FS Summary (hardcoded)` is Forecast from FY26. The business came in £2.7m under a frozen forecast. Not a revision.

Every line reference below was read and confirmed in `server/apis/pipeline/numeric-verify-inline.ts` (1437 lines).

---

## Answer to the three questions

### Q1 — `periodBaseYear` verbatim, and what it does with `Forecast` vs `Actual`

**`server/apis/pipeline/numeric-verify-inline.ts:436`**

```typescript
function periodBaseYear(period: string): string {
  const yearMatch = period.match(/^(20\d{2})/);
  return yearMatch ? yearMatch[1] : period;
}
```

It truncates at the four-digit year. `"2026 actual"` → `"2026"`. `"2026 forecast"` → `"2026"`. **The two become indistinguishable.**

The docstring immediately above it (lines 430–435) states this is deliberate:

> *"Strip qualifier from a normalized period to get the base year for cross-sheet matching. `"2026 actual"` → `"2026"`, `"2026 forecast"` → `"2026"`, `"2026"` → `"2026"`. This allows comparing live-model "actual" columns against hardcoded-model "forecast" columns (same business concept, different time-based qualifiers)."*

The phrase **"same business concept"** is the defect stated as intent. A 2026 forecast and a 2026 actual are not the same business concept.

### Q2 — Where the two `FS Summary` sheets are compared, and whether the comparison reads the qualifier

**Config — lines 220–229:**

```typescript
const SCG_CROSS_AGREEMENT_TEMPLATE = {
  sourceASheet: "FS Summary",              // live / actual
  sourceBSheet: "FS Summary (hardcoded)",  // frozen forecast
  matchingRule: "exact",
  absThreshold: 1_000,      // £1k
  relThreshold: 0.0001,     // 0.01%
  materialityAbsFloor: 500_000,
  materialityRelFloor: 0.05,
};
```

`matchingRule: "exact"` governs **sheet-name** matching only (`matchesCrossSheet`, line 452). There is no period-qualifier guard anywhere in the config type.

**Does the comparison read the `Actual`/`Forecast` header row?**

**Yes — and this is the important part. It reads it, normalises it, keeps it, and then throws it away at the moment of comparison.**

1. **Line 840** — the qualifier is read and preserved on every entry:
   ```typescript
   periodCols.push({ colIdx: ci, period: normalizePeriod(colHeaders[ci]) });
   ```
   `normalizePeriod` (line 416) explicitly retains it: `"2026 actual"` stays `"2026 actual"`, `"2026 forecast"` stays `"2026 forecast"`. Its own comment says this preserves the distinction "for display and intra-sheet dedup (so `2026 Actual` ≠ `2026 Forecast` within one sheet)."

   So **within** one sheet the distinction is enforced. **Across** sheets it is discarded.

2. **Lines 641 and 648** — the map keys strip it:
   ```typescript
   const key = `${e.label.trim().toLowerCase()}::${periodBaseYear(e.period)}`;
   ```
   - `FS Summary` → `"revenue::2026"` (£184.4m, **actual**)
   - `FS Summary (hardcoded)` → `"revenue::2026"` (£187.1m, **forecast**)

   Same key. They collide.

3. **Line 675** — the loop pairs them on that key:
   ```typescript
   for (const [key, entryA] of mapA) {
     const entryB = mapB.get(key);
     if (!entryB) continue;
   ```

4. **Lines 721–732** — the divergence is recorded, and **the qualifier is dropped**:
   ```typescript
   const period = periodBaseYear(entryA.period);   // ← stripped again
   divergencesByPeriod.get(period)!.push({
     label: entryA.label,
     valueA: entryA.value,
     valueB: entryB.value,
     absDiff,
     relDiffPct: relDiff * 100,
     refA: entryA.sourceRef,
     refB: entryB.sourceRef,
   });
   ```

   At this exact line, `entryA.period === "2026 actual"` and `entryB.period === "2026 forecast"` are **both in scope**. Neither is compared to the other. Neither is written into the record. The one field that would identify this as forecast-vs-actual is available and unused.

The comment at lines 626–627 confirms the design:
> *"Cross-agreement uses BASE YEAR (no qualifier) so that live-model "actual" columns match hardcoded-model "forecast" columns for the same fiscal year."*

### Q3 — Is NumericVerify's cross-agreement doing the same thing? **Yes. It is the origin.**

The thresholds make firing certain. The FY26 delta is £2.7m at ~1.5%:

| Gate | Threshold | FY26 delta | Fires? |
|---|---|---|---|
| `absThreshold` | £1,000 | £2,700,000 | Yes — 2,700× over |
| `relThreshold` | 0.01% | ~1.5% | Yes — 150× over |
| `maxRatio` guard | ratio > maxRatio skips | 187.1/184.4 = 1.015 | No skip |

The `maxRatio` guard (lines 700–709) exists to catch YTD-vs-full-year mismatches. A forecast and an actual for the same year are nearly equal in magnitude, so **the guard that could have caught this is precisely the one a forecast-vs-actual pair sails through.** The closer the forecast was to reality, the more certainly it is reported as a discrepancy.

**This is a defect in the deterministic layer — the one component with no model in the path.**

---

## The defect chain, end to end

| Step | Location | What happens |
|---|---|---|
| 1 | `enrichColHeadersWithYears` (~line 1007) | Forward-fills years into headers → `"2026 Actual"`, `"2026 Forecast"` |
| 2 | `normalizePeriod` (line 416) | **Preserves** qualifier → `"2026 actual"` / `"2026 forecast"` |
| 3 | `extractAllNumericEntries` (line 840) | Stores qualifier on entry `.period` |
| 4 | `periodBaseYear` (line 436) | **Strips** qualifier → `"2026"` |
| 5 | Map keys (lines 641, 648) | Both sheets key to `"revenue::2026"` — collide |
| 6 | Pair loop (line 675) | Actual paired against forecast |
| 7 | Thresholds (line 718) | £2.7m / 1.5% clears £1k / 0.01% trivially |
| 8 | Record (lines 721–732) | Qualifier **available and discarded** |

## Downstream

**Path A — deterministic.** `claims-reconciliation.ts:1350–1372` (A3 fix) inspects sheet names for `/hardcoded/i` and relabels the finding `"Forecast vs realised actual: <period>"` with `finding_kind: "cross_version"`. **This is a downstream repair of an upstream defect** — it recovers the distinction from the sheet name because the period qualifier was already thrown away. It labels correctly, but the false discrepancy was still generated.

**Path B — the nine findings.** The merge-tree sub-agent sees both sheets in context, sees £184.4m against £187.1m at FY26, and infers a revision. It has no column-qualifier context and produces 9 `data_divergence` findings across all severity tiers. These are the nine that ship.

---

## Verdict

**NumericVerify's cross-agreement is the root cause, and it matters more than the nine findings.**

The nine are one run's output. The `periodBaseYear` strip guarantees that **every deal with an actual-vs-forecast sheet pair produces false discrepancies in the deterministic layer**, at thresholds of £1k / 0.01%, with the magnitude guard structurally unable to catch them.

`claims-reconciliation.ts` masks the symptom by re-deriving the distinction from the sheet name. The sub-agent, having no such repair, produces the wrong interpretation.

**The semantic content of the emitted discrepancy is:** *"a frozen forecast for 2026 differs from the realised actual for 2026."* That is not a discrepancy. That is the passage of time.

---

## Fix — specified, not implemented

`periodBaseYear`, `normalizePeriod` and `claims-reconciliation.ts` are **frozen per spec**. No change made. The fix, for when the freeze lifts:

1. **Same-qualifier matching only** — key on `normalizePeriod` output rather than `periodBaseYear` for cross-sheet comparison. `"2026 actual"` matches `"2026 actual"`; forecast-vs-actual never pairs.
2. **Config flag** — add `allowCrossQualifierComparison?: boolean` to `CrossAgreementConfig`, default `false`.
3. **Carry the qualifier into the record** — add `qualifierA` / `qualifierB` to the divergence object at lines 721–732 so downstream can classify without re-deriving from sheet names. This is the minimal change and it is strictly additive.

Option 3 is the one worth taking first: it is additive, it does not alter matching behaviour, and it removes the need for the A3 sheet-name repair in `claims-reconciliation.ts`.
