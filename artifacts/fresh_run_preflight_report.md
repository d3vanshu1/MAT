# Fresh Run Preflight Report

**Generated**: 2026-08-01T08:42:00Z (ET: 4:42 AM)  
**Run ID**: `33a88bb1-d2b6-4ee8-81f7-335573c28c73`  
**Deal ID**: `c46b4129-8a16-48ae-ad3a-1da061255445` (SCG / Project Saint)  
**Q2 Artifact ID**: `79fcc832-7a9f-4307-b684-916be60db184`  
**Schema Version**: `regenerated_q2_candidates_v1`  
**Checksum**: `b4e975fcd388519efe226aecb3aa221e7d691a3865f31ce2f4940ae2ba540d72`  

---

## Preflight Gate Results

| Gate | Required | Actual | Status |
|------|----------|--------|--------|
| Persisted Q2 rows | exact manifest count (221) | 221 | ✅ PASS |
| Q3 input equals persisted Q2 reportable | 100% | 12/12 = 100% | ✅ PASS |
| Reportable rows with exactly one deterministic claim ID | 100% | 12/12 = 100% | ✅ PASS |
| Reportable unreconcilable rows | 0 | 0 | ✅ PASS |
| Ambiguous claim matches admitted | 0 | 0 | ✅ PASS |
| Cross-document fallback matches | 0 | 0 | ✅ PASS |
| Duplicate candidate IDs | 0 | 0 | ✅ PASS |
| Real Saint Q3-eligible candidates | ≥1 | 12 | ✅ PASS |
| Q4 families | ≥1 | 6 | ✅ PASS |
| Persisted Q5 findings | ≥1 | 6 | ✅ PASS |
| Eligible rows with complete evidence/authority/compatibility | 100% | 12/12 = 100% | ✅ PASS |
| Terminal/output mismatches | 0 | 0 | ✅ PASS |
| Silent losses | 0 | 0 | ✅ PASS |

**ALL GATES PASSED**

---

## Real Saint Candidate (Proven)

- **Candidate ID**: `cand-v2-d31f0498cd00f10c`
- **Claim ID**: `clm-v1-79273b6b8902ef76b61d09a08791d5dd`
- **Issue**: Total Group Revenue (FY Mar-26): memo higher than model by £9.6m (5.2%)
- **IC Document**: 2026-05-18 SCG - 2nd IC Memo vS.pdf
- **Page**: Executive Summary (1/3)
- **Exact Claim Text**: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26"
- **Memo Value**: £194m
- **Model Value**: £184.4m (£184,391,535)
- **Delta**: £9.6m (5.21%)
- **Authority**: model_comparison (deterministic_computation)
- **Resolution Method**: exact_coordinate
- **Disposition**: reportable_q3_eligible
- **Q3→Q4→Q5**: Successfully traversed entire chain with zero silent loss

---

## Pipeline Chain Summary

```
Q2 (tree_level=100) → 221 total, 12 reportable
Q3 (tree_level=96)  → 12 input, 12 eligible (claim-linked)
Q4 (tree_level=95)  → 12 members → 6 families
Q5 (tree_level=94)  → 6 canonical findings persisted
Terminal (tree_level=93) → 6 findings confirmed, 0 mismatches
```

## Checkpoint IDs

| Stage | Checkpoint ID |
|-------|---------------|
| Q2 | `79fcc832-7a9f-4307-b684-916be60db184` |
| Q3 | `8bc371b1-747f-4c28-84e5-e478cf594d55` |
| Q4 | `35a3889c-3c29-49d0-b749-8e9b8356ab1c` |
| Q5 (Canonical) | `f3e48a37-b5c6-4494-a66c-fa0f19556336` |
| Q5 (Terminal) | `4e9c7696-0237-4d5c-a2b0-a6c05592d80e` |

---

## Strict Reportability Rules Applied

1. **Only `data_divergence` with complete evidence is reportable** — unreconcilable/scope_mismatch classified as `process_diagnostic`
2. **Collision-safe matching** — `Map<key, Claim[]>` with exact-one resolution
3. **No cross-document fallback** — IC document identity required
4. **SHA-256 identity** — includes verification_evidence_id discriminator
5. **No ambiguous matches admitted** — fail-closed on multi-claim resolution

---

## Verdict

```
fresh_run_ready: true
```
