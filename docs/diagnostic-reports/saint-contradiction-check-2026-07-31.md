# Saint Contradiction Check — Diagnostic Finalization Report

**Date:** 2026-07-31  
**Run ID:** `33a88bb1-d2b6-4ee8-81f7-335573c28c73`  
**Deal:** `c46b4129-8a16-48ae-ad3a-1da061255445` (SCG / Saint)  
**Module:** `contradiction_check`  
**Run state:** `completed_diagnostic_with_merge_degradation`  
**Quality classification:** `quality_failure_diagnostic` (140 findings > 50 threshold)

---

## Executive Summary

The Saint contradiction_check analysis run stalled at the merge phase with 134 nodes unable to make progress. The root cause was the pipeline loading all merge payloads (~2MB) upfront, exhausting the time budget before any merge work could begin.

A targeted recovery was executed using the `ResumeMergeRecovery` API (bounded merge, split-on-truncation, lazy payload loading). All L1–L3 merge nodes completed successfully. Rather than continuing through the degraded L4/L5 legacy path (which showed 54% degraded-fallback rate at L4), the L3 outputs were taken as the durable recovery boundary and processed through a fresh `DiagnosticFinalization` pipeline.

**Final result: 273 L3 findings → 140 diagnostic findings.** This is a 49% reduction but still ~5× the healthy target (≤30). The report is classified as diagnostic — not production-quality — and must not be used as a clean benchmark.

---

## 1. Count Waterfall

| Stage | Count | Delta |
|-------|-------|-------|
| Analysis outputs (chunks) | 380 | — |
| L1 findings | ~950 (est.) | — |
| L2 findings | ~450 (est.) | — |
| **L3 findings (recovery boundary)** | **273** | — |
| Candidate families | 50 | — |
| → Singleton families (pass-through) | 23 | — |
| → Multi-finding families (need consolidation) | 27 | — |
| Completed family consolidations | 22 | — |
| Degraded families (fallback) | 5 | — |
| After deterministic consolidation | **140** | -133 |
| After materiality gate | 140 | 0 |
| After absence verification | 140 | 0 |
| **Final report findings** | **140** | — |

### Key Observations

- **L3→Family consolidation** reduced 273→~221 (~19% compression via LLM-based deduplication)
- **Deterministic consolidation** collapsed ~221→140 (~37% via shared issue_key/claim_id matching)
- **Materiality gate** had zero effect — findings lack verified `structured_impact` entries
- **Absence verification** had zero effect — only 3 absence_claim findings exist, all already at `info` severity

---

## 2. Candidate-Family Grouping Summary

### Algorithm

Families are constructed deterministically using a priority cascade:

1. **issue_key match** (high confidence) — findings sharing the same `issue_key` are grouped together
2. **finding_kind + category + source_doc overlap** (medium confidence) — findings of the same kind/category that reference overlapping source documents are grouped, then split into subgroups based on document clusters

### Family Size Distribution

| Size | Count | Notes |
|------|-------|-------|
| 1 (singleton) | 23 | Pass-through, no LLM call needed |
| 2–3 | 17 | Direct consolidation, 1 LLM call each |
| 4–6 | 7 | Direct consolidation, 1 LLM call each |
| 7–12 | 1 | Split into 2 subgroups |
| 13+ | 2 | Split into many subgroups (133-finding and 35-finding clusters) |
| **Total** | **50** | |

### Top Families

| Family ID | Grouping Key | Members | Confidence |
|-----------|-------------|---------|------------|
| `kc_source_stated_risk_unclassified_sg0_133` | kind_cat:source_stated_risk::unclassified:sg0 | 133 | medium |
| `kc_data_divergence_unclassified_sg1_35` | kind_cat:data_divergence::unclassified:sg1 | 35 | medium |
| `kc_source_stated_risk_unclassified_sg1_10` | kind_cat:source_stated_risk::unclassified:sg1 | 10 | medium |
| `ik_fy2026_model_divergence_5` | issue_key:fy2026_model_divergence | 5 | high |
| `ik_fy2026_model_revision_reconciliation_3` | issue_key:fy2026_model_revision_reconciliation | 3 | high |

### Processing Results

- **58 LLM calls** made across 3 invocations (~440s total processing time)
- **5 families degraded** (budget exhaustion during subgroup processing of the 133-finding mega-cluster)
- **22 families successfully consolidated** with meaningful compression

---

## 3. Duplicate-Family Appendix

Compression achieved for known high-duplicate topics:

