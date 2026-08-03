# MAT-F02B: Assertion → Production Function → Test Mapping

## Frozen Assertion 1 — Production invokes the gate

| Aspect | Value |
|--------|-------|
| **Production function** | `admitCandidateEvidence()` in `evidence-admission-boundary.ts` |
| **Production caller** | `ReplayClaimLinkage` at line ~340 in `replay-claim-linkage.ts` |
| **Test** | Test 1: Valid current-model evidence admission |
| **Parent-fail reason** | Prior revision has no import of `evidence-admission-boundary.ts` and no call to `admitCandidateEvidence` in the production loop |

## Frozen Assertion 2 — Valid evidence survives with provenance

| Aspect | Value |
|--------|-------|
| **Production function** | `admitCandidateEvidence()` → `AdmittedEvidenceRecord` with all provenance fields |
| **Test** | Test 9: Admitted provenance retained downstream |
| **Verified fields** | evidence_id, source_document_id, authority_class, coordinate (sheet/cell), target_entity, evidence_role, authority_decision, entity_applicability |
| **Parent-fail reason** | Prior revision does not produce `AdmittedEvidenceRecord` with provenance fields |

## Frozen Assertion 3 — Gamma evidence fails before comparison

| Aspect | Value |
|--------|-------|
| **Production function** | `admitCandidateEvidence()` → `RejectedEvidenceRecord` with `entity_bridge_missing` |
| **Test** | Test 3: Gamma evidence rejected for SCG claim without bridge |
| **Evidence of pre-comparison rejection** | `has_admitted_evidence === false` means no evidence from this entry can reach comparison or eligibility |
| **Parent-fail reason** | Prior revision passes Gamma evidence to `classifyClaimLinkage` without entity validation |

## Frozen Assertion 4 — Invalid authority or coordinate fails before use

| Aspect | Value |
|--------|-------|
| **Production function** | `admitCandidateEvidence()` → respective rejection reasons |
| **Tests** | Test 5 (IC memo self-verification), Test 6 (wrong-page PDF), Test 7 (invalid workbook), Test 8 (wrong authority for proposition) |
| **Verified rejections** | `ic_memo_self_verification`, `quote_not_found`, `invalid_workbook_coordinate`, `authority_not_valid_for_proposition` |
| **Parent-fail reason** | Prior revision has no coordinate validation or entity applicability enforcement at the production evidence boundary |

## Frozen Assertion 5 — Admitted and rejected records survive persistence/reload

| Aspect | Value |
|--------|-------|
| **Production function** | `serializeEvidenceAdmissionLedger()` + `deserializeEvidenceAdmissionLedger()` |
| **Persistence location** | `evidence_admission_ledgers` array in Q3 checkpoint (tree_level=96) |
| **Test** | Test 10: Evidence persistence and reload |
| **Verified round-trip fields** | evidence_id, candidate_or_claim_reference, coordinate, authority_decision, entity_applicability, admission_status, rejection_reason |
| **Parent-fail reason** | Prior revision does not persist evidence admission records |

---

## Files Changed

1. `server/apis/pipeline/evidence-admission-boundary.ts` — NEW: Legacy-to-canonical adapter, production admission boundary, batch admission, persistence
2. `server/apis/pipeline/replay-claim-linkage.ts` — MODIFIED: Added evidence admission import, gate invocation in candidate loop, admission ledger persistence
3. `server/apis/pipeline/__tests__/mat-f02b-production-evidence-admission.test.ts` — NEW: 10 production-path tests
4. `acceptance/MAT-F02B/fixture-output.json` — NEW: Machine-generated fixture records
5. `acceptance/MAT-F02B/assertion-mapping.md` — NEW: This file

---

## Known Limitations Outside Scope

1. **Source text validation deferred**: PDF quote validation passes `source_text: ""` (empty) in the production caller because full document text is not loaded in the Q3 replay. This means `quote_not_found` rejection can only be triggered when source text IS available. Full text loading belongs to a later fix.
2. **Entity defaults to "SCG"**: When the resolved claim has no explicit entity field, the production boundary defaults to `"SCG"`. Multi-entity deals will need explicit entity resolution in a future batch.
3. **Sheet validation not connected**: The workbook coordinate validator accepts sheets that pass format checks but doesn't verify against the actual workbook (available_sheets is not populated from document storage). This belongs to the storage integration layer.
4. **Cell value verification deferred**: `cell_values` map is not populated from the actual workbook. The coordinate passes if format is valid.
5. **Full compatibility (metric/period/scope/units) is NOT enforced**: This batch only gates evidence admission. Whether two admitted evidence entries are compatible for comparison is a later MAT fix.
6. **No LLM demotion or verdict recalculation**: Admitted evidence does not yet change the verdict or override the existing `classifyClaimLinkage` decision. That integration is deferred to the deterministic verdict batch.
