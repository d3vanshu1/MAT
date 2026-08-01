# Saint Reconciliation Artifact — Closure M1+M4

**Deal:** SCG/Saint (`c46b4129-8a16-48ae-ad3a-1da061255445`)
**Run:** `33a88bb1-d2b6-4ee8-81f7-335573c28c73`
**Q3 Checkpoint:** `8bc371b1-747f-4c28-84e5-e478cf594d55`
**Date:** 2026-08-01

## Summary Counts

| Metric | Count |
|--------|-------|
| Total Q2 candidates | 46 |
| Claims ledger | 274 (97 screening + 88 2nd IC + 89 3rd IC) |
| IC documents | 3 |
| Ambiguous legacy IDs (cross-doc) | 579 |

## Resolution Method Counts

| Method | Count |
|--------|-------|
| not_linked_to_IC_claim | 17 |
| invalid_or_unresolved_claim_reference | 13 |
| ambiguous_reconciliation | 4 |
| invalid_evidence_authority | 11 |
| claim_linked_materially_changed | 1 |
| **Total** | **46** |

## Q3 Eligibility

| Metric | Count |
|--------|-------|
| Q4-eligible (adverse structured) | 1 |
| Q4-ineligible (rejected) | 45 |
| Ambiguous auto-admitted | 0 |
| Duplicate IDs admitted | 0 |
| Heuristic-only verdicts admitted | 0 |

## 5 Validated Mappings

### 1. RESOLVED: FY2026 Revenue/EBITDA Divergence (3rd IC)

| Field | Value |
|-------|-------|
| Finding ID | `3472b88d-4bbf-419a-b769-104a8eeba5f8` |
| Legacy Ref | `c1-11` |
| IC Document | `2026-06-15 SCG - 3rd IC Memo vS.pdf` |
| Page/Location | Executive Summary (p.7) |
| Memo Version | 3rd_ic |
| Exact Claim | “reaching ~£243m revenue / ~£157m GP / ~£83m Cash EBITDA by FY31 on the current perimeter” |
| Resolution | **claim_linked_materially_changed** |
| Authority | `live_financial_model` (valid) |
| Why correct | Claim c1-11 references FY31 revenue/GP/EBITDA targets from 3rd IC executive summary. The live model has diverged from these figures. Authority (financial model) is authoritative for numeric financial claims. finding_kind=data_divergence provides structured basis for materially_changed verdict. |

### 2. REJECTED: Invalid Authority (commentary verifying numeric claim)

| Field | Value |
|-------|-------|
| Finding ID | (corpus_index 2, representative of 11 invalid-authority findings) |
| Legacy Ref | (positional cN-M resolved to claim) |
| IC Document | Various |
| Authority Class | `commentary` or `internal_note` |
| Resolution | **invalid_evidence_authority** |
| Why correct | Numeric financial claims (claim_type=numeric_financial) require authoritative sources: financial_model, audited_accounts, or management_data. Commentary sources cannot verify numeric claims. The 11 findings all attempted to verify financial claims using non-authoritative evidence. |

### 3. REJECTED: Ambiguous Reconciliation (cross-document collision)

| Field | Value |
|-------|-------|
| Finding ID | (corpus_index representative of 4 ambiguous findings) |
| Legacy Ref | Positional format (cN-M) matching multiple IC documents |
| Resolution | **ambiguous_reconciliation** |
| Why correct | Legacy reference c0-0, c0-1, etc. resolve to different claims in screening/2nd IC/3rd IC memos (579 ambiguous IDs across 3 documents sharing positional format). Without document-specific context, the finding cannot be uniquely linked. Fail-closed: ambiguous → not admitted. |

### 4. REJECTED: Not Linked (no claim reference)

| Field | Value |
|-------|-------|
| Finding ID | (representative of 17 not-linked findings) |
| Legacy Ref | null / empty |
| Resolution | **not_linked_to_IC_claim** |
| Why correct | 17 findings were produced by Q2 analysis without any originating_claim_id or claim_ids reference. These may be model-generated observations, structural notes, or general commentary that the LLM produced without linking to a specific IC memo claim. Cannot participate in Q4 grouping without claim provenance. |

### 5. REJECTED: Unresolved Reference (claim ID not in ledger)

| Field | Value |
|-------|-------|
| Finding ID | (representative of 13 unresolved findings) |
| Legacy Ref | Various cN-M format references |
| Resolution | **invalid_or_unresolved_claim_reference** |
| Why correct | 13 findings reference claim IDs that cannot be resolved against the 274-claim ledger. Either: (a) the positional reference exceeds available chunk/claim indices, (b) the reference format is malformed, or (c) the referenced claim was from a document not in the IC corpus. All fail closed per A3. |

## Acceptance Gate Results

| Gate | Required | Actual |
|------|----------|--------|
| 46 candidates accounted for | 46/46 | **46/46 ✓** |
| Ambiguous mappings auto-admitted | 0 | **0 ✓** |
| Duplicate IDs admitted | 0 | **0 ✓** |
| Heuristic-only verdicts admitted | 0 | **0 ✓** |
| True-positive regressions | 7/7 | **7/7 ✓** |
| False-positive regressions | 10/10 | **10/10 ✓** |
| Q3 bypass paths | 0 | **0 ✓** |
| Replay/resume semantic mismatches | 0 | **0 ✓** |
| Duplicate persisted outputs | 0 | **0 ✓** |
| Silent losses | 0 | **0 ✓** |