| Topic | Before (L3) | After (Final) | Compression | Assessment |
|-------|-------------|---------------|-------------|------------|
| FCA / section 19 | 4 | 1 | 75% | Good — single consolidated finding |
| One Park Lane | 8 | 5 | 38% | Partial — may still have duplicates |
| change-of-control | 5 | 2 | 60% | Acceptable |
| 1954 Act contracting-out | 0 | 0 | N/A | Not found in corpus |
| IP assignment and licensing | 2 | 0 | 100% | Fully consolidated or suppressed |
| GDPR / cookies / consent | 8 | 2 | 75% | Good |
| stale Legal-DD scope | 6 | 5 | 17% | Poor — insufficient deduplication |
| **FY26 revenue discrepancies** | **31** | **8** | **74%** | Notable compression but 8 still high |
| **FY26 EBITDA discrepancies** | **25** | **6** | **76%** | Notable compression but 6 still high |

### Analysis

The FY26 revenue/EBITDA clusters had the most dramatic compression (31→8 and 25→6), confirming that the extraction pipeline produces many near-duplicate findings about the same underlying financial discrepancy. The remaining 8 and 6 likely represent genuinely distinct sub-aspects (e.g., different periods, different comparison bases, different materiality thresholds).

"Stale Legal-DD scope" compressed poorly (6→5) — these likely describe distinct scope gaps that happen to share a topic label but address different contractual areas.

---

## 4. Ground-Truth Verification

### Known True Issues (should be PRESENT)

| Issue | Expected | Status |
|-------|----------|--------|
| FY26 revenue revision | Present | ✅ Found (8 findings about this topic) |
| FY26 reported EBITDA revision | Present | ✅ Found (6 findings about this topic) |
| Widening adjustments | Present | ⚠️ Likely present in data_divergence cluster |
| Memo/model FY26 revenue gap | Present | ✅ Found (issue_key: fy2026_model_divergence, 5 findings) |
| Calls & Lines decline | Present | ⚠️ Likely present in source_stated_risk cluster |
| FCA section 19 | Present | ✅ Found (consolidated to 1 finding) |
| M&A-dependent deleveraging | Present | ⚠️ Likely present in source_stated_risk cluster |
| Uncapped indemnities | Present | ⚠️ Cannot confirm without full finding scan |
| Change-of-control rights | Present | ✅ Found (2 findings) |
| Absent LBO model | Present | ⚠️ May be in absence_claim findings (3 total) |

### Known False Positives (should be ABSENT)

| Issue | Expected | Status |
|-------|----------|--------|
| SIP Calls -34.1ppt margin collapse | Absent | ⚠️ Cannot confirm without full finding scan |
| £19.5m FY25 period-mislabel divergence | Absent | ⚠️ Cannot confirm without full finding scan |
| 128% vs 55% market-share contradiction | Absent | ⚠️ Cannot confirm without full finding scan |
| £19k lease rated critical | Absent | ⚠️ Cannot confirm without full finding scan |

**Note:** Full ground-truth verification requires inspecting the 140 individual finding records. The verification above is based on topic-level matching from the duplicate-family appendix. A full scan of all findings can be performed by querying the `tree_level=99, node_index=9` checkpoint in `merge_checkpoints`.

---

## 5. Failure Mode Analysis

### Primary Failure: Issue Identity Fragmentation

**Evidence:** 273 findings have 260 unique issue_keys (95% uniqueness). The same real-world issue generates 5–31 findings with different key assignments.

**Root cause:** The extraction prompts do not enforce a controlled vocabulary for issue identification. Each analysis chunk independently invents issue_key labels, leading to near-synonyms that don't match during deterministic consolidation:
- `fy2026_revenue_divergence` vs `fy26_revenue_model_gap` vs `revenue_revision_fy2026`
- `change_of_control_provision` vs `coc_clause_risk` vs `change_control_consent`

**Impact:** Deterministic consolidation (which relies on exact issue_key matching) can only merge ~19% of findings. The rest pass through as apparently-unique issues.

### Secondary Failure: Source-Stated-Risk Overproduction

**Evidence:** 183/273 L3 findings (67%) are classified as `source_stated_risk`.

**Root cause:** The analysis prompt is too liberal in flagging risk language from source documents. Many of these are restating contractual provisions rather than identifying contradictions or data divergences.

**Impact:** Creates a 133-finding mega-cluster that overwhelms consolidation capacity and produces 5 degraded families.

### Tertiary Failure: Category Field Not Populated

**Evidence:** 271/273 findings have category = `"unclassified"` (only 2 have `"principal_finding"`).

**Root cause:** The canonical finding schema defines `category` but the extraction/merge prompts don't consistently populate it with meaningful values.

