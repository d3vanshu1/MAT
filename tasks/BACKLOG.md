# MAT Invariant Backlog

This backlog records process-level work. Clark must not implement directly from this file.

Only one approved item may be copied into `tasks/CURRENT_TASK.md` at a time.

## Status values

- Not started
- Reproduced
- In implementation
- Awaiting review
- Partially fixed
- Verified
- Regressed
- Deferred
- Blocked
- Obsolete

## Priority rules

Prioritize in this order unless runtime evidence requires otherwise:

1. Publication and run-integrity defects that can expose incomplete or wrong output
2. Finding duplication, loss, or mutation
3. Evidence and canonical-field preservation
4. Execution-path parity
5. Numeric comparability and deterministic validation
6. Finding identity and reduction
7. Materiality and omission behavior
8. Formatting and presentation

Do not start a lower-priority item when a higher-priority invariant is actively broken and affects the same path.

## Backlog table

| ID | Area | Invariant | Evidence / defect | Dependency | Status | Notes |
|---|---|---|---|---|---|---|
| MAT-001 | Final persistence | Every parsed canonical finding is persisted exactly once; diagnostics remain separate. | A parsed finding can appear in both `findings` and `invalid`, then be concatenated during persistence. | None | Verify current status | Confirm whether already fixed in current baseline. |
| MAT-002 | Publication safety | A run cannot publish unless all required work and merge nodes are terminal and the canonical artifact is complete. | Historical incomplete or degraded runs may have produced polished reports. | None | Not started | Must use persisted manifest and artifact state. |
| MAT-003 | Canonical data flow | Required canonical fields survive producer, parser, serialization, checkpoint, reload, consolidation, final persistence, API, export, and recovery. | Fields may exist in schema but be defaulted, dropped, or unused downstream. | MAT-001 | Not started | Trace one field family at a time within a single invariant task. |
| MAT-004 | Recovery parity | Interrupted/resumed and uninterrupted execution produce equivalent canonical artifacts or fail visibly. | Timeout, refresh, and recovery behavior may alter findings. | MAT-002, MAT-003 | Not started | Compare structured artifacts, IDs, ancestry, and dispositions. |
| MAT-005 | Reduction accounting | Every candidate has exactly one final disposition; no unexplained expansion, disappearance, or duplication. | Large finding counts and reduction waterfalls are not fully reconstructable. | MAT-003 | Not started | Record retained, merged, rejected, diagnostic, or blocking status. |
| MAT-006 | Finding identity | Duplicate families consolidate while required separation dimensions prevent overmerge. | Repeated legal families and group/item conflation. | MAT-003, MAT-005 | In progress / verify | Confirm current family service against production artifacts. |
| MAT-007 | Numeric comparability | Numeric candidates with incompatible or unknown metric, period, scope, unit, entity, basis, or actual/forecast status are rejected. | Known false positives arose from period and scope mismatches. | MAT-003 | Not started | Delta must be code-computed. |
| MAT-008 | Source authority | Findings use the appropriate authoritative source; lower-authority conflicts are explicit. | Legal matters may be attributed to commercial sources; stale sources may be treated as current. | MAT-003 | Not started | Fail closed where authority is unresolved. |
| MAT-009 | Infrastructure failure semantics | Query, parse, missing artifact, timeout, and disabled-test states remain process diagnostics and cannot become substantive conclusions. | Empty or errored paths may return complete or no-issue outcomes. | MAT-002 | In progress / verify | Include honest passed/failed/skipped reporting. |
| MAT-010 | Omission integrity | Omission findings require supported source issue, complete memo coverage, materiality, and verified absence. | Incomplete claims extraction can create false omission conclusions. | MAT-002, MAT-003, MAT-009 | In progress / verify | Do not infer absence from missing data. |
| MAT-011 | Severity integrity | Severity is driven by structured impact and explicit anchors, not rhetorical wording. | Immaterial matters have been rated critical. | MAT-003, MAT-005 | Not started | Preserve rationale and uncertainty. |
| MAT-012 | One canonical output | Main, recovery, UI, API, and export use the same final persisted artifact and status. | Different paths may read different fields or intermediate artifacts. | MAT-002, MAT-003, MAT-004 | Not started | Include artifact identity/hash where available. |

## Adding a backlog item

Every new item must include:

- one-sentence invariant;
- concrete evidence;
- affected process area;
- dependencies;
- reason for priority; and
- status.

Do not add implementation prescriptions until the item becomes the active task and the change map is completed.
