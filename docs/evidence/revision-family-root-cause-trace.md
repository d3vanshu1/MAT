# Revision Family — Root-Cause Trace

**Finding family:** 9 of 84 findings (10.7%) — one critical, four warning, four info  
**All nine assert:** "FY2026 Model Revision" — a wrong interpretation  
**Ground truth:** `FS Summary` shows Actual across FY23-26; `FS Summary (hardcoded)` shows Forecast from FY26. The business came in £2.7m under a frozen forecast. Not a revision.

---

## The Defect Chain

### Step 1: Column Header Enrichment

**File:** `server/apis/pipeline/numeric-verify-inline.ts`  
**Function:** `enrichColHeadersWithYears` (line 1007)

Row 0 of each sheet contains numeric year values (2023, 2024, 2025, 2026). The column headers from SheetJS parsing contain qualifiers like "Actual" or "Forecast" but often lack the year. `enrichColHeadersWithYears` forward-fills the year into each header:

- `FS Summary` column headers become: `"2023 Actual"`, `"2024 Actual"`, `"2025 Actual"`, `"2026 Actual"`
- `FS Summary (hardcoded)` column headers become: `"2023 Actual"`, `"2024 Actual"`, `"2025 Actual"`, `"2026 Forecast"`

### Step 2: Period Normalization (preserves qualifier)

**File:** `server/apis/pipeline/numeric-verify-inline.ts`  
**Function:** `normalizePeriod` (line 416)

```typescript
function normalizePeriod(label: string): string {
  const cleaned = label.trim().toLowerCase();
  const yearMatch = cleaned.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const year = yearMatch[1];
    const qualifierMatch = cleaned.match(/\b(actual|forecast|budget|plan)\b/);
    if (qualifierMatch) return `${year} ${qualifierMatch[1]}`;
    return year;
  }
  return cleaned;
}
```

This correctly distinguishes `"2026 actual"` from `"2026 forecast"` **within a single sheet** — preventing intra-sheet dedup collisions.

### Step 3: periodBaseYear (strips qualifier) — THE DEFECT

**File:** `server/apis/pipeline/numeric-verify-inline.ts`  
**Function:** `periodBaseYear` (line 436)

```typescript
function periodBaseYear(period: string): string {
  const yearMatch = period.match(/^(20\d{2})/);
  return yearMatch ? yearMatch[1] : period;
}
```

**What it does:** Strips everything after the four-digit year. `"2026 actual"` → `"2026"`. `"2026 forecast"` → `"2026"`.

**The comment above it states the intent explicitly (line 431–434):**
> *"Strip qualifier from a normalized period to get the base year for cross-sheet matching. '2026 actual' → '2026', '2026 forecast' → '2026'. This allows comparing live-model 'actual' columns against hardcoded-model 'forecast' columns (same business concept, different time-based qualifiers)."*

### Step 4: Cross-Agreement Map Key Construction

**File:** `server/apis/pipeline/numeric-verify-inline.ts`  
**Lines:** 641, 648

```typescript
const key = `${e.label.trim().toLowerCase()}::${periodBaseYear(e.period)}`;
```

Both maps (source A = `FS Summary`, source B = `FS Summary (hardcoded)`) are keyed by `label::baseYear`. Because `periodBaseYear` strips the qualifier:

- `FS Summary` entry: `"revenue::2026"` (value = £184.4m actual)
- `FS Summary (hardcoded)` entry: `"revenue::2026"` (value = £187.1m forecast)

**They match on the same key despite being semantically different data points** — one is a realised actual, the other is a frozen forecast.

### Step 5: Discrepancy Emission

**File:** `server/apis/pipeline/numeric-verify-inline.ts`  
**Line:** 721

```typescript
const period = periodBaseYear(entryA.period);
```

The comparison at line 717–725 computes the absolute and relative difference. When £184.4m actual ≠ £187.1m forecast (Δ = £2.7m, 1.5%), the threshold is exceeded and a discrepancy is emitted.

The comment at line 627–628 confirms this is intentional design:
> *"Cross-agreement uses BASE YEAR (no qualifier) so that live-model 'actual' columns match hardcoded-model 'forecast' columns for the same fiscal year."*

---

## Downstream Propagation

### Path A: NumericVerify → claims-reconciliation.ts (deterministic)

`claims-reconciliation.ts` Step 5 picks up NumericVerify's discrepancies and produces `cross_version` findings. The A3 fix correctly labels them as `"Forecast vs realised actual: 2026"` with `finding_kind: "cross_version"`. These are properly classified — they say what they are.

### Path B: Sub-agent (LLM) — the nine findings

The merge-tree sub-agent receives both model files in its context window. It independently sees that:
- `FS Summary` has `£184.4m` at FY26
- `FS Summary (hardcoded)` has `£187.1m` at FY26

The sub-agent infers this is a "model revision" and generates 9 separate `data_divergence` findings across multiple severity tiers. This is the wrong interpretation — but the sub-agent has no way to distinguish "forecast vs actual" from "revision" without reading the column qualifier.

---

## Root Cause Verdict

**NumericVerify's cross-agreement is the defect.** It is the one component with no model in the path, and it deliberately compares a forecast column against an actual column by stripping the `Actual`/`Forecast` qualifier.

The design comment says this is intentional — the intent is to detect "same fiscal year, different data = divergence." But the semantic meaning is:

> "A frozen forecast for 2026 differs from the realised actual for 2026."

That is not a discrepancy. That is the normal passage of time. Every forecast that isn't perfectly accurate will trigger this comparison.

### The three consequences:

1. **NumericVerify emits false discrepancies** — comparing forecast to actual is not a meaningful check. The £2.7m delta (1.5%) represents business underperformance vs plan, not a data error.

2. **claims-reconciliation propagates them** — but at least labels them correctly as `cross_version`. These are suppressible downstream.

3. **The merge-tree sub-agent generates 9 independent findings** — it sees the same data pair, lacks the column-qualifier context, and generates the wrong interpretation. These are the 9 findings that ship as "model revision."

### The deterministic defect is worse than the nine findings

The nine findings are one run's output. The `periodBaseYear` stripping ensures that **every deal with an actual-vs-forecast sheet pair** will produce false discrepancies in the deterministic layer. It is a systematic defect, not a one-off misinterpretation.

---

## Fix Required (not implemented — frozen per spec)

`periodBaseYear` should NOT strip `actual`/`forecast` qualifiers for cross-sheet matching when the two sheets represent different time contexts (actual vs forecast). Options:

1. **Compare only same-qualifier columns:** `"2026 actual"` matches `"2026 actual"` across sheets; `"2026 forecast"` matches `"2026 forecast"`. No cross-qualifier comparison.
2. **Add a config flag:** `allowCrossQualifierComparison: false` to `CrossAgreementConfig`, defaulting to strict same-qualifier matching.
3. **Detect sheet semantics:** If source A's 2026 columns are all "actual" and source B's are "forecast", the comparison is forecast-vs-actual and should emit a `cross_version` informational note rather than a discrepancy.

Current status: **frozen per spec** — `normalizePeriod`, `periodBaseYear`, and `claims-reconciliation.ts` are not to be modified in this session.