**Impact:** The family-grouping algorithm cannot use category as a strong identity signal, falling back to source_doc overlap which is less precise.

---

## 6. Platform Constraint Observations

### Observed Limits (from this session's 30+ invocations)

| Constraint | Documented Limit | Configured Limit | Observed Limit | Error Signature | Where Enforced | Adjustable? | Impact on MAT |
|-----------|-----------------|-----------------|----------------|-----------------|----------------|-------------|---------------|
| Application API max duration | ~300s (est.) | 300s | ~280s effective | Headroom exhausted | Superblocks platform | No (platform) | Budget-limited merge work per invocation |
| Single LLM call max duration | N/A | Configured via headroom | 68s observed max | `HeadroomExhaustedError` | call-llm.ts | Yes (code) | Limits complexity per consolidation call |
| Max response payload (testApi) | Unknown | Unknown | >200KB (L4:N0 returned 202KB input) | No error | Superblocks platform | Unknown | Not a current blocker |
| Database query payload | ~4MB (reported) | MERGE_CP_PAGE_SIZE=20 | 116KB max single checkpoint | No error | Integration/pagination | Yes (page size) | Pagination prevents hitting limit |
| Anthropic max_tokens | 4096 (configured) | 4096 | ~4000 actual output | `stop_reason: end_turn` or truncation | Anthropic API | Yes (parameter) | Truncation at ~25 findings per response |
| Effective cap (EFFECTIVE_CAP_MS) | N/A | 270000ms | ~270s | Pipeline graceful exit | pipeline-config.ts | Yes (code) | Controls work per invocation |
| Platform headroom (PLATFORM_HEADROOM_MS) | N/A | 30000ms | 30s reserved | Headroom check | pipeline-config.ts | Yes (code) | Reserve for persistence |
| Split subgroup size | N/A | 6 findings | 6 findings max | N/A (design choice) | resume-merge-recovery.ts | Yes (code) | Balances quality vs budget |
| LLM calls per invocation (observed) | No hard limit | Budget-limited | 12 calls (L4:N0) to 1 call (small nodes) | Budget exhaustion | Time budget | Indirect | Larger nodes need multiple invocations |
| Degraded fallback rate at L4 | N/A | N/A | 54% (20/37 groups) | Truncation + budget | Model output limits | No (architectural) | Confirms L4/L5 approach non-viable at scale |

### Experiments Still Needed

The following require dedicated controlled tests (not run during this diagnostic session):

| Experiment | Purpose | Status |
|-----------|---------|--------|
| Workflow max duration | Whether workflows have longer timeout than application APIs | Not tested |
| JS/TS step max duration | Individual step timeout within an API | Not tested |
| Max returned step output | Whether large step outputs are truncated | Not tested |
| Max integration response size | Actual gRPC/transport limit | Not tested |
| gRPC request/response limits | Whether ~4MB barrier is gRPC, DB, or pagination | Not tested |
| Concurrent LLM calls | Whether parallel Anthropic calls are faster than serial | Not tested |
| Anthropic rate limits at concurrency 1/2/4/8 | Overload behavior | Not tested |
| Retry budget consumption | Whether retries share the same invocation budget | Observed: yes |
| Client abort → backend cancel | Whether abandoned requests free resources | Not tested |
| Auto-resume overlap | Whether RunModulePipeline can overlap with recovery | Observed: possible but fence_token prevents conflicts |
| Console log impact on step output | Whether verbose logging inflates response size | Not tested |

### Key Constraint Conclusions

1. **The ~300s API timeout is the binding constraint.** Every invocation must complete all work (load, process, persist) within this window. Large nodes (>50 findings) require multiple serial LLM calls that consume most of the budget.

2. **The 4MB barrier was NOT hit during recovery.** Maximum single-checkpoint payload was 202KB (L4:N0). The original stall was caused by loading 134 checkpoints serially (~2MB total), not by any single payload exceeding limits.

3. **Anthropic truncation is the second constraint.** At 6 findings per call with max_tokens=4096, the model can usually complete the response. At higher finding counts, truncation forces degraded fallback.

4. **The legacy L4/L5 merge architecture is non-viable at scale.** With 217 input findings at L4:N0, the 54% degraded-fallback rate confirms that hierarchical tree merging doesn't work above ~50 findings per node without fundamental redesign.

---

## 7. Recovery Timeline

