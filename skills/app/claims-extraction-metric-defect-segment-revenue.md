---
name: Claims Extraction Metric Defect — Segment Revenue
description: "Known claims extraction bug: segment-level revenue claims are
  tagged metric='other_financial' instead of 'revenue'. Applies when analyzing
  reconciliation metric mismatches or updating extraction prompts."
accessType: on_demand
isEnabled: true
createdAt: 2026-08-19T10:07:39.180Z
---

## Known Defect: Claims Extraction Tags Segment Revenue as `other_financial`

**Discovered:** Gate A / Item 1 investigation (Project Saint, deal c46b4129)

**Symptom:** Claims like `Revenue (segment: Surgery Connect)` carry `metric: "other_financial"` in the ledger, preventing exact-match reconciliation against reference_figures which correctly store `metric: "revenue"`.

**Root cause:** The extraction prompt's metric enum includes both `revenue` and `other_financial`. When the LLM encounters a segment-qualified revenue figure (e.g. "Surgery Connect | 10.3 | 15.4 | 22.2..."), it defaults to `other_financial` because the figure is nested within a segment breakdown rather than appearing as a top-level revenue line.

**Same defect applies to:** `Gross Profit (segment: X)` → incorrectly tagged `other_financial` instead of `gross_margin`.

**Workaround (active):** `diag-reconcile-only.ts` applies a deterministic metric derivation rule at Step 2c:
- `metric === 'other_financial'` AND scope matches `^Revenue (segment:` → rewrite to `revenue`
- `metric === 'other_financial'` AND scope matches `^Gross Profit (segment:` → rewrite to `gross_margin`

**Prompt fix for next extraction:** Add explicit guidance that segment-qualified revenue/GP figures retain their parent metric category (`revenue` or `gross_margin`), and `other_financial` is reserved for KPIs that do not fit any named metric bucket (NRR, churn rate, TAM, etc.).
