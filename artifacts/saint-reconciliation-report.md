# IC Diligence Assistant — Numerical Reconciliation Report

**Deal:** Project Saint (SCG)
**Run date:** 19 August 2026, 08:57 ET
**Engine version:** claims-reconciliation.ts (frozen)

---

## 1. What Was Audited

| Document | Date | Role |
|---|---|---|
| 2026-05-18 SCG - 2nd IC Memo vS.pdf | 18 May 2026 | Primary claim source |
| 2026-07-01 SCG - 3rd IC Memo.pdf | 1 Jul 2026 | Supplementary claim source |
| SCG Operating Model vF.xlsx (doc `3ea34aa1`) | — | Reference model (9 sheets indexed) |

Claims were extracted from both IC memos on prior pipeline runs. The extraction
prompt, chunking strategy, model parameters and temperature are frozen and were
not re-run for this audit. The reconciliation engine ran once, cold, against the
full claims ledger and the complete reference figure set.

---

## 2. Coverage

### The funnel

| Stage | Count | Arithmetic |
|---|---|---|
| Raw claims (ledger) | 1,724 | — |
| Category excluded | 412 | cross_reference (12) + deal_mechanics (179) + returns_projection (85) + valuation_structuring (136) |
| **In category** (operating_metric) | **1,312** | 1,724 − 412 |
| Scenario excluded | 314 | Non-null scenario (CAGR variants, M&A assumptions); outside adjudicable |
| Pre-dedup | 998 | 1,312 − 314 |
| Duplicates collapsed | 257 | Same coordinate, same value |
| **Adjudicable** | **741** | 998 − 257 |
| Matched (within tolerance) | 11 | ≤ 2% or ≤ £100k |
| Matched (data_divergence) | 2 | Above materiality thresholds |
| **Total matched** | **13** | |
| Near-miss (scope_mismatch) | 137 | Same metric + period, different scope |
| Unmatched | 591 | 741 − 13 − 137 |
| *of which* unmatchable by construction | 558 | No reference figure at the claim's metric or scope |

**Check:** 13 + 137 + 591 = 741 = adjudicable ✓

### Two coverage denominators

| Metric | Numerator | Denominator | Value |
|---|---|---|---|
| **Coverage of the memo** | 13 matched | 741 adjudicable | **1.8%** |
| **Coverage incl. near-miss** | 150 (13 + 137) | 741 adjudicable | **20.2%** |
| **Coverage of what's reachable** | 150 (13 + 137) | 183 (741 − 558 unmatchable) | **82.0%** |

The first measures how much of the memo the tool traced to exact model coordinates.
The second — of the figures a financial model *could* source — measures how many
were found. Both are stated because each answers a different question.

---

## 3. Findings

Three findings were submitted to the verification gate. All three passed all six
checks (quote_integrity, source_naming, delta_provenance, figure_existence,
unit_coherence, parallel_offset). Zero rejected.

### Finding 1 — FY26 Total Group Revenue: memo vs model

| Source | FY26 Total Group Revenue |
|---|---|
| 2nd IC Memo, 18 May 2026 | **£194m** |
| Model, frozen forecast (FS Summary hardcoded) | £187.1m |
| Model, realised actual (FS Summary) | £184.4m |

The memo's headline revenue figure sits **5.2% above** the model's realised
actual and **3.7% above** the model's own frozen forecast. The cross-version
analysis confirms the model itself was revised downward between the forecast
snapshot and the final actuals — revenue −£2.7m, Reported EBITDA −£1.8m across
8 material movements.

**Claim verbatim:** "SCG is expected to deliver £194m revenue and £57m cash
EBITDA for FY Mar-26"
**Source:** 2026-05-18 SCG - 2nd IC Memo vS.pdf

**Model figure:** "Total Group revenue" → £184,391,535 (2026 Actual)
**Sheet:** FS Summary, row "Total Group revenue", column 2026 Actual

**Code-computed delta:** +£9,608,465 (+5.2%). Memo is higher.

**Cross-version detail (FY2026, 8 material movements ≥ £500k or 5%):**
- Total Group revenue: −£2.7m (1.4%)
- Total adjustments: −£2.5m (92.2%)
- Total revenue (excl. recent acquisitions): −£2.4m (1.4%)
- Total revenue (excl. future M&A): −£2.1m (1.2%)
- Reported EBITDA: −£1.8m (3.2%)
- Total direct costs: +£703k (2.0%)
- Adj. EBITDA: +£692k (1.2%)
- Total Group GP (excl. recent acquisitions): −£627k (0.6%)

### Finding 2 — Surgery Connect FY25: memo lower than model

**Claim verbatim:** "Surgery Connect | 10.3 | 15.4 | 22.2 | 27.6 | 31.1 | 34.8
| 38.1 | 41.1 | 44.3 | 39.1% | 9.9%"
**Source:** 2026-05-18 SCG - 2nd IC Memo vS.pdf

**Model figure:** "Revenue (segment: Surgery Connect)" → £23,467,379 (FY Mar-25)
**Sheet:** Revenue_&_GP_Build

**Code-computed delta:** −£1,267,379 (−5.4%). Memo is lower.

FY23 and FY24 for this segment reconcile within tolerance. Only FY25 diverges —
this is not a period offset.

---

## 4. What Was Not Reached

| Bucket | Count | Explanation |
|---|---|---|
| **Unmatchable by construction** | 558 | No reference figure exists at the claim's metric or scope. Top scopes: NRR (24), NONE_STATED (21), GP Margin (18), TAM (18), TAM growth (14), Recurring Revenue % (11), Direct Costs (11). These figures live in the FDD, CDD, or management presentations — not in a financial model. |
| **Unmatched (residual)** | 33 | 591 − 558. Metric and scope exist in reference_figures but no period or value matched closely enough. |
| **Period with no counterpart** | 415 | Claims cite periods (quarterly, monthly, or ranges) that the annual model does not contain. |
| **Scenario excluded** | 314 | CAGR variants, M&A-contingent assumptions, sensitivity cases. Not adjudicable against the base model. |

---

## 5. Limitations

1. **PDF sources not indexed.** The FDD, CDD and CIM are cited frequently in both
   IC memos and are not in the reference set. The 558 unmatchable claims — NRR,
   TAM, churn, cash conversion, GP margins by sub-segment — are largely sourced
   from the FDD. Adding the FDD as a reference source would make many of these
   verifiable.

2. **Sheets not covered.** The model has additional sheets beyond the 9 indexed
   (Revenue_&_GP_Build, FS Summary, Direct costs_&_Overheads_Build,
   BS_&_CF_Build, Future_M&A_overlay, Recent_acquisition_overlay, Sheet2, plus
   their hardcoded counterparts). Sheets such as Staff Build, Assumptions,
   Working Capital, and Debt are likely present but not indexed by Stage 5.

3. **3rd IC Memo ceiling.** Nine of thirty extraction chunks on the 3rd IC Memo
   reached the output token ceiling. The 728 unique claims extracted from that
   document are a floor, not a census.

4. **Period granularity.** 415 claims cite quarterly, monthly or multi-year range
   periods. The reference model holds annual figures only. These claims are
   structurally unverifiable without a monthly model or management accounts.

5. **Verification gate results.** 3 submitted → 3 verified → 0 rejected.
   Rejection breakdown: quote_integrity 0, source_naming 0, delta_provenance 0,
   figure_existence 0, unit_coherence 0, parallel_offset 0.