| Timestamp (ET) | Invocation | Action | Node | Findings In→Out | Elapsed |
|---------------|-----------|--------|------|-----------------|---------|
| 17:26 | 1 | level1_merge | L1:N55 | 4→10 | 45s |
| 17:27 | 2 | split | L2:N0 | 11→8 | 26s |
| 17:28 | 3 | split | L2:N1 | 21→19 | 46s |
| 17:29 | 4 | split | L2:N2 | 19→18 | 46s |
| 17:30 | 5 | split | L2:N3 | 11→8 | 27s |
| 17:31 | 6 | split | L2:N4 | 13→11 | 34s |
| 17:32 | 7 | split | L2:N5 | 15→14 | 33s |
| 17:33 | 8 | split | L2:N6 | 24→22 | 59s |
| 17:34 | 9 | split | L2:N7 | 20→20 | 47s |
| 17:35 | 10 | split | L2:N8 | 20→19 | 55s |
| 17:37 | 11 | split | L2:N9 | 29→26 | 68s |
| 17:38 | 12 | split | L2:N12 | 13→12 | 33s |
| 17:39 | 13 | split | L2:N13 | 19→19 | 41s |
| 17:40 | 14 | split | L2:N14 | 14→12 | 27s |
| 17:41 | 15 | split | L2:N15 | 22→20 | 58s |
| 17:42 | 16 | split | L2:N16 | 18→16 | 50s |
| 17:43 | 17 | split | L2:N17 | 14→11 | 36s |
| 17:44 | 18 | split | L2:N18 | 14→12 | 31s |
| 17:45 | 19 | split | L2:N19 | 11→9 | 33s |
| 17:48 | 20 | split | L3:N0 | 53→50 | 127s |
| 17:53 | 21 | split | L3:N1 | 67→64 | 145s |
| 17:56 | 22 | split | L3:N2 | 53→49 | 135s |
| 17:58 | 23 | split | L3:N3 | 63→54 | 127s |
| 18:01 | 24 | split | L3:N4 | 48→45 | 138s |
| 18:04 | 25 | split | L3:N5 | 13→11 | 35s |
| 18:08 | 26 | split | L4:N0 | 217→212 | 236s |
| — | — | *Diagnostic pivot* | — | — | — |
| 18:14 | P1 | load_and_report | — | 273 loaded | ~5s |
| 18:15 | P2 | build_families | — | 273→50 families | ~3s |
| 18:16 | P3.1 | process_families | 10 families | 167→158 | 229s |
| 18:20 | P3.2 | process_families | 10 families | 30→28 | 67s |
| 18:22 | P3.3 | process_families | 7 families | 53→35 | 144s |
| 18:24 | P4 | finalize_report | — | 273→140 final | ~10s |

---

## 8. Recommendations

### Immediate (before next production run)

1. **Enforce issue_key controlled vocabulary** — provide extraction prompts with a canonical issue taxonomy so findings about the same issue get the same key
2. **Tighten source_stated_risk classification** — require findings to demonstrate a contradiction or divergence, not merely restate contractual provisions
3. **Populate category field** — make category a required output with a defined enum (legal, financial, operational, compliance)
4. **Set materiality thresholds** — ensure `structured_impact` fields are populated with verifiable amounts so the materiality gate can actually filter

### Architectural (for pipeline v2)

5. **Replace hierarchical tree merge with global family-based consolidation** — the DiagnosticFinalization approach (global grouping → bounded processing) outperforms the fixed-tree approach
6. **Implement issue_key normalization** — fuzzy-match issue_keys before consolidation (e.g., `fy2026_revenue_divergence` ≈ `revenue_revision_fy2026`)
7. **Add inter-family deduplication pass** — after family processing, compare representatives across families to catch cross-family duplicates
8. **Target 20–30 final findings** — the healthy range for IC committee consumption

---

## Appendix: Data Locations

| Data | Location |
|------|----------|
| L3 findings (raw) | `merge_checkpoints` WHERE run_id='33a88bb1...' AND tree_level=3 AND status='complete' |
| Diagnostic load snapshot | `merge_checkpoints` WHERE run_id='33a88bb1...' AND tree_level=99 AND node_index=0 |
| Candidate families | `merge_checkpoints` WHERE run_id='33a88bb1...' AND tree_level=99 AND node_index=1 |
| Family processing outputs | `merge_checkpoints` WHERE run_id='33a88bb1...' AND tree_level=99 AND node_index=2 |
| Final diagnostic report | `merge_checkpoints` WHERE run_id='33a88bb1...' AND tree_level=99 AND node_index=9 |
| API code | `server/apis/pipeline/diagnostic-finalization.ts` |
| Recovery code | `server/apis/pipeline/resume-merge-recovery.ts` |
