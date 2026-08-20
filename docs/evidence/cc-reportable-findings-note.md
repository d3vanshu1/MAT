# Contradiction Check — Reportable Findings

**Deal:** Project Saint (SCG)  
**Module:** contradiction_check  
**Run:** bc6b519f-9cf1-452c-88ba-c03547bd0469  
**Date:** 2026-08-20  

---

## Finding #1 — FY26 Revenue: Memo vs Model

**Classification:** Contradiction  
**Severity:** Warning  
**Status:** Both paths found independently (merge-tree and claims-reconciliation)

### Memo claims (verbatim)

**Screening Memo (£192m):**
> "SCG is expected to deliver £192m revenue for FY Mar-26"

— *SCG IC Screening Memo vS.pdf*, Executive Summary (1/3), financial performance section.

**2nd IC Memo (£194m):**
> Revenue figure of £194m referenced in deal context.

— *2nd IC Memo*, financial section.

Both memos carry a figure above the model. This is not one memo's error — it is consistent across two independent documents.

### Source figure

The financial model (`FS Summary` sheet) shows total FY26 revenue of **£184,391,535**.

**Location:** `FS Summary.xlsx`, FY26 revenue row (actual).

### Arithmetic

| Source | Claim | Delta vs Model | % Overstatement |
|--------|-------|----------------|-----------------|
| Screening Memo | £192m | £7.6m | 3.9% |
| 2nd IC Memo | £194m | £9.6m | 5.2% |

### Significance

Two IC memos present revenue figures £7.6m–£9.6m higher than the model's own output. At 11.6x entry EBITDA, a revenue overstatement of this magnitude — if it flows through to GP — could represent ~£88m–£112m of implied enterprise value above what the model supports. This is the single strongest numeric contradiction in the data room.

---

## Finding #9 — Historical GP CAGR: Memo vs Verified

**Classification:** Contradiction  
**Severity:** Warning  
**Status:** Old path only (strongest argument for retained value of the reconciliation path)

### Memo claim (verbatim)

> "SCG achieved 12% organic GP growth from FY23-25"  
> (Elsewhere described as "~10% Historical GP CAGR")

— *SCG IC Screening Memo vS.pdf*, Financial Overview & Returns section, page 13. Also: 2nd IC Memo.

### Source figures

From the model (`FS Summary` sheet, GP row):

| Year | Gross Profit |
|------|-------------|
| FY23 | £100.5m |
| FY24 | £117.2m |
| FY25 | £137.1m |
| FY26 | £149.7m |

### Arithmetic

Three-year CAGR (FY23 → FY26): (149.7 / 100.5)^(1/3) − 1 = **14.3%**  
Two-year CAGR (FY23 → FY25): (137.1 / 100.5)^(1/2) − 1 = **16.8%**

The memo's "~10%" and "12%" figures both understate the model's own GP trajectory.

### Significance

This is the second independent contradiction and it came from the old reconciliation path alone — the merge-tree did not surface it. The understatement is directionally favourable to the deal team (presenting more conservative growth) but is still a material discrepancy between what the memo tells the IC and what the financial model shows. The IC is being presented with artificially muted growth that may understate the business's actual performance trajectory by 2–5 percentage points.

---

## Finding #4 — Top-Tier Customer Concentration

**Classification:** Observation (not a contradiction)  
**Severity:** Info

### Memo claim

The IC Screening Memo extraction references top-tier customers as accounting for **"88% of GP"** (gross profit) — the highest-value customer cohort.

— *SCG IC Screening Memo vS.pdf*, part 6, customer revenue section.

The IM's customer segmentation (not present in exported extraction chunks) is reported by the module as showing "89% Diamond tier concentration." **This 89% figure cannot be independently traced to a document in the current extraction corpus.** The verifiable figure is 88% of GP from the Screening Memo.

### Source figure

The Screening Memo's own customer data states top-tier customers **"account for 88% of GP."**

**Location:** SCG IC Screening Memo vS.pdf (part 6), customer revenue data.

### Significance

88% gross profit concentration in the top customer tier represents an extreme dependency. No IC memo version addresses what happens if top-tier churn accelerates above the blended 5–7% rate. The Screening Memo flags customer concentration as a critical omission but no subsequent IC document resolves it with a mitigation strategy, diversification roadmap, or downside stress-test.

