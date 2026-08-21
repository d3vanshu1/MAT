# CC run `bc6b519f` — pre-reduction-gate artifact `d8ca0a40`

**Status:** preserved 2026-08-21 03:47 ET, before any code change to the finalization path.

This is the **"before" half** of the pre-gate vs post-gate comparison for Project Saint's
Commercial Commentary (CC) module. It is the only complete merge-tree output that exists for
this run, and it is destroyed by the first successful finalization — `canonicalFinalize`
(`canonical-finalizer.ts` STEP 10) UPDATEs the existing `module_outputs` row in place rather
than inserting a new one.

---

## What this artifact is

| | |
|---|---|
| `module_outputs.id` | `d8ca0a40-84e6-4b9c-88eb-63056ca07de3` |
| `module_run_id` | `bc6b519f-9cf1-452c-88ba-c03547bd0469` (CC) |
| Deal | `c46b4129-8a16-48ae-ad3a-1da061255445` — Project Saint / SCG |
| Written | 2026-08-19 20:02:51 ET (`2026-08-20T00:02:51.888816Z`) |
| Pipeline version | `aa38c05d832d` |
| Findings | 25 |
| `reductionGatePayload` | `null` |

**Provenance:** produced by the **merge-tree path**. `reductionGatePayload` is `null`, which
means this output never faced the finding reduction gate, absence verification, or canonical
finalization. It is pre-gate by construction, not pre-gate by accident.

**Why it was still the live artifact on 2026-08-21:** the run had been in a restart loop since
19 Aug. `module_runs.status` read `running` while `completed_at` stayed frozen at 20:02 ET on
19 Aug, and the root manifest reached `completionGeneration: 169` — 169 convergences of the
merge tree, none of which ever reached finalization. `pipeline_analysis` was untouched across
the whole period (206 rows, all dated 19 Aug), so the loop was not re-running LLM analysis.

---

## Where the full payload lives

The complete payload is copied byte-for-byte into the `diag_consolidation_sessions` scratch
table:

```sql
SELECT state_json->'findings',
       state_json->>'fullReportMarkdown',
       state_json->>'executiveHeader',
       state_json->'checksums'
  FROM diag_consolidation_sessions
 WHERE id = 'artifact-backup-cc-bc6b519f-pregate-d8ca0a40'
   AND pass_number = 0;
```

Written by the `PreserveArtifactSnapshot` API
(`server/apis/pipeline/preserve-artifact-snapshot.ts`) as a DB-side `INSERT … SELECT`, so the
payload was never serialized through the API layer.

### Checksums — source vs snapshot, verified equal at write time

| Column | Size | md5 |
|---|---|---|
| `findings` (jsonb) | 51,059 bytes | `78d6111f8918ac507ba16970523a9dec` |
| `full_report_markdown` | 27,815 chars | `0b36390cf895f17a45bb2f5b68ee7fb5` |
| `executive_header` | 970 chars | `af5149a2f9f6daef7caa6c7582e044ef` |

All three matched exactly between source and snapshot. Re-verify at any time with the query
above against `md5()` of the source row — if the source md5s have changed, finalization has
run and the snapshot is now the only copy of the pre-gate state.

### Durability notes

The snapshot was placed in `diag_consolidation_sessions` deliberately:

- `purge-pipeline-checkpoints` deletes **all** `pipeline_checkpoints` rows for a deal, so that
  table is not a safe home for evidence.
- `purge-deal-pipeline-state` does sweep `diag_consolidation_sessions`, but only rows where
  `state_json->>'runId'` matches a deal run. The snapshot records the run as **`sourceRunId`**,
  with no top-level `runId` key, so deal purges will not select it.
- The insert is `ON CONFLICT (id, pass_number) DO NOTHING`. Re-running the preservation after
  finalization cannot overwrite the good snapshot with a later artifact.

---

## Executive header (verbatim, 970 chars)

> Project Saint faces four material risks requiring immediate resolution before IC approval.
> First, the FY2026 financial model has been revised downward (EBITDA −£1.8m to £54.3m;
> revenue −£2.7m to £184.4m), but the latest IC memo (2026-06-21) does not explicitly confirm
> it reflects these changes, creating ambiguity about whether debt serviceability projections
> and covenant analysis rest on current assumptions. Second, a £9.6m FY2026 revenue
> discrepancy between the 2nd IC Memo (£194m) and live model (£184.4m) remains
> unreconciled—scope basis unconfirmed. Third, customer concentration at 89% Diamond tier is
> documented but unmitigated; no contractual retention, lock-in, or diversification roadmap is
> provided. Fourth, interest coverage at 1.7x–1.8x is sub-standard and leaves minimal covenant
> headroom, particularly when combined with the recent EBITDA downward revision. Finance and
> commercial workstreams must resolve these before the IC can assess deal viability.

---

## Finding inventory (25)

`kind` / `sev` / `cat` are `finding_kind`, `severity`, `category`. `clm` is
`claim_ids` length. `nu` is `numeric_unverified`. `si` is whether `structured_impact` is
populated.

| # | sev | cat | kind | clm | nu | si | Title |
|---|---|---|---|---|---|---|---|
| 1 | warning | principal | source_stated_risk | 1 | – | ✓ | Customer Concentration 89% Diamond Tier—Unmitigated Revenue Risk |
| 2 | warning | principal | data_divergence | 1 | – | ✓ | FY2026 Revenue Figure Discrepancy: 2nd Memo £194m vs Live Model £184.4m—Scope Unreconciled |
| 3 | warning | principal | source_stated_risk | 0 | – | ✓ | Interest Coverage 1.7x–1.8x: Minimal Margin Against Execution Slippage |
| 4 | warning | principal | data_divergence | 4 | – | ✓ | FY2026 Model Revenue & EBITDA Revised Downward Post-Memo |
| 5 | info | principal | data_divergence | 2 | – | ✓ | FY2026 Model Figures Revised: £2.7m Revenue, £1.8m EBITDA vs. Frozen Snapshot |
| 6 | info | housekeeping | data_divergence | 1 | – | – | Historical GP CAGR Stated as ~10% vs. Verified 14.3% |
| 7 | info | housekeeping | data_divergence | 0 | – | – | Adjusted EBITDA FY25 (£49.9m) reconciles to model figure; QoE restatement immaterial |
| 8 | info | housekeeping | data_divergence | 6 | – | – | M&A strategy and integration playbook documented and internally consistent |
| 9 | warning | principal | data_divergence | 1 | – | ✓ | FY25 Revenue Scope Qualifier Ambiguity — Vendor FDD vs. Model Definition |
| 10 | info | housekeeping | data_divergence | 2 | – | – | Organic growth narrative detail supported; historical volatility explained |
| 11 | info | principal | data_divergence | 1 | ✓ | – | Organic ARR Growth Rate 10.0% FY25: Narrative Anchor Verified |
| 12 | info | principal | data_divergence | 1 | ✓ | – | Hosted Segment Growth Rate: FY23-FY25 vs Forecast Consistency |
| 13 | info | housekeeping | data_divergence | 0 | ✓ | – | Capex Forecast Predicated on 'Lower than Historical' — Baseline Not Cited |
| 14 | info | housekeeping | data_divergence | 0 | ✓ | ✓ | Cost of Sales Positive Variance Supports Gross-Margin Upside |
| 15 | info | principal | data_divergence | 0 | ✓ | – | Hosted Revenue Growth '~17% p.a.' — Projection Lacks Model Attestation |
| 16 | info | housekeeping | data_divergence | 0 | ✓ | – | Synergy quantification for Targets 1 & 2 — narrative claim, no model trace |
| 17 | info | housekeeping | data_divergence | 1 | – | – | Direct Cost Modelling — Revenue-Proportion Basis Documented |
| 18 | info | housekeeping | data_divergence | 1 | ✓ | – | IT, Cloud & Security Growth Upside — Modelled Conservatively vs Actuals |
| 19 | info | housekeeping | data_divergence | 1 | ✓ | – | Plan ARPU Methodology — Consistency with Historical Approach Verified |
| 20 | info | housekeeping | data_divergence | 1 | – | ✓ | SIP Calls Revenue Decline — Forecast -6.7% CAGR FY25–28 |
| 21 | info | housekeeping | data_divergence | 1 | ✓ | – | Historical vs Plan Comparability — Acquisition Impact on FY23–25 CAGR |
| 22 | info | housekeeping | data_divergence | 0 | – | – | Historical–forecast CAGR comparison suppressed; Plan excludes acquisitions, history includes |
| 23 | info | housekeeping | data_divergence | 6 | – | – | Capitalised Development Costs: Methodology Accepted by Group Auditors |
| 24 | warning | principal | data_divergence | 0 | – | – | Total Group Revenue (FY Mar-26): memo higher than model by £9.6m (5.2%) |
| 25 | warning | principal | cross_version | 0 | – | – | Forecast vs realised actual: 2026 — 8 material movements |

Findings 17–21 carry `gap_type: open_item_acknowledged`. All others have `gap_type: null`.

### Composition

- **`finding_kind`**: 22 × `data_divergence`, 2 × `source_stated_risk`, 1 × `cross_version`.
- **`severity`**: 7 × `warning`, 18 × `info`.
- **`category`**: 11 × `principal_finding`, 14 × `housekeeping`.
- **The revision family** — the FY2026 downward-revision cluster and its restatements of the
  same £9.6m / £2.7m / £1.8m deltas: **#2, #4, #5, #9, #11, #12, #15, #24** plus the
  cross-version restatement **#25**. Nine findings expressing one underlying movement. This
  cluster is the reduction gate's primary target; whether it survives as nine or collapses is
  the first measurement to take after finalization.
- **Agreement assertions** — findings tagged `data_divergence` whose text asserts that the
  sources *agree* or that a figure *reconciles*: **#7, #8, #10, #11, #12, #13, #14, #16, #17,
  #18, #19, #20, #21, #22, #23**, plus **#6** and **#5** in their reconciling halves.
  Seventeen of the 25 assert agreement while carrying a divergence kind. This is the
  kind-consistency mismatch the gate's guard is expected to fire on.

### Finding object keys

Every finding carries the same key set:

```
absence_confidence, category, claim_ids, detail, evidence, finding_id, finding_kind,
full_analysis, gap_type, independent, issue_key, materiality_rationale,
merged_from_finding_ids, numeric_unverified, severity, severity_anchor, source_docs,
structured_impact, title
```

---

## What to compare after finalization

1. **Per-gate pass/fail counts** across these 25 findings.
2. **Whether the nine revision-family findings survive** the gate, and if not, what they
   collapse into.
3. **Whether the kind-consistency guard fires** on the seventeen agreement assertions carrying
   `finding_kind: data_divergence`.
