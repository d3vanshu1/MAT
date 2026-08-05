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

## Initial entry

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