---

## Finding #5 — Interest Coverage at Entry: Minimal Headroom

**Classification:** Observation (not a contradiction)  
**Severity:** Info

### Memo claims (verbatim)

Two tables in the IC Update state different coverage figures:

**Cashflow and Leverage Profile (flat/base case, part 3):**
> "Interest Coverage: 1.7x" (entry)  
> "Interest coverage will remain constant at 1.7x-1.8x through FY32"

— *2026-06-21 Saint IC update_vS.pdf*, part 3, Cashflow and Leverage Profile table.

**Returns and leverage table (M&A case, part 4):**
> "Interest Coverage Year 1: 1.9x"

— *2026-06-21 Saint IC update_vS.pdf*, part 4, leverage table.

### Source figures

| Metric | Value | Source |
|--------|-------|--------|
| Entry organic adjusted cash EBITDA | £54.9m | IC Update part 3 |
| FY27E total EBITDA (organic + near-term M&A) | £60.0m | IC Update part 3 (£57.1m + £2.9m) |
| Entry annual cash interest (flat case) | £37.0m | IC Update part 3 |
| Entry annual cash interest (returns case) | £36.2m | IC Update part 4 |
| Entry gross debt | £410.0m | IC Update part 3 |
| Entry net debt | £400.0m | IC Update part 3 |
| Entry leverage | 6.5x | IC Update part 3 |

### Derivation

The two coverage figures derive from different EBITDA / interest combinations:

- **1.7x** = memo-stated figure from flat-case profile. Implied EBITDA for 1.7x at £37.0m interest: £62.9m — likely the total adjusted EBITDA (organic + M&A + adjustments) used in the flat case.
- **1.9x** = memo-stated figure from M&A returns case. Implied EBITDA for 1.9x at £36.2m interest: £68.8m — likely a higher EBITDA run-rate assumed in the returns case with full M&A accretion.

Neither figure derives cleanly from £54.9m ÷ £37.0m (= 1.48x) or £54.9m ÷ £36.2m (= 1.52x). Both memo figures use an adjusted EBITDA basis that includes run-rate M&A contribution beyond the organic figure. The exact composition is not disclosed.

### The deal team's own assessment

The IC Update's extraction flags this directly:  
> *"Interest coverage declining to 1.9x in year 1 leaves minimal cushion for operational underperformance or rising rates."*  
> *"Interest coverage remains flat at 1.7x-1.8x despite increasing EBITDA and declining leverage"*

**The deal team raised the risk themselves.** This finding is not "the module discovered something missed" — it is "the deal team flagged covenant headroom as a concern, and here is the arithmetic confirming why."

### Significance

Interest coverage of 1.7x at entry leaves less than one turn of EBITDA headroom before debt service consumes operating cash flow. With 6.5x entry leverage and £410m gross debt, any operational shortfall could trigger covenant pressure. The deal team has identified this risk in the IC Update but no explicit mitigation (hedging, cash reserve, EBITDA floor covenant) is documented in the data room.

---

## Summary

| # | Finding | Type | Path |
|---|---------|------|------|
| 1 | FY26 revenue: Screening Memo £192m / 2nd IC Memo £194m vs model £184.4m | Contradiction | Both (merge-tree + reconciliation) |
| 9 | Historical GP CAGR: memo ~10–12% vs verified 14.3% | Contradiction | Old path only |
| 4 | Top-tier customers account for 88% of GP, unmitigated | Observation | Merge-tree |
| 5 | Interest coverage 1.7x (flat case) / 1.9x (M&A case), deal-team-flagged | Observation | Merge-tree |

**#1 and #9 are genuine contradictions** — they assert specific figures that differ materially from the financial model.

**#4 and #5 are observations** — they flag risks that are internally consistent within the data room but represent material exposures the IC should weigh. They need no delta and should not be presented as though a numeric comparison produced them.

**#9 is the strongest argument yet that the old reconciliation path retains value the rebuilt path does not currently reach.** It was surfaced by the deterministic cross-agreement layer, verified arithmetically, and never independently produced by the merge-tree.
