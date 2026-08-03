# MAT-F06 Assertion Mapping

## Frozen Assertions → Test Coverage

| Assertion | Test IDs | Production Function(s) Tested |
|-----------|----------|-------------------------------|
| A1: One finalizer across all paths | A1.01–A1.05 | `canonicalFinalize()` |
| A2: Missing prerequisites block completion | A2.01–A2.06 | `canonicalFinalize()` prerequisite validation |
| A3: Exactly one durable write | A3.01–A3.05 | `canonicalFinalize()` persist + completion |
| A4: Report/API/export parity | A4.01–A4.06 | `formatCanonicalReport()`, `computeSemanticHash()`, `buildSemanticHashInput()` |
| A5: Diagnostics cannot become findings | A5.01–A5.05 | `getReportExclusionReason()` |

## Status Outcome Coverage (A1)

| Outcome | Test | Scenario |
|---------|------|----------|
| `completed` | A1.01 | Fresh run, no existing output |
| `idempotent` | A1.02 | Same hash → no-op |
| `rejected_overwrite` | A1.03 | Different hash on completed run |
| `completed` (update) | A1.04 | Existing output but run is `running` |
| `persist_failed` | A1.05 | Verification query returns empty |

## Prerequisite Coverage (A2)

| Test | Missing Key | Module Type | Expected |
|------|-------------|-------------|----------|
| A2.01 | claims_ledger | contradiction_check | blocked |
| A2.02 | reconciliation | contradiction_check | blocked |
| A2.03 | canonical_findings | contradiction_check | blocked |
| A2.04 | all three | contradiction_check | all listed |
| A2.05 | claims_ledger (absent) | model_assumptions_stress | NOT blocked |
| A2.06 | claims_ledger (status=failed) | contradiction_check | blocked |

## Write Count Coverage (A3)

| Test | Scenario | Expected Writes |
|------|----------|----------------|
| A3.01 | Fresh run | 1 INSERT |
| A3.02 | Existing + running | 1 UPDATE |
| A3.03 | Idempotent | 0 writes |
| A3.04 | Ordering | persist BEFORE completion |
| A3.05 | Hash storage | semantic_hash in module_runs |

## Parity Coverage (A4)

| Test | Property Verified |
|------|-------------------|
| A4.01 | Report contains only reportable findings |
| A4.02 | Hash is insertion-order-insensitive |
| A4.03 | Same content → same hash |
| A4.04 | Different content → different hash |
| A4.05 | Pre-formatted report passed through |
| A4.06 | Excluded count appears in disclosures |

## §F Filter Coverage (A5)

| Test | Input Type | Expected Exclusion |
|------|------------|-------------------|
| A5.01 | Process finding (finding_kind="process") | `process_object` |
| A5.02 | Housekeeping finding (title contains "[Housekeeping]") | `housekeeping` |
| A5.03 | Degraded notice (finding_kind="degraded_run_notice") | `degraded_notice` or `unlinked` |
| A5.04 | Placeholder ("No findings identified") | `placeholder` |
| A5.05 | Genuine reportable finding | `null` (not excluded) |

## Supplementary Tests

| Test | Function | Validates |
|------|----------|----------|
| loadCheckpointStatus | `loadCheckpointStatus()` | Synthetic `canonical_findings` key from `hasParsedFindings` flag |

## Implementation Files Modified

| File | Change |
|------|--------|
| `server/apis/pipeline/pipeline-core.ts` | Fast-path + main-path now delegate to `f06CanonicalFinalize` |
| `server/apis/modules/save-module-result.ts` | §D guard: skip duplicate write when canonically finalized |
| `server/apis/pipeline/canonical-finalizer.ts` | Pre-existing (verified complete) |
| `server/apis/pipeline/canonical-final-artifact.ts` | Pre-existing (verified complete) |
| `server/apis/pipeline/finalize-pipeline-output.ts` | Pre-existing (already delegates correctly) |

## SaveModuleResult §D Guard

When `runId` is provided:
1. Query `module_runs.status` and `module_outputs.semantic_hash`
2. If status = `completed` AND semantic_hash IS NOT NULL:
   - Log canonical-finalized skip
   - Update `documents_included` if provided
   - Return existing `output_id` — **no duplicate upsertModuleOutput call**
3. Otherwise: proceed with legacy `upsertModuleOutput`
