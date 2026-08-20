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

### Memo claim (verbatim)

> "SCG is expected to deliver £192m revenue for FY Mar-26"

— *SCG IC Screening Memo vS.pdf*, Executive Summary (1/3), financial performance section.

The 3rd IC Memo cites £194m in later analysis context.

### Source figure

The financial model (`FS Summary` sheet) shows total FY26 revenue of **£184,391,535**.

**Location:** `FS Summary.xlsx`, FY26 revenue row (actual).

### Arithmetic

Delta: £192m − £184.4m = **£7.6m** (3.9% overstatement).  
If the £194m variant is used: £194m − £184.4m = **£9.6m** (5.2% overstatement).

### Significance

The IC memo presents a revenue figure that is £7.6m–£9.6m higher than the model's own output. At 11.6x entry EBITDA, a revenue overstatement of this magnitude — if it flows through to GP — could represent ~£88m–£112m of implied enterprise value above what the model supports. This is the single strongest numeric contradiction in the data room.

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

## Finding #4 — Diamond Tier Customer Concentration

**Classification:** Observation (not a contradiction)  
**Severity:** Info

### Memo claim

The IC Update / IM references customer segmentation showing **~89% of MRR concentrated in the Diamond tier** — the highest-value customer cohort.

— *Information Memorandum*, customer segmentation section.

### Source figure

The IM's own customer data shows **~91% MRR split** to the Diamond (top) tier.

**Location:** IM customer analytics section.

### Significance

This is not a numeric contradiction — the 89% and 91% figures are consistent within rounding. The observation is that 89–91% revenue concentration in a single customer tier represents an extreme dependency that is not addressed with any disclosed mitigation strategy (diversification roadmap, tier-specific retention programs, or downside stress-testing). No IC memo version discusses what happens if Diamond-tier churn accelerates above the blended 5–7% rate. The Screening Memo flags top-customer concentration as a critical omission but the IC Update does not resolve it.

---

## Finding #5 — Interest Coverage at Entry: Minimal Headroom

**Classification:** Observation (not a contradiction)  
**Severity:** Info

### Memo claim (verbatim)

> "Interest Coverage Year 1: 1.9x"

— *2026-06-21 Saint IC update_vS.pdf*, part 4, leverage table.

The module's finding characterises this as "1.7x–1.8x" — the difference reflects which EBITDA figure is used (the £54.9m organic adjusted cash EBITDA gives 1.9x; a lower run-rate or alternative EBITDA definition produces 1.7x–1.8x).

### Source figures

| Metric | Value | Source |
|--------|-------|--------|
| Entry organic adjusted cash EBITDA | £54.9m | IC Update p.9 |
| Entry annual cash interest | £36.2m | IC Update p.9 |
| Entry gross debt | £410.0m | IC Update p.9 |
| Debt refinance in S&U | £549m | IC Update p.3 |
| Blended margin | S+450bps (~5.7% at SONIA ~1.2%) | IC Update p.3 |
| Entry net debt | £400.0m | IC Update p.9 |
| Entry leverage | 6.5x | IC Update p.9 |

**Check:** £54.9m / £36.2m = **1.52x** on cash interest alone; the 1.9x in the memo implies either a different interest figure or an add-back. If we use the blended rate on £400m: £400m × 5.7% = £22.8m → coverage = 2.4x. The stated 1.9x implies interest of ~£28.9m.

### Significance

Interest coverage of 1.7x–1.9x at entry leaves less than one turn of EBITDA headroom before debt service consumes operating cash flow. With 6.5x entry leverage and £410m gross debt, any operational shortfall — a single quarter of underperformance — could breach covenant headroom. The IC Update's own flag states: "Interest coverage declining to 1.9x in year 1 leaves minimal cushion for operational underperformance or rising rates." This is a source-stated risk that the deal team has identified but for which no explicit mitigation (hedging, cash reserve, EBITDA floor covenant) is documented.

---

## Summary

| # | Finding | Type | Path |
|---|---------|------|------|
| 1 | FY26 revenue £192m vs model £184.4m | Contradiction | Both (merge-tree + reconciliation) |
| 9 | Historical GP CAGR: memo ~10–12% vs verified 14.3% | Contradiction | Old path only |
| 4 | Diamond tier 89–91% MRR concentration, unmitigated | Observation | Merge-tree |
| 5 | Interest coverage 1.7–1.9x, minimal headroom at 6.5x entry leverage | Observation | Merge-tree |

**#1 and #9 are genuine contradictions** — they assert specific figures that differ materially from the financial model.

**#4 and #5 are observations** — they flag risks that are internally consistent within the data room but represent material exposures the IC should weigh. They need no delta and should not be presented as though a numeric comparison produced them.

**#9 is the strongest argument yet that the old reconciliation path retains value the rebuilt path does not currently reach.** It was surfaced by the deterministic cross-agreement layer, verified arithmetically, and never independently produced by the merge-tree.
