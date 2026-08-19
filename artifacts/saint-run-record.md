# IC Diligence Assistant — Run Record

**Deal:** Project Saint (SCG)  
**Deal ID:** `c46b4129-8a16-48ae-ad3a-1da061255445`  
**Numeric Report ID:** `df246a54-6bcb-4089-91f2-1e809e55f9b0`  
**Run date:** 19 August 2026, 08:57 ET  
**Operator:** Clark (automated cold run)

---

## Timing

| Call | Purpose | Wall-clock |
|---|---|---|
| DiagReconcileOnly (summary, page 0) | Full reconciliation + gate | 6,511 ms |
| DiagReconcileOnly (data_divergence, page 0) | Findings detail | 7,319 ms |
| DiagReconcileOnly (cross_version, page 0) | Findings detail | 7,110 ms |
| **Total sequence** | | **20,940 ms** |

*Single-call production latency (one reconciliation pass including gate):* **~7s**

---

## Input Counts

| Source | Count |
|---|---|
| Claims ledger (raw) | 1,724 |
| Reference figures (reference_figures table) | 2,242 |
| Base figures (numeric_reports) | 32 |
| **Total figures available** | **2,274** |

---

## Funnel

| Stage | Count |
|---|---|
| raw_claims | 1,724 |
| category_excluded | 412 |
| in_category | 1,312 |
| scenario_excluded | 314 |
| pre_dedup | 998 |
| duplicates_collapsed | 257 |
| **adjudicable** | **741** |
| matched (within_tolerance) | 11 |
| matched (data_divergence) | 2 |
| **total_matched** | **13** |
| near_miss (scope_mismatch) | 137 |
| unmatched | 591 |
| unmatchable_by_construction | 558 |

**Arithmetic:** 13 + 137 + 591 = 741 ✓

---

## Gate Results

| Metric | Value |
|---|---|
| Findings submitted | 3 |
| Findings verified | 3 |
| Findings rejected | 0 |
| Held upstream | 0 |
| Rejection rate | 0% |

### Per-check rejection counts

| Check | Rejected |
|---|---|
| quote_integrity | 0 |
| source_naming | 0 |
| delta_provenance | 0 |
| figure_existence | 0 |
| unit_coherence | 0 |
| parallel_offset | 0 |

---

## Findings Summary

| # | Kind | Title | Delta |
|---|---|---|---|
| 1 | data_divergence | Total Group Revenue FY Mar-26 | +£9.61m (+5.2%) |
| 2 | data_divergence | Revenue (Surgery Connect) FY Mar-25 | −£1.27m (−5.4%) |
| 3 | cross_version | Forecast vs realised actual: 2026 | 8 material movements |

---

## Coverage

| Metric | Value |
|---|---|
| Coverage of the memo (matched / adjudicable) | 1.8% |
| Coverage incl. near-miss | 20.2% |
| Coverage of what's reachable (matched+near_miss / adjudicable−unmatchable) | 82.0% |

---

## Additional Diagnostics

| Metric | Value |
|---|---|
| Metric derivation (claims rewritten) | 68 |
| Near-miss magnitude rejected | 144 |
| Near-miss unit rejected | 4,261 |
| Magnitude suppressions (scope_mismatch) | 10 |
| Ambiguous reference count | 5 |
| Unreconcilable findings (info-level) | 702 |
| Cross-version material movements | 8 |
