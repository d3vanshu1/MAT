# MAT Known Traps

This file records recurring implementation mistakes already observed in MAT. Read it before editing production code.

## 1. Correct-looking code using the wrong production schema

Observed pattern:

- query references a nonexistent or obsolete column;
- query reads `output_json` where production data is stored in another field;
- query filters JSON content when a dedicated status column exists;
- code uses `run_id` where the table is keyed by `module_run_id`, or vice versa.

Required safeguard:

- inspect the actual migration and table definition;
- inspect at least one real persisted row;
- test query errors, missing rows, empty results, and invalid payloads;
- fail closed rather than returning a successful empty result.

## 2. A successful API response is treated as proof

Observed pattern:

- API returns `status: complete` for a nonexistent or empty run;
- endpoint returns HTTP success while underlying query or validation is wrong;
- smoke test validates only transport, not substance.

Required safeguard:

- assert the exact persisted artifact, counts, status, and required fields;
- include negative tests;
- verify the immediate downstream consumer.

## 3. Disabled or skipped tests reported as passed

Observed pattern:

- unavailable integration test is counted as success;
- test harness catches an error and reports a green diagnostic;
- missing fixture produces an empty pass.

Required safeguard:

- distinguish passed, failed, and skipped;
- missing prerequisites must be visible;
- a required skipped test blocks completion.

## 4. Mock tests bypass the production path

Observed pattern:

- test recreates the intended logic rather than calling the real service;
- persistence, parser, merge, or recovery boundary is mocked away;
- local helper passes while production consumer remains broken.

Required safeguard:

- call production functions wherever practical;
- use persisted production-shaped fixtures;
- explicitly list mocked boundaries and explain why they do not invalidate the test.

## 5. A field is added but not propagated

Observed pattern:

- schema, type, or parser contains a field;
- merge serialization drops it;
- checkpoint reload regenerates or defaults it;
- consumer never reads it;
- recovery path uses an older shape.

Required safeguard:

Trace the field through:

1. producer;
2. merge output;
3. parser;
4. serialization;
5. checkpoint write;
6. checkpoint read;
7. reconciliation or consolidation;
8. materiality or omission logic;
9. final persistence;
10. API and export;
11. recovery path.

## 6. Main and recovery paths diverge

Observed pattern:

- main path uses the new parser or artifact;
- recovery uses legacy fields or different defaults;
- resumed runs duplicate or drop singleton branches;
- completion timing changes the final result.

Required safeguard:

- identify every applicable execution path before editing;
- compare canonical outputs from uninterrupted and recovered execution;
- require visible failure when parity cannot be established.

## 7. Diagnostics are persisted as findings

Observed pattern:

- parser returns the same object in both valid findings and invalid/diagnostic collections;
- persistence concatenates both collections;
- normal warnings or severity caps create duplicate final findings.

Required safeguard:

- persist each canonical finding exactly once;
- keep diagnostics separate;
- preserve warning counts without re-adding diagnostic objects to findings.

## 8. Query failure becomes substantive approval

Observed pattern:

- missing or errored data returns an empty array;
- empty array is interpreted as “no issue” or “complete”;
- unavailable source is treated as absence.

Required safeguard:

- fail closed on query errors, missing required rows, empty required artifacts, and parse failures;
- infrastructure state must remain a process diagnostic.

## 9. Reduction removes findings without a disposition

Observed pattern:

- merge count decreases but removed findings cannot be traced;
- model-generated summary silently drops branches;
- no reason exists for rejection, merge, or removal.

Required safeguard:

- preserve ancestry;
- record one disposition for every candidate;
- block publication when required candidates are unaccounted for.

## 10. Generic semantic merge over-expands or over-merges

Observed pattern:

- one raw issue becomes several findings at the next level;
- distinct contracts, obligations, entities, or periods are merged together;
- group-level and item-level findings are conflated.

Required safeguard:

- partition on required structured separation dimensions before semantic merge;
- test both duplicate consolidation and anti-overmerge cases;
- require stable family IDs and membership.

## 11. Numeric comparisons ignore scope or period

Observed pattern:

- FY24 figure labeled FY25;
- reported revenue compared with organic or like-for-like revenue;
- segment value compared with group value;
- company metric compared with market size;
- percentage compared with currency;
- forecast compared with actual without explicit policy.

Required safeguard:

- make metric, period, scope, unit, entity, basis, and actual/forecast status required comparability dimensions;
- reject unknown or incompatible dimensions;
- compute deltas in code.

## 12. Wrong source authority

Observed pattern:

- commercial diligence used as sole support for a legal finding;
- management material overrides model ground truth;
- stale document is treated as current without qualification.

Required safeguard:

- enforce source-authority policy;
- preserve conflicts;
- classify stale or lower-authority evidence explicitly.

## 13. Severity follows language rather than impact

Observed pattern:

- small monetary matter rated critical;
- speculative legal issue escalated without an anchor;
- merged prose increases rhetorical severity.

Required safeguard:

- use structured impact and explicit severity anchors;
- test materiality thresholds and uncertainty handling;
- preserve reviewer rationale.

## 14. Broad corrective commits introduce adjacent regressions

Observed pattern:

- one fix also changes parser policy, merge behavior, schemas, prompts, recovery, and formatting;
- test failures become hard to attribute;
- correction requires further correction.

Required safeguard:

- one active invariant;
- explicit non-goals;
- changed-file inventory;
- reject unexplained out-of-scope changes.

## 15. TypeScript-clean is treated as end-to-end completion

Observed pattern:

- code compiles but runtime query, persisted shape, or consumer is wrong;
- unit tests pass but production artifact is invalid.

Required safeguard:

Completion requires:

- parent reproduction;
- candidate pass;
- boundary verification;
- applicable production-path check;
- artifact evidence;
- honest statement of unverified paths.
