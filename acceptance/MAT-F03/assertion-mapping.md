# MAT-F03: Assertion → Production Function → Test Mapping

## Overview

MAT-F03 delivers fail-closed compatibility, deterministic normalization, calculation, and verdict. The production entry point is `executeCanonicalComparison()` in `canonical-comparison.ts`, called from `ReplayClaimLinkage` after evidence admission.

---

## Frozen Assertion 1 — Valid revenue contradiction

| Aspect | Value |
|--------|-------|
| **Production function** | `executeCanonicalComparison()` in `canonical-comparison.ts` |
| **Tests** | Test 1: £194m versus £184,391,535 revenue contradiction |
| **Verified outputs** | `normalized_claim_value=194000000`, `normalized_fact_value=184391535`, `signed_delta=9608465`, `absolute_delta=9608465`, `percentage_delta≈5.2109`, `direction=claim_higher`, `verdict=contradicted` |
| **Tolerance** | ±0.001% on percentage_delta (floating-point safe) |
| **Parent-fail reason** | Prior revision had no `executeCanonicalComparison`. `classifyClaimLinkage` produced no signed delta, no normalized values, no rule-versioned verdict |

## Frozen Assertion 2 — Forecast revision remains distinct

| Aspect | Value |
|--------|-------|
| **Production function** | `executeCanonicalComparison()` + `isLiveVsReferenceComparison()` |
| **Tests** | Test 2: Live vs hardcoded forecast revision |
| **Verification** | `comparison_basis="fs summary (hardcoded)"` triggers `isLiveVsReferenceComparison()=true` → `verdict=materially_changed` not `contradicted` |
| **Parent-fail reason** | Prior revision had no comparison-basis distinction; all numeric differences produced `contradicted` |

## Frozen Assertion 3 — Required incompatibilities fail closed

| Aspect | Value |
|--------|-------|
| **Production function** | `evaluateCompatibility()` in `canonical-comparison.ts` |
| **Tests** | Tests 3 (Gamma entity), 4 (FY24/FY25), 5 (actual/forecast), 6 (pct vs currency), 7 (group vs segment), 8 (revenue vs GP), 9 (reported vs cash EBITDA), 10 (GM% vs GP), 11 (KPI vs TAM) |
| **Verified** | Each produces `allowed:false`, deterministic `rejection_reasons`, `calculation_type=not_performed`, `verdict=unverifiable`, `reportable=false` |
| **Parent-fail reason** | Prior revision had no compatibility gate; all evidence reached comparison |

## Frozen Assertion 4 — Unit normalization is deterministic

| Aspect | Value |
|--------|-------|
| **Production function** | `normalizeValue()` in `canonical-comparison.ts` |
| **Tests** | Tests 12 (millions/raw), 13 (thousands/raw), 14 (percentage), 15 (pp vs %), 16 (bp), 17 (unknown scale fail-closed), 18 (zero denominator) |
| **Verified** | £194m→194000000, £194k→194000, 16.7%→0.167, 10pp→0.10 (rule=pp), 10%→0.10 (rule=%), 100bp→0.01, unknown scale→null, zero denominator→pct=null |
| **Parent-fail reason** | Prior revision had no `normalizeValue` function; normalization was ad hoc in `normalizeFigures` for reconciliation only |

## Frozen Assertion 5 — Persisted verdict is code-derived

| Aspect | Value |
|--------|-------|
| **Production function** | `serializeComparison()` + `deserializeComparison()` |
| **Tests** | Test 19 (verdict unaffected by narrative), Test 20 (persistence/reload parity) |
| **Verified** | Rule version present in reloaded record, verdict unchanged by evidence ID change, signed delta unchanged, schema version preserved |
| **Parent-fail reason** | Prior revision had no canonical comparison record; verdicts came from `classifyClaimLinkage` which derives disposition from `source_tag` and `authority_class` heuristics |

---

## Files Changed

| File | Role |
|------|------|
| `server/apis/pipeline/canonical-comparison.ts` | NEW — Full canonical comparison engine: compatibility, normalization, calculation, verdict, serialization |
| `server/apis/pipeline/replay-claim-linkage.ts` | MODIFIED — Imports and invokes `executeCanonicalComparison` after evidence admission for each linked claim; persists `canonical_comparisons` in Q3 checkpoint |
| `server/apis/pipeline/__tests__/mat-f03-canonical-comparison.test.ts` | NEW — 20 production-path tests |
| `acceptance/MAT-F03/fixture-output.json` | NEW — 5 machine-generated fixture records |

---

## Parent-Fail / New-Pass Summary

| Test | Parent fails because | New revision passes because |
|------|---------------------|----------------------------|
| Valid revenue signed-delta | No `executeCanonicalComparison` existed | `calculateDeltas(194000000, 184391535)` produces `signed_delta=9608465` |
| Live-vs-reference distinction | No `comparison_basis` tracking | `isLiveVsReferenceComparison()` detects "hardcoded" → `materially_changed` |
| Reported EBITDA vs cash EBITDA | Metric groups not enforced | `METRIC_CANONICAL_GROUPS` keeps `reported_ebitda ≠ cash_ebitda` |
| Percentage vs currency | No unit-family check | `classifyUnitFamily()` returns `percentage` vs `currency` → incompatible |
| Persisted deterministic verdict | No rule-versioned verdict record | `assignVerdict()` with `VERDICT_RULE_VERSION` persisted in Q3 checkpoint |

---

## Known Limitations Outside Scope

1. **Qualitative comparison verdict**: When evidence is qualitative (no numeric value), verdict defaults to `unverifiable` even if semantically supported. Partial support detection belongs to a later batch.
2. **Accounting basis enforcement is soft**: Accounting basis incompatibility is logged but does not block comparison (only metric and entity incompatibilities block). Full enforcement deferred.
3. **Comparison basis for memo claims**: All IC memo claims are tagged `comparison_basis="memo_claim"`. Finer-grained claim-source tracking (which IC memo section, which version) deferred.
4. **Period "unknown" for non-standard formats**: Periods not matching `fy-mar-XX`, `fyXX`, `qX-XX` patterns return `null` and produce `period=unknown` → fail closed. Custom period formats need explicit mapping rules.
5. **Full Saint regression deferred**: The complete deal run with all canonical comparisons replacing legacy reconciliation verdicts is deferred to final acceptance.
6. **No LLM demotion**: LLM-produced findings still coexist with canonical comparisons. The canonical comparison does not yet override the `claim_linkage_disposition`. That integration is deferred.
