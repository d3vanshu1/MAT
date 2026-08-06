# Current MAT Task

> Only one task may be active. Replace the placeholders below before implementation begins.

## Task ID

`DEMO-001`

## Title

Replace Omission Audit display with controlled demo report when demo mode is enabled

## Status

`In implementation`

## Parent commit

`e6cb24e437aa7badea5c6e20877d4aa882b9b28c`

## Invariant

> When `OMISSION_AUDIT_DEMO_MODE` is enabled, the UI renders exactly the immutable 8-finding demo fixture through the existing report components. When disabled or absent, existing production behavior is unchanged. The demo fixture is never persisted to production tables, never overwrites the production artifact, and never mutates the live run status.

## Observed failure

Not a defect — this is a presentation task. The current Omission Audit output contains ~500 findings from the SCG pipeline run, which is not suitable for product demonstration purposes.

## Consequence

The raw 500-finding output cannot be used credibly in a product demonstration. A controlled, concise sample is needed to illustrate the intended user experience.

## Applicable boundaries

| Boundary | Production location | Current behavior | Required behavior | Planned test | Applicable? |
|---|---|---|---|---|---|
| Producer | N/A (fixture) | N/A | Fixture is immutable, not produced by pipeline | Fixture schema validation | Yes |
| Parser | N/A | N/A | N/A | N/A | No |
| Persistence | module_outputs table | Production artifact persisted | Demo fixture is NOT persisted | Test: no DB write in demo mode | Yes |
| Reload | DealDashboard statuses | Loads from DB | Demo mode intercepts before render | Test: disabled mode unchanged | Yes |
| Merge/reduction | N/A | N/A | Not invoked in demo mode | N/A | No |
| Checkpoint/resume | N/A | N/A | Not invoked in demo mode | N/A | No |
| Recovery | N/A | N/A | Not invoked in demo mode | N/A | No |
| Output API/UI/export | ModuleCard/ModuleOutput | Renders production findings | Renders demo fixture with banner | Screenshot + test | Yes |

## Required change

1. Add `OMISSION_AUDIT_DEMO_MODE` configuration flag in client-side config.
2. Create immutable demo fixture with 8 findings at `client/fixtures/omissionAuditDemo.ts`.
3. Add selection layer that routes to demo fixture when flag is enabled, using existing render components.
4. Display demo banner, executive summary, coverage limitations, and 8 findings without touching production data.

## Non-goals

- Do not fix the underlying Omission Audit pipeline.
- Do not alter merge logic, reduction, prompts, or canonical finding policy.
- Do not delete or relabel the current 500-finding production artifact.
- Do not persist the demo fixture as a completed live audit.
- Do not change other MAT modules.
- Do not perform broad UI refactoring.

## Required tests

### Focused regression

- Demo mode enabled returns exactly 8 findings with correct severities (2/4/2).
- All findings contain `is_demo_fixture: true` and `artifact_status: "illustrative_demo"`.
- Demo fixture validates against the production canonical schema (Finding type).

### Negative and failure-path cases

- Demo mode disabled follows existing production path unchanged.
- Production findings cannot be concatenated with demo fixture.
- Missing/invalid fixture fails visibly rather than falling back to production under demo label.

### Immediate downstream check

- Demo mode does not query or mutate the production Omission Audit artifact.
- Demo mode does not change the production run status.
- Banner and limitation language present in rendered output.

### Applicable alternate execution paths

- Flag absent treated as disabled.

## Required artifacts

- [x] Parent SHA
- [x] Candidate SHA
- [x] Changed-file inventory
- [x] Completed change map
- [ ] Exact test commands
- [ ] Candidate pass output
- [ ] Screenshot of demo report
- [ ] Confirmation production artifact/run status unmodified
- [ ] Confirmation disabling demo mode restores production path
- [x] Updated `tasks/WORKLOG.md`

## Completion checklist

- [x] Persistent context files read before editing
- [x] Parent commit confirmed
- [x] Change map completed before implementation
- [ ] Only active invariant changed
- [ ] Production path used in testing
- [ ] Positive test passes
- [ ] Negative test passes
- [ ] Failure-path test passes
- [ ] No unexplained out-of-scope files changed
- [ ] Worklog updated
- [ ] Candidate SHA designated

## Review result

To be completed after independent review.

- Classification:
- Reviewer notes:
- Corrective action, if any:
