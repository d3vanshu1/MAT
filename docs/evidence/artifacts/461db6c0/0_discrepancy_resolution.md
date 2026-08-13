# Discrepancy Resolution — Run 461db6c0-c8a7-4073-96d6-832ff506469b

## 0.1 — module_runs row

```
id:           461db6c0-c8a7-4073-96d6-832ff506469b
module_id:    omission_audit
status:       failed
triggered_at: 2026-08-13T03:15:13.270Z
completed_at: 2026-08-13T03:46:33.492Z
```

Source: `DiagnoseRunEvidence` API → moduleRunRow query:
```sql
SELECT id, module_id, status, triggered_at, completed_at
FROM module_runs WHERE id = $1 LIMIT 1
```

**error_message column**: EXISTS (added by migration 010) but NOT selected by any
diagnostic API currently registered. The `DiagnoseRunEvidence` query only selects
`id, module_id, status, triggered_at, completed_at`. No API in the registry exposes
`module_runs.error_message` or `module_runs.error_phase` for read.

→ NOTPERSISTED: error_message/error_phase are NOT AVAILABLE via existing read APIs.
  Table: module_runs. Columns: error_message TEXT, error_phase TEXT (added by migration 010).
  They are WRITTEN by `markRunFailed()` at pipeline-core.ts:2403 but not READ by any
  diagnostic API.

## 0.2 — module_outputs row

**Does a module_outputs row exist for 461db6c0?  NO.**

```
DiagnoseRunEvidence → moduleOutputsQuery:
  SQL: SELECT module_run_id, created_at, length(full_report_markdown) AS report_length
       FROM module_outputs WHERE module_run_id = $1 LIMIT 1
  rowCount: 0
  rows: []
```

Additionally confirmed by:
- `ExportFindings` → artifactStatus: "incomplete", findings: [], totalCount: 0
- `LoadModuleResults` → latestOutput: null for omission_audit
- `GetRunOutput` → output: null

**Where the 9 findings come from:**

The 9 findings are stored in the `pipeline_checkpoints` table under
`checkpoint_key = 'finding_reduction_gate'` for this run. They were persisted there
at `2026-08-13 03:17:43.531793+00` as part of the `suppressedLedger` array within
the gate payload JSON.

These findings completed the merge phase (191 L1 merge checkpoint nodes, 6.5MB total)
and were consolidated into 9 findings. The finding_reduction_gate then evaluated all 9
and **suppressed every one** (primaryCount: 0, suppressedCount: 9).

The suppression reasons (per finding):
- `authoritative_source`: FAILED on all 9 — "Sources lack structured doc_class"
- `materiality`: FAILED on all 9 — "Info-severity findings are secondary observations only"
- `genuine_contradiction`: FAILED on 8/9 — "Informational observation — no contradiction"

After suppression left 0 primary findings, the pipeline proceeded to post-merge
finalization stages but ultimately failed (no canonical output produced).

**The "shipped report"** was NOT produced by a normal pipeline completion. It was
either: (a) generated via the `DiagnosticFinalization` API run manually against the
L1 merge checkpoints, or (b) the findings were extracted from the `finding_reduction_gate`
checkpoint's `suppressedLedger` for external review. No tree_level=0, 98, or 99
checkpoint exists — only tree_level=1 (191 nodes).

## 0.3 — absence_verification_checkpoints

**Confirmed: 0 rows.**

```
DiagnoseRunEvidence → absenceVerification:
  rowCount: 0
  rows: []
```

The absence verification phase was never reached because:
1. The finding_reduction_gate suppressed all 9 findings at 03:17:43
2. The pipeline's post-merge path proceeds through the reduction gate BEFORE
   absence verification
3. With 0 findings passing the gate, there was nothing to verify

Note: One finding (`b061d50c` — churn_rate_cohort_vs_group_level_discrepancy)
has `absence_confidence: "verified_absent"` — but this was set by the LLM during
L1 analysis, NOT by the absence verification phase. The phase never ran.
