# Current MAT Task

> Only one task may be active. Replace the placeholders below before implementation begins.

## Task ID

`UNASSIGNED`

## Title

`Replace with a concise invariant-level title`

## Status

`Not started`

Allowed values:

- Not started
- Reproducing
- Change map complete
- In implementation
- Testing
- Candidate ready
- Awaiting review
- Corrective revision
- Verified
- Blocked
- Deferred

## Parent commit

`<SHA>`

## Invariant

State one process property that must always be true.

Example:

> A final canonical finding is persisted exactly once, while parser diagnostics remain separate and retain their warning counts.

## Observed failure

Describe the concrete runtime or code failure.

Include:

- run ID or artifact, where available;
- affected API, table, function, or file;
- actual observed behavior;
- expected behavior;
- evidence that the defect is real.

## Consequence

Explain why this affects correctness, credibility, completeness, or execution safety.

## Applicable boundaries

Complete this table before editing code.

| Boundary | Production location | Current behavior | Required behavior | Planned test | Applicable? |
|---|---|---|---|---|---|
| Producer | | | | | |
| Parser | | | | | |
| Persistence | | | | | |
| Reload | | | | | |
| Merge/reduction | | | | | |
| Checkpoint/resume | | | | | |
| Recovery | | | | | |
| Output API/UI/export | | | | | |

## Required change

List two to four outcome-based requirements.

1. 
2. 
3. 
4. 

## Non-goals

List areas that must not change in this task.

- 
- 
- 

## Required reproduction

The parent commit must fail a test or diagnostic that exercises the real defect.

Required command:

```bash
<command>
```

Expected parent failure:

- 

## Required tests

### Focused regression

- 

### Negative and failure-path cases

- 

### Immediate downstream check

- 

### Applicable alternate execution paths

- 

### Broader bounded suite

- 

## Required artifacts

The candidate submission must include:

- [ ] Parent SHA
- [ ] Candidate SHA
- [ ] Changed-file inventory
- [ ] Completed change map
- [ ] Exact test commands
- [ ] Parent failure output
- [ ] Candidate pass output
- [ ] Passed/failed/skipped counts
- [ ] Immediate downstream evidence
- [ ] Runtime or replay artifact where applicable
- [ ] Known limitations
- [ ] Unverified paths
- [ ] Updated `tasks/WORKLOG.md`

## Completion checklist

- [ ] Persistent context files read before editing
- [ ] Parent commit confirmed
- [ ] Defect reproduced on parent
- [ ] Change map completed before implementation
- [ ] Only active invariant changed
- [ ] Production path used in testing
- [ ] Positive test passes
- [ ] Negative test passes
- [ ] Failure-path test passes
- [ ] Required skipped tests equal zero
- [ ] Immediate consumer verified
- [ ] Applicable recovery/resume path checked
- [ ] No unexplained out-of-scope files changed
- [ ] Adversarial self-review completed
- [ ] Worklog updated
- [ ] Candidate SHA designated

## Review result

To be completed after independent review.

- Classification:
- Reviewer notes:
- Corrective action, if any:
