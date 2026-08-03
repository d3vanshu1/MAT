# MAT-F04 Assertion → Function → Test Mapping

## Frozen Acceptance Assertions

### Assertion 1 — Complete £194m comparison survives downstream

| Component | Location |
|-----------|----------|
| Production function | `buildCanonicalFindingRecord()` in `canonical-finding-record.ts` |
| Persistence boundary | `serializeCanonicalFinding()` / `deserializeCanonicalFinding()` |
| Production wiring | `replay-claim-linkage.ts` → MAT-F04 block (builds and persists canonical_findings) |
| Tests | Test 1 (complete finding), Test 2 (workbook coord), Test 10 (reload parity) |

### Assertion 2 — Rejected evidence cannot reappear

| Component | Location |
|-----------|----------|
| Production function | `extractEvidenceFromAdmittedOnly()` in `canonical-finding-record.ts` |
| Guard | `buildCanonicalFindingRecord()` only accepts `AdmittedEvidenceRecord[]` |
| Production wiring | `replay-claim-linkage.ts` passes `evidenceAdmission.admitted` (not rejected) |
| Tests | Test 3 (filtering), Test 4 (cannot reattach) |

### Assertion 3 — Distinct comparison bases do not overmerge

| Component | Location |
|-----------|----------|
| Production function | `generatePropositionKey()` in `canonical-finding-record.ts` |
| Dimensions included | entity, metric, period, segment, scope, unit, actual_forecast, accounting_basis, comparison_basis |
| Tests | Test 5 (memo vs live-hardcoded), Test 6 (reported vs cash EBITDA), Test 7 (EBITDA vs adjustments) |

### Assertion 4 — Identity is stable and narrative-independent

| Component | Location |
|-----------|----------|
| Production function | `computeSemanticHash()` / `computeFindingId()` in `canonical-finding-record.ts` |
| Evidence ordering | Sorted by evidence_id before hashing |
| Narrative exclusion | `narrative` field NOT included in hash input |
| Tests | Test 8 (evidence order), Test 9 (title/summary), Test 10 (reload), Test 11-14 (change → changes identity), Test 20 (deterministic) |

### Assertion 5 — No prose reconstruction in production

| Component | Location |
|-----------|----------|
| Production function | `validateNoProseReconstruction()` in `canonical-finding-record.ts` |
| Type design | `CanonicalFindingRecord` has NO `detail`/`full_analysis` fields |
| Evidence derivation | All coordinates from `canonical_record.coordinate`, not text |
| Tests | Test 15 (narrative deletion), Test 16 (no detail/full_analysis), Test 17 (no first-source fallback), Test 18 (legacy derives from canonical), Test 19 (canonical remains source of truth) |

## Test → Assertion Mapping

| # | Test | Assertion |
|---|------|----------|
| 1 | Complete £194m revenue finding preservation | 1 |
| 2 | Exact workbook evidence ID and coordinate retention | 1 |
| 3 | Mixed admitted/rejected evidence filtering | 2 |
| 4 | Rejected evidence cannot reattach downstream | 2 |
| 5 | memo-versus-model and live-versus-hardcoded remain distinct | 3 |
| 6 | reported versus cash EBITDA remain distinct | 3 |
| 7 | EBITDA versus EBITDA adjustments remain distinct | 3 |
| 8 | evidence order does not change identity | 4 |
| 9 | title/summary changes do not change identity | 4 |
| 10 | persistence/reload identity parity | 1, 4 |
| 11 | claim change changes identity | 4 |
| 12 | evidence-set change changes identity | 4 |
| 13 | comparison-basis change changes identity | 4 |
| 14 | verdict change changes identity | 4 |
| 15 | narrative deletion still permits full reconstruction | 5 |
| 16 | no detail/full_analysis evidence reconstruction | 5 |
| 17 | no first-source fallback | 5 |
| 18 | legacy adapter derives from canonical record | 5 |
| 19 | canonical record remains source of truth after reload | 1, 5 |
| 20 | semantic hash is deterministic across repeated execution | 4 |

## Known Limitations (Out of Scope)

1. **Q5 presentation**: Consumes canonical record but presentation logic not changed
2. **Final materializer/write parity**: The API export layer is not yet modified to emit canonical records
3. **Complete terminal accounting**: Terminal ledger enrichment deferred
4. **Full Saint precision and recall**: Requires complete deal rerun (deferred)
5. **LLM narration restrictions**: Narrative generation not modified beyond blocking provenance mutation
6. **Q4 duplicate-family logic**: Grouping consumes proposition_key but dedup logic unchanged
