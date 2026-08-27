---
name: B2 Double-Execution Race — Open on v1 Path
description: "Open defect: the B2 claim-token CAS on module_runs.owner_token is
  not deployed because the app's DB user lacks ALTER permission on module_runs.
  Applies when assessing concurrency safety of RunModulePipeline or planning
  infra/access changes."
accessType: on_demand
isEnabled: true
createdAt: 2026-08-27T02:34:33.723Z
---

## B2 Double-Execution Race — Still Live on v1

**Status:** OPEN — not blocked by application code, blocked by DB permissions.

### What happened

Migration 034 includes `ALTER TABLE module_runs ADD COLUMN IF NOT EXISTS owner_token UUID NULL`. This is the column the B2 concurrency fix (claim-token CAS) writes to in `RunModulePipeline`. The migration fails on this step because the app's Postgres user is **not the owner** of `module_runs` and lacks `ALTER` privilege.

The migration was patched to try/catch step 1 so the remaining steps (BSS v2 objects) could proceed. The `owner_token` column on `module_runs` remains **missing**.

### Impact

- **BSS v2 (BssRunPipeline):** Not affected — uses its own `owner_token` column on `bss_pipeline_state`, which the app owns and can ALTER.
- **All other modules (omission_audit, contradiction_check, external_risk_overlay, etc.):** Still served by v1 `RunModulePipeline`. The B2 double-execution race is **live** — concurrent invocations can both proceed because the CAS column doesn't exist.

### Resolution path

Requires an **infra/access change**, not application code:
- Option A: Grant the app's DB user `ALTER` privilege on `module_runs` (or make it the table owner), then re-run migration 034.
- Option B: Have a DB-owner-privileged user (Edris or whoever manages Superblocks DB grants) run `ALTER TABLE module_runs ADD COLUMN IF NOT EXISTS owner_token UUID NULL` directly.

Once the column exists, the B2 CAS in `RunModulePipeline` activates automatically — the code already writes to it.

### Discovered

2026-08-27 — Migration 034 first execution. Error: `must be owner of table module_runs`.
