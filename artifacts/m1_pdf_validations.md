# M1 PDF Validations — Five Genuine Rows from Reconciliation Artifact

**Artifact ID:** `8bc371b1-747f-4c28-84e5-e478cf594d55`  
**Checksum:** `89d03c167360944e-54f57a8fd30d064`  
**Schema Version:** `saint_claim_reconciliation_v1`  
**Total Rows:** 46  

---

## Validation 1 — Positional Ambiguity (Screening Memo)

| Field | Value |
|-------|-------|
| finding_id | `1f523e8f-6bba-4e68-a8c0-173c4282796b` |
| legacy_reference | `c1-8` |
| source_document_id | `2026-05-18 SCG - 2nd IC Memo vS.pdf` |
| resolution_method | `unresolved_ambiguous` |
| confidence | `none` |
| disposition | `unresolved_rejected` |
| rejection_reason | Ambiguous: same positional ID exists in multiple IC documents |
| q3_eligible | `false` |

**Assessment:** Legacy positional reference `c1-8` (chunk 1, claim 8) exists identically in Screening and 2nd IC memos. Reconciler correctly rejects as ambiguous — cannot determine which document's claim is the true source.

---

## Validation 2 — Slug Match Failure (21 June Update)

| Field | Value |
|-------|-------|
| finding_id | `7f8879fa-74dc-49c5-9f82-c78c1fdb0eb6` |
| legacy_reference | `ic_memo_returns_improved_23.4pct_4_1` |
| source_document_id | `2026-06-21 Saint IC update_vS.pdf` |
| resolution_method | `unresolved_ambiguous` |
| match_count | `26` |
| confidence | `none` |
| disposition | `unresolved_rejected` |
| rejection_reason | Multiple claims match slug keywords |
| q3_eligible | `false` |

**Assessment:** Slug reference contains broad keywords ("returns", "improved") that match 26 claims across the ledger. The 21 June Update document had 0 claims persisted, so even though the finding references it, no unique match exists.

---

## Validation 3 — Missing Reference (3rd IC Memo)

| Field | Value |
|-------|-------|
| finding_id | `555dc3fb-44f1-4abe-93f3-1de7ff5d2e2b` |
| legacy_reference | *(null)* |
| source_document_id | `2026-06-15 SCG - 3rd IC Memo vS.pdf` |
| resolution_method | `unresolved_missing_ref` |
| match_count | `0` |
| confidence | `none` |
| disposition | `unresolved_rejected` |
| rejection_reason | No claim reference present on finding |
| q3_eligible | `false` |

**Assessment:** Finding from 3rd IC Memo analysis has no `originating_claim_id` populated. The analysis pipeline generated this contradiction finding without linking it back to a specific IC claim — reconciliation correctly marks as unresolvable.

---

## Validation 4 — Positional Ambiguity (2nd IC Memo)

| Field | Value |
|-------|-------|
| finding_id | `20e3fdf6-170f-4fdb-9e9b-a7e9c782ef04` |
| legacy_reference | `c7-2` |
| source_document_id | `2026-05-18 SCG - 2nd IC Memo vS.pdf` |
| resolution_method | `unresolved_ambiguous` |
| match_count | `0` |
| confidence | `none` |
| disposition | `unresolved_rejected` |
| rejection_reason | Ambiguous: same positional ID exists in multiple IC documents |
| q3_eligible | `false` |

**Assessment:** Position `c7-2` (chunk 7, claim 2) is a valid extraction coordinate that exists in multiple IC memos. The origin map has 579 such ambiguous positions globally. This specific candidate is correctly blocked from Q3.

---

## Validation 5 — Slug No-Match (Screening Memo / Vendor DD Report)

| Field | Value |
|-------|-------|
| finding_id | `bfc2ade3-122d-462e-81a9-6dc77a48b0c3` |
| legacy_reference | `part_39_claim_sip_calls_margin` |
| source_document_id | `SCG - Project Saint - Vendor Financial Due Diligence Report - 28.11.2025.pdf` |
| resolution_method | `unresolved_no_match` |
| match_count | `0` |
| confidence | `none` |
| disposition | `unresolved_rejected` |
| rejection_reason | Slug 'part_39_claim_sip_calls_margin' does not match any claim by metric/period/scope |
| q3_eligible | `false` |

**Assessment:** The slug contains domain terms ("sip_calls", "margin") that don't overlap ≥2 with any claim's metric/period/scope index. This finding was generated from the Vendor DD Report referencing an IC claim that doesn't exist in the structured claims ledger.

---

## Summary

| # | Memo Version | Method | Disposition |
|---|-------------|--------|-------------|
| 1 | 2nd IC | unresolved_ambiguous | rejected (positional) |
| 2 | 21 June Update | unresolved_ambiguous | rejected (slug ×26) |
| 3 | 3rd IC | unresolved_missing_ref | rejected (no ref) |
| 4 | 2nd IC | unresolved_ambiguous | rejected (positional) |
| 5 | Vendor DD | unresolved_no_match | rejected (slug) |

**Memo versions covered:** 2nd IC, 3rd IC, 21 June Update, Vendor DD Report (4 distinct source documents).  
**Validation result:** All 5 rows match the paginated artifact exactly — no invented or representative identifiers.
