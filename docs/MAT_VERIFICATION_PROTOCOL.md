# MAT Verification Protocol

This protocol applies to every MAT implementation task.

## Completion standard

A task is complete only when the active invariant is demonstrated through the applicable production path.

The following are insufficient by themselves:

- code compiles;
- TypeScript is clean;
- migration exists;
- field exists;
- API returns success;
- unit test passes;
- a mocked service returns the expected result;
- a report looks better.

## Required workflow

### 1. Confirm baseline

Before editing, record:

- parent commit SHA;
- current branch;
- migrations present;
- active task ID;
- relevant runtime artifact or reproduction;
- expected files likely to change.

Do not assume the branch or schema matches prior conversation context.

### 2. Read persistent context

Read:

- `docs/MAT_SYSTEM_CONTRACT.md`
- `docs/MAT_KNOWN_TRAPS.md`
- `docs/MAT_VERIFICATION_PROTOCOL.md`
- `tasks/CURRENT_TASK.md`
- `tasks/WORKLOG.md`

Do not begin implementation until the active task and non-goals are clear.

### 3. Produce a change map before editing

Record the applicable boundaries:

| Boundary | Production location | Current behavior | Required behavior | Planned test |
|---|---|---|---|---|
| Producer | | | | |
| Parser | | | | |
| Persistence | | | | |
| Reload | | | | |
| Merge/reduction | | | | |
| Recovery/resume | | | | |
| Output/API/export | | | | |

Mark non-applicable boundaries explicitly. Do not silently omit them.

### 4. Reproduce the defect on the parent commit

Create or identify a test or diagnostic that fails for the actual defect.

The reproduction must:

- exercise the relevant production logic;
- fail for the right reason;
- distinguish query errors, missing rows, empty artifacts, invalid payloads, and substantive negative results;
- not pass because a prerequisite is missing; and
- not merely encode the proposed implementation.

Record the exact command and output.

### 5. Implement only the active invariant

Follow `tasks/CURRENT_TASK.md`.

Do not make:

- unrelated refactors;
- opportunistic fixes;
- broad prompt rewrites;
- schema cleanup outside the task;
- materiality changes unless required;
- formatting changes unless required;
- new feature work.

If an unexpected dependency is discovered, update the change map and worklog before modifying it.

### 6. Run focused tests

Required focused tests should include:

- positive case;
- negative case;
- failure-path case;
- regression case; and
- applicable alternate execution path.

Tests must report passed, failed, and skipped honestly.

A required skipped test blocks completion.

### 7. Run broader applicable checks

Run the smallest broader suite that can detect nearby regressions.

Examples:

- parser suite;
- canonical finding suite;
- merge-contract suite;
- ancestry suite;
- persistence suite;
- recovery suite;
- API integration test;
- migration/schema validation.

Do not run a full deal rerun for every fix unless the active task explicitly requires it. Full production reruns are reserved for designated acceptance checkpoints.

### 8. Verify the immediate downstream consumer

For any changed field, status, artifact, or persistence behavior, prove that the immediate consumer:

- receives the correct value;
- does not silently default it;
- uses it to control the intended decision; and
- behaves correctly after serialization or reload where applicable.

### 9. Perform adversarial self-review

Before designating a candidate commit, inspect the diff for:

- wrong or obsolete schema names;
- wrong identifiers or join keys;
- alternate paths left unchanged;
- swallowed errors;
- empty-result success;
- disabled tests counted as pass;
- mocks bypassing production logic;
- fields produced but not consumed;
- diagnostics mixed with findings;
- duplicate persistence;
- unexplained changes;
- generated arithmetic;
- source-authority violations;
- missing dispositions; and
- inconsistent main/recovery behavior.

### 10. Update the worklog

Before ending any session, update `tasks/WORKLOG.md` with:

- inspections performed;
- conclusions;
- files changed;
- tests run;
- failures encountered;
- unresolved issues;
- exact next step;
- latest commit SHA.

This is mandatory because conversational memory is not reliable.

## Candidate submission packet

A review submission must contain:

- task ID;
- parent SHA;
- candidate SHA;
- branch name;
- changed-file list;
- change map;
- exact test commands;
- parent failure output;
- candidate pass output;
- passed/failed/skipped counts;
- immediate downstream verification;
- relevant runtime or replay artifact;
- out-of-scope change explanation, if any;
- known limitations;
- unverified paths;
- confirmation that the worklog is current.

## Review classification

Independent review should classify the task as one of:

- Verified
- Partially fixed
- Regressed
- Blocked
- Deferred
- Obsolete
- Not verifiable from available evidence

Do not use “implemented” as the final classification.

## Corrective cycle policy

Clark may make internal corrections before designating a candidate commit.

After independent review:

- one bounded corrective submission is permitted for an implementation miss;
- if the design or change map was fundamentally wrong, stop and redesign the task rather than stacking further patches;
- do not add new backlog items to a corrective commit.

## Full-run policy

Per-fix review should use static inspection, targeted tests, persisted fixtures, and bounded integration checks.

A full fresh deal rerun is reserved for a designated acceptance checkpoint after the currently approved set of fixes is complete.
