# MAT-F07 Assertion Mapping

## Frozen Assertions → Production Functions → Tests

| Assertion | Production Function(s) | Test(s) |
|-----------|----------------------|--------|
| **1** — Diagnostic/preflight uses real production stages | `executeQ3Stage` → `classifyClaimLinkage`, `executeQ4Stage` → `groupIntoCanonicalFamilies`, `executeQ5Stage` | Tests 1, 2, 3 |
| **2** — Q3 rejection cannot bypass into Q4/Q5 | `executeQ4Stage` (eligibility filter), `executeTerminalAccounting` | Tests 8, 9, 10, 11, 12, 13, 14 |
| **3** — Canonical grouping and provenance survive | `groupIntoCanonicalFamilies` (full `CanonicalKey`), `executeQ5Stage` (F04 finding identity) | Tests 15, 16, 17, 18, 19, 20, 21 |
| **4** — Every Q2 candidate receives one terminal outcome | `executeTerminalAccounting` | Tests 22, 23, 24, 25, 26, 27, 28, 29 |
| **5** — Counts and references reconcile across all boundaries | `reconcileAllStages` | Tests 30, 31, 32 |

## Parent-Fail / New-Pass Matrix

| Test | Parent Behavior | Root Cause |
|------|----------------|------------|
| 1 | FAIL | Old code hardcoded `claim_linked_contradicted` for all |
| 4 | FAIL | All candidates got `contradicted` disposition |
| 5 | FAIL | All candidates got `authority_valid: true` |
| 6 | FAIL | All candidates got `q4_eligible: true` |
| 7 | FAIL | Q5 used `verification_status: "verified"` |
| 8 | FAIL | Missing-claim candidates entered Q4 (all were q4_eligible) |
| 9 | FAIL | Invalid-authority candidates entered Q4 |
| 12 | FAIL | Q3-ineligible candidates appeared in Q5 |
| 13 | FAIL | No eligibility filter existed |
| 14 | FAIL | Same as 13 |
| 22 | FAIL | Only reportable+nonReportable got terminal (not all candidates) |
| 28 | FAIL | Terminal accounting had gaps |
| 29 | FAIL | Supporting, confirmed, unverifiable candidates lost |
| 30 | FAIL | No cross-stage reference validation existed |
| 31 | FAIL | No reportable↔finding resolution validation existed |

## Files Changed

| File | Change Summary |
|------|---------------|
| `server/apis/pipeline/q2-q5-production-chain.ts` | **NEW** — Single shared orchestration module for Q3/Q4/Q5/terminal/reconciliation |
| `server/apis/pipeline/q2-q5-disposition-bridge.ts` | **NEW** — Canonical comparison → disposition aggregation bridge |
| `server/apis/pipeline/persist-prove-q2.ts` | STEPS 8–11 rewritten to call production chain (removed hardcoded Q3/Q4/Q5) |
| `server/apis/pipeline/__tests__/mat-f07-q2-q5-chain.test.ts` | **NEW** — 32 targeted production-path tests |
| `acceptance/MAT-F07/q2-candidates.jsonl` | **NEW** — Row-level Q2 fixture |
| `acceptance/MAT-F07/q3-results.jsonl` | **NEW** — Row-level Q3 results |
| `acceptance/MAT-F07/q4-families.jsonl` | **NEW** — Row-level Q4 families |
| `acceptance/MAT-F07/q5-findings.jsonl` | **NEW** — Row-level Q5 findings |
| `acceptance/MAT-F07/terminal-ledger.jsonl` | **NEW** — Complete terminal ledger (10 rows = 10 candidates) |
| `acceptance/MAT-F07/cross-stage-reconciliation.json` | **NEW** — Full reconciliation proof |

## Known Limitations Outside F07 Scope

1. **Schema migration** — `module_outputs` columns (`semantic_hash`, `reportable_finding_ids`, `schema_version`) remain planned; F06 APIs use try-catch fallback
2. **Full Saint rerun** — Deferred to F08; F07 uses seeded fixture, not production corpus
3. **Database persistence of stage artifacts** — Artifacts persist as JSONB in `merge_checkpoints`; normalized tables for Q2/Q3/Q4/Q5/terminal are not yet schema-migrated
4. **Diagnostic APIs** (`diag-*.ts`) — Not yet refactored to call production chain; covered by preflight API (`PersistAndProveQ2`) which IS the production proof path
5. **Replay APIs** (`replay-*.ts`) — `replay-claim-linkage.ts` already uses `classifyClaimLinkage`; `replay-canonical-identity.ts` already uses `groupIntoCanonicalFamilies`; these were already correct
