# MAT Worklog

This file is the persistent session memory for the active task.

Update it before ending every Clark session, even if no code was changed.

Do not delete prior entries. Add the newest entry at the top.

---

## Entry template

### Date and session

`YYYY-MM-DD — Session N`

### Active task

`<Task ID and title>`

### Starting commit

`<SHA>`

### Current commit

`<SHA or working tree status>`

### Files and areas inspected

- 

### What was learned

- 

### Change map updates

- 

### Code changes made

- 

### Tests and commands run

```bash
<command>
```

Result:

- passed:
- failed:
- skipped:
- key output:

### Problems encountered

- 

### Unresolved questions or risks

- 

### Exact next step

1. 
2. 

### Candidate status

- [ ] Not ready
- [ ] Candidate ready for review

### Candidate SHA, if ready

`<SHA>`

---

## DEMO-001: Removal — Session 2

### Date and session

`2026-08-06 — Session 2`

### Active task

`DEMO-001: Remove Omission Audit demo mode`

### Starting commit

`e6cb24e437aa7badea5c6e20877d4aa882b9b28c`

### Current commit

`6b99269bf17b7437fc8a371f9ee5250e4af4aab2`

### Files and areas inspected

- `client/lib/demoConfig.ts` — demo flag (deleted)
- `client/fixtures/omissionAuditDemo.ts` — fixture (deleted)
- `client/fixtures/__tests__/omission-audit-demo.test.ts` — tests (deleted)
- `client/components/ic/modules/DemoBanner.tsx` — banner (deleted)
- `client/components/ic/modules/ModuleCard.tsx` — reverted to production-only

### What was learned

- Demo mode is no longer required.

### Change map updates

| File | Change type | Purpose |
|------|------------|---------|
| `client/lib/demoConfig.ts` | DELETE | Remove demo flag |
| `client/fixtures/omissionAuditDemo.ts` | DELETE | Remove fixture |
| `client/fixtures/__tests__/omission-audit-demo.test.ts` | DELETE | Remove tests |
| `client/components/ic/modules/DemoBanner.tsx` | DELETE | Remove banner |
| `client/components/ic/modules/ModuleCard.tsx` | MODIFY | Revert to production-only rendering |

### Code changes made

- Deleted all demo-mode files
- Removed demo imports and conditional logic from ModuleCard.tsx
- Restored standard `status` usage in place of `effectiveStatus`

### Tests and commands run

- `build_debug` — all checks passed

### Problems encountered

- None.

### Unresolved questions or risks

- None.

### Exact next step

- None. Task complete.

### Candidate status

- [x] Candidate ready for review

### Candidate SHA, if ready

`6b99269bf17b7437fc8a371f9ee5250e4af4aab2`

---

## DEMO-001: Omission Audit demo mode — Session 1

### Date and session

`2026-08-05 — Session 1`

### Active task

`DEMO-001: Replace Omission Audit display with controlled demo report`

### Starting commit

`e6cb24e437aa7badea5c6e20877d4aa882b9b28c`

### Current commit

`in progress`

### Files and areas inspected

- `client/types/module.ts` — Finding and ModuleOutput interfaces
- `client/components/ic/modules/ModuleOutput.tsx` — current report renderer
- `client/components/ic/modules/ModuleCard.tsx` — card rendering and output toggle
- `client/components/ic/modules/ModuleGrid.tsx` — grid layout
- `client/lib/moduleConfig.ts` — module definitions (omission_audit ID)
- `client/lib/pipelineConfig.ts` — existing configuration constant pattern
- `client/pages/DealDashboard/index.tsx` — statuses population and render

### What was learned

- ModuleCard renders ModuleOutput when user clicks "Details"
- `statuses["omission_audit"].latestOutput` drives the findings display
- Finding interface: { severity, title, detail, full_analysis, source_docs }
- Cleanest interception: override the status for omission_audit before render
- Configuration constants pattern: exported const from `client/lib/` files

### Change map updates

| File | Change type | Purpose |
|------|------------|---------|
| `client/lib/demoConfig.ts` | NEW | OMISSION_AUDIT_DEMO_MODE flag |
| `client/fixtures/omissionAuditDemo.ts` | NEW | Immutable 8-finding fixture |
| `client/components/ic/modules/ModuleCard.tsx` | MODIFY | Demo banner + routing |
| `tasks/CURRENT_TASK.md` | MODIFY | Task definition |
| `tasks/WORKLOG.md` | MODIFY | This entry |
| `client/fixtures/__tests__/omission-audit-demo.test.ts` | NEW | Behavioral tests |

### Code changes made

- (in progress)

### Tests and commands run

- (pending)

### Problems encountered

- None yet.

### Unresolved questions or risks

- None.

### Exact next step

1. Create `client/lib/demoConfig.ts` with OMISSION_AUDIT_DEMO_MODE flag.
2. Create `client/fixtures/omissionAuditDemo.ts` with 8 demo findings.
3. Modify ModuleCard to intercept demo mode for omission_audit.
4. Add demo banner component.
5. Write behavioral tests.
6. Screenshot and verify.

### Candidate status

- [ ] Not ready

### Candidate SHA, if ready

`pending`

---

### Date and session

`2026-08-05 — Session 1`

### Active task

`UNASSIGNED`

### Starting commit

`03302a68256edecea90886f2cae6e14ac7a4959b`

### Current commit

`e7ac23d52434f5ad432613adf9d4ee707d873ec6`

### Files and areas inspected

- Repository-control markdown files created.

### What was learned

- The active implementation task has not yet been assigned.

### Change map updates

- None.

### Code changes made

- Added persistent MAT system contract, known traps, verification protocol, active task template, worklog, and backlog.

### Tests and commands run

- Documentation-only change; no production test required.

### Problems encountered

- None.

### Unresolved questions or risks

- `tasks/CURRENT_TASK.md` must be populated before implementation begins.

### Exact next step

1. Set the baseline parent SHA.
2. Copy one approved invariant from `tasks/BACKLOG.md` into `tasks/CURRENT_TASK.md`.
3. Complete the change map and reproduction before editing production code.

### Candidate status

- [x] Candidate ready for review

### Candidate SHA, if ready

`e7ac23d52434f5ad432613adf9d4ee707d873ec6`
