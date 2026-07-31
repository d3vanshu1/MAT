---
name: IC Diligence Assistant — Stabilization Batch Implementation Plan
description: Detailed implementation plan for 6-commit architectural refactoring of the pipeline. Covers durable analysis workers, parallel orchestration, canonical-group synthesis, finalization artifacts, module_outputs diagnostics, and integration-only diagnostic endpoint.
accessType: on_demand
isEnabled: true
createdAt: 2026-07-31T18:15:00.000Z
---

# Stabilization Batch — Detailed Implementation Plan

## Current Architecture (As-Is)

```
RunModulePipeline API (300s cap)
  │
  ├── Step 0.4: clean-parsed-text     ─┐
  ├── Step 0.6: doc-tables-phase       │  Sequential pre-analysis
  ├── Step 0.7: numeric-verify-inline  │  (checkpoint per phase)
  ├── Step 0.8: claims-extraction      ─┘
  │
  ├── Step 1: Load extractions (paginated)
  ├── Step 2: Analysis loop (in-process, ANALYSIS_CONCURRENCY=15)
  │     └── Batch → callAnthropic → save pipeline_analysis row
  │
  ├── Step 3: Load analysis results (paginated)
  ├── Step 4: Tree-reduce merge (MERGE_GROUP_SIZE=4, MERGE_CONCURRENCY=5)
  │     └── Round-by-round with budget gates + checkpoint per group
  │
  ├── Step 5: Absence verification
  ├── Step 6: Quality/numeric pass
  ├── Step 7: Format report
  └── Step 8: Save module_outputs + mark completed
```

**Key constraints:**
- `EFFECTIVE_CAP_MS = 300_000` (hard platform kill at 300s)
- `TIME_BUDGET_MS = 200_000` (graceful exit target)
- Single invocation does ALL phases sequentially within budget
- `pipeline_analysis` table: one row per (run_id, chunk_index)
- `merge_checkpoints` table: one row per (module_run_id, tree_level, node_index)
- `pipeline_checkpoints` table: one row per (run_id, checkpoint_key, generation_id)
- Integration IDs: Postgres = `ba09e2b9-2715-4460-8131-896f50b0c414`, Anthropic = `8ccd43c8-5340-4ae2-8eee-7cbb3896df53`

---

## Commit 1: Durable Bounded Analysis Workers

### Design

**New table: `analysis_work_items`**

```sql
CREATE TABLE IF NOT EXISTS analysis_work_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL,
  chunk_index     INT NOT NULL,
  chunk_hash      TEXT NOT NULL,       -- content_hash from universal_extractions
  analysis_version TEXT NOT NULL,       -- prompt version (pipeline-version.ts)
  
  -- Claim/lease state
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','claimed','complete','failed_retryable','failed_permanent')),
  claim_owner     TEXT,                 -- invocation_id of claiming worker
  claimed_at      TIMESTAMPTZ,
  lease_expires   TIMESTAMPTZ,
  attempt_count   INT NOT NULL DEFAULT 0,
  
  -- Result
  result_json     JSONB,               -- analysis output (same shape as pipeline_analysis.result_json)
  completed_at    TIMESTAMPTZ,
  error_message   TEXT,
  
  -- Constraints
  UNIQUE (run_id, chunk_index)
);

CREATE INDEX idx_awi_pending ON analysis_work_items (run_id, status) WHERE status IN ('pending','failed_retryable');
CREATE INDEX idx_awi_expired ON analysis_work_items (lease_expires) WHERE status = 'claimed';
```

**Work item lifecycle:**
```
pending → claimed (atomic SELECT FOR UPDATE SKIP LOCKED)
claimed → complete (result persisted)
claimed → failed_retryable (attempt_count < MAX_ATTEMPTS)
claimed → failed_permanent (attempt_count >= MAX_ATTEMPTS)
claimed → pending (lease expired, recovered by sweeper)
```

**New file: `server/apis/pipeline/analysis-worker.ts`**

```typescript
// Core interface
interface AnalysisWorkerConfig {
  batchSize: number;           // 5-10 chunks per invocation
  leaseTimeoutMs: number;      // 240_000 (4 min — must be < platform cap)
  maxAttempts: number;         // 3
  analysisVersion: string;     // from pipeline-version.ts
}

// Atomic claim (Postgres advisory lock + SKIP LOCKED)
async function claimBatch(ctx, runId, config): Promise<WorkItem[]>

// Process a single claimed chunk
async function processChunk(ctx, item, config): Promise<void>

// Persist result immediately
async function completeItem(ctx, item, result): Promise<void>

// Mark failure (retryable or permanent based on attempt_count)
async function failItem(ctx, item, error): Promise<void>

// Recover expired leases
async function recoverExpiredLeases(ctx, runId): Promise<number>

// Get durable progress counts
async function getAnalysisCounts(ctx, runId): Promise<AnalysisCounts>
```

**How analysis_work_items are populated:**
- During Step 1 (load extractions), after routing, the pipeline populates `analysis_work_items` with one row per routed chunk (if not already populated for this run_id).
- Uses `INSERT ... ON CONFLICT (run_id, chunk_index) DO NOTHING` to be idempotent.
- Only inserts for chunks where no matching `pipeline_analysis` row exists with matching analysis_version.

**Backward compatibility:**
- Existing `pipeline_analysis` table remains the source of truth for "analysis is complete for chunk X"
- `analysis_work_items` is the coordination mechanism
- When a work item completes, it writes to BOTH `analysis_work_items.result_json` AND `pipeline_analysis`
- The merge phase continues reading from `pipeline_analysis` (no change)

**Migration from current inline analysis:**
- The current analysis loop in `pipeline-core.ts` (lines 3792-3900) becomes a worker invocation
- Instead of inline `callAnthropic`, it calls `claimBatch` + `processChunk` for each

**Tests (file: `__tests__/analysis-worker.test.ts`):**
1. Two workers cannot claim the same chunk → verify via concurrent claimBatch calls
2. Expired leases are recovered → set lease_expires in past, call recoverExpiredLeases
3. Completed chunks are not recomputed → verify claimBatch skips 'complete' items
4. Partial batch completion survives a worker failure → fail 3/5, verify other 2 remain complete
5. Repeated short invocations monotonically reduce pending chunks → simulate 5 invocations
6. A run with 381 chunks begins analysis without waiting for claims → verify analysis_work_items populated before claims phase completes

---

## Commit 2: Parallel Phase Orchestration

### Design

**New file: `server/apis/pipeline/phase-orchestrator.ts`**

Replace the monolithic sequential execution with a coordinator that:
1. Loads phase states from a new `phase_progress` table
2. Dispatches bounded work for ALL eligible phases
3. Records durable progress
4. Returns quickly (under 30s ideally, max budget)

**New table: `phase_progress`**

```sql
CREATE TABLE IF NOT EXISTS phase_progress (
  run_id          UUID NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
  phase_id        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','complete','degraded')),
  durable_counter INT NOT NULL DEFAULT 0,
  total_items     INT,
  last_progress_at TIMESTAMPTZ,
  degraded_reason TEXT,
  metadata        JSONB DEFAULT '{}',
  PRIMARY KEY (run_id, phase_id)
);
```

**Phase dependency graph:**
```
extraction (existing — prerequisite for all)
    │
    ├── doc_tables       (independent)
    ├── numeric_verify   (independent)
    ├── claims           (independent)
    └── analysis         (independent, bounded worker)
         │
         └── merge (requires analysis.status = 'complete')
              │
              └── finalization (requires merge + claims + numeric)
```

**Orchestration loop per invocation:**
```typescript
async function orchestrate(ctx, runId, startTime): Promise<PipelineResult> {
  const phases = await loadPhaseStates(ctx, runId);
  const invocationId = randomUUID();
  const counters_before = snapshot(phases);
  
  // Parallel dispatch — each phase gets a bounded time slice
  const phaseSliceMs = Math.floor((EFFECTIVE_CAP_MS - 60_000) / activePhaseCount);
  
  await Promise.allSettled([
    phases.doc_tables.status !== 'complete' && runDocTables(ctx, runId, phaseSliceMs),
    phases.numeric.status !== 'complete' && runNumericVerify(ctx, runId, phaseSliceMs),
    phases.claims.status !== 'complete' && runClaims(ctx, runId, phaseSliceMs),
    phases.analysis.status !== 'complete' && runAnalysisBatch(ctx, runId, phaseSliceMs),
  ].filter(Boolean));
  
  // Post-analysis: merge only if analysis complete
  if (phases.analysis.status === 'complete' && phases.merge.status !== 'complete') {
    await runMergeBatch(ctx, runId, remainingBudget());
  }
  
  // Finalization gate
  if (allPrerequisitesReady(phases)) {
    return await finalize(ctx, runId);
  }
  
  // No-progress detection
  const counters_after = snapshot(phases);
  await persistInvocationTrace(ctx, { invocationId, counters_before, counters_after, ... });
  if (isNoProgress(counters_before, counters_after)) {
    emit("PIPELINE_NO_PROGRESS", { phase: identifyBlockingPhase(phases), reason: "..." });
  }
  
  return { status: "in_progress", ... };
}
```

**Key design decisions:**
- Each phase function is self-contained and takes a time budget
- Phases use their own checkpoint mechanisms (existing tables)
- The orchestrator does NOT try to do all work — it dispatches a bounded amount
- `Promise.allSettled` ensures one phase failure doesn't block others
- Platform's 5-min stale sweeper continues to re-invoke if a worker dies

**Invocation trace table: `invocation_traces`**
```sql
CREATE TABLE IF NOT EXISTS invocation_traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL,
  invocation_id   TEXT NOT NULL,
  phase_before    JSONB NOT NULL,
  phase_after     JSONB NOT NULL,
  durable_delta   JSONB NOT NULL,
  reason_for_return TEXT NOT NULL,
  elapsed_ms      INT NOT NULL,
  remaining_budget_ms INT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_it_run ON invocation_traces (run_id, created_at DESC);
```

**Tests (file: `__tests__/phase-orchestrator.test.ts`):**
1. Analysis advances while claims remain pending
2. Numeric verification advances while analysis remains pending
3. Claims failure (degraded) does not prevent analysis work
4. Finalization waits for ALL required phases
5. Completed phases are not repeated
6. Zero-progress loop identifies exact phase and reason

---

## Commit 3: Replace Recursive Free-Text Merge with Bounded Canonical-Group Synthesis

### Design

This is the biggest architectural change. Instead of a tree-reduce merge that feeds entire narratives into progressively larger LLM calls, we:

1. **Parse chunk outputs into structured findings immediately** (already done — `parseCanonicalFindings`)
2. **Group findings deterministically by structured identity** (new)
3. **Synthesize only genuine duplicate groups** (new)
4. **Singleton groups pass through without LLM** (new)

**New file: `server/apis/pipeline/finding-grouper.ts`**

```typescript
interface GroupingKey {
  finding_kind: string;      // "data_divergence" | "absence_claim" | ...
  issue_key: string;         // semantic cluster key
  metric?: string;           // quantitative metric
  period?: string;           // time period
  scope?: string;            // entity/segment scope
  entity?: string;           // legal entity
  source_document?: string;  // primary source doc
  sheet_or_page?: string;    // sheet/page coordinates
  cell_coordinate?: string;  // cell reference
  legal_clause?: string;     // legal section
  legal_consequence?: string;
  accounting_basis?: string;
  actual_or_forecast?: string;
}

// Deterministic grouping
function groupFindings(findings: CanonicalFinding[]): Map<string, CanonicalFinding[]>
  // 1. Extract GroupingKey from each finding
  // 2. Hash the key deterministically (sorted JSON → SHA-256 prefix)
  // 3. Findings with identical keys go in the same group
  // 4. Findings with no issue_key get a singleton group

// Partition large groups
function partitionGroup(group: CanonicalFinding[], maxSize: number): CanonicalFinding[][]
  // Deterministic split: sort by finding_id, chunk into maxSize
```

**New file: `server/apis/pipeline/group-synthesis.ts`**

```typescript
interface SynthesisJob {
  groupKey: string;
  findings: CanonicalFinding[];  // max 5-8 per job
  moduleId: string;
}

interface SynthesisResult {
  representative: CanonicalFinding;  // merged output
  merged_from_finding_ids: string[]; // all input IDs
  status: 'complete' | 'degraded_fallback';
}

// Bounded synthesis — one LLM call per group
async function synthesizeGroup(ctx, job: SynthesisJob): Promise<SynthesisResult>
  // Prompt: "These N findings describe the same issue. Synthesize into one representative."
  // Input: structured finding JSON (NOT free-text narrative)
  // Output: one CanonicalFinding with merged_from_finding_ids
  // Token limit: much smaller than current merge (input is structured, not narrative)

// Truncation handling
async function handleTruncation(ctx, job, partialResult): Promise<SynthesisResult>
  // 1. Persist partial as diagnostic
  // 2. Split job into smaller sub-groups
  // 3. Retry with sub-groups
  // 4. If sub-group also truncates → carry originals forward with degraded_fallback
```

**New table: `synthesis_checkpoints`**

```sql
CREATE TABLE IF NOT EXISTS synthesis_checkpoints (
  run_id          UUID NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
  group_key       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','complete','degraded_fallback')),
  input_finding_ids TEXT[] NOT NULL,
  output_finding  JSONB,
  truncation_count INT DEFAULT 0,
  input_fingerprint TEXT NOT NULL,  -- hash of input finding IDs + versions
  prompt_version  TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (run_id, group_key)
);
```

**Truncation handling (per spec):**
- First truncation: persist partial, reduce group size (split), retry
- Second truncation on smaller group: carry originals forward as `degraded_fallback`
- `truncation_count` is tied to `input_fingerprint + prompt_version + group_key`
- If inputs change, counter resets

**Feature flag: `USE_CANONICAL_GROUP_SYNTHESIS`**
```typescript
// In pipeline-config.ts
export const USE_CANONICAL_GROUP_SYNTHESIS = true;  // new path
export const LEGACY_TREE_MERGE_ENABLED = true;      // keep for comparison (temporary)
```

**How it replaces the tree merge:**
```
BEFORE (tree-reduce):
  380 analysis texts → group by 4 → 95 merge calls
  95 merged texts → group by 4 → 24 merge calls
  24 → 6 → 2 → 1  (5 rounds, ~130 LLM calls total)

AFTER (canonical-group synthesis):
  380 chunks → parse into ~800-1200 structured findings
  Group by identity → ~50-200 groups (most singletons)
  Singletons: pass through (0 LLM calls)
  Duplicate groups (e.g. ~30-60 groups): 1 synthesis call each
  Large groups (>8): partition → 2-3 calls each
  Total: ~30-80 LLM calls (vs 130), each bounded
```

**Tests (file: `__tests__/canonical-group-synthesis.test.ts`):**
1. 381 chunk outputs do not generate a recursive merge tree
2. Singleton findings bypass LLM
3. Duplicate families create bounded synthesis jobs
4. Oversized groups (>8) partition deterministically
5. No synthesis prompt exceeds configured token limits
6. Truncation causes smaller work units, not identical retries
7. Repeated truncation carries originals forward
8. Partial output never becomes indistinguishable from complete output (status field)
9. Every input finding_id remains accounted for
10. Forced-resume and uninterrupted runs preserve identical canonical finding membership

---

## Commit 4: Durable Finalization Artifact

### Design

**Storage: `pipeline_checkpoints` table (existing)**

The finalization artifact uses the existing `pipeline_checkpoints` table with `checkpoint_key = 'finalization_artifact'`:

```sql
-- Stored in pipeline_checkpoints.payload (JSONB):
{
  "run_id": "...",
  "generation_id": "...",
  "canonical_findings": [...],
  "full_report": "...",
  "findings_fingerprint": "sha256:...",
  "report_fingerprint": "sha256:...",
  "finding_count": 42,
  "findings_byte_length": 128456,
  "report_byte_length": 34567,
  "largest_finding_byte_length": 4200,
  "created_at": "2026-07-31T18:00:00Z",
  "schema_version": 2,
  "source_snapshot_fingerprint": "sha256:..."
}
```

**New file: `server/apis/pipeline/finalization-artifact.ts`**

```typescript
interface FinalizationArtifact {
  run_id: string;
  generation_id: string;
  canonical_findings: CanonicalFinding[];
  full_report: string;
  findings_fingerprint: string;
  report_fingerprint: string;
  finding_count: number;
  findings_byte_length: number;
  report_byte_length: number;
  largest_finding_byte_length: number;
  created_at: string;
  schema_version: number;
  source_snapshot_fingerprint: string;
}

// Persist artifact before attempting module_outputs save
async function persistArtifact(ctx, artifact): Promise<void>

// Load artifact on resume
async function loadArtifact(ctx, runId): Promise<FinalizationArtifact | null>

// Validate artifact matches current run state
function validateArtifact(artifact, currentGenerationId, currentSourceFingerprint): boolean

// Compute fingerprints deterministically
function computeFindingsFingerprint(findings: CanonicalFinding[]): string
function computeReportFingerprint(report: string): string
```

**Resume behavior:**
```typescript
// In the finalization path:
const existingArtifact = await loadArtifact(ctx, runId);
if (existingArtifact && validateArtifact(existingArtifact, generationId, sourceFingerprint)) {
  // Skip extraction, analysis, merge, formatting — go directly to persistence
  return await persistModuleOutput(ctx, existingArtifact);
}
// Otherwise: run normally and persist artifact before saving
```

**Tests (file: `__tests__/finalization-artifact.test.ts`):**
1. Failed module_outputs persistence does not rerun analysis
2. Resume loads same finalization fingerprints
3. Changed generation_id invalidates artifact
4. Changed source_snapshot invalidates artifact
5. Formatting is not repeated during persistence retries

---

## Commit 5: Stage-Specific module_outputs Diagnostics & Recovery

### Design

**New file: `server/apis/pipeline/persist-module-output.ts`**

Replaces the inline 2-attempt save loop (current lines 5015-5053) with an explicit stage pipeline:

```typescript
enum PersistStage {
  canonical_validation = "canonical_validation",
  ensure_schema_columns = "ensure_schema_columns",
  lookup_existing_output = "lookup_existing_output",
  insert_output = "insert_output",
  update_output = "update_output",
  verify_persisted_output = "verify_persisted_output",
  bump_deal_updated_at = "bump_deal_updated_at",
}

interface StageResult {
  stage: PersistStage;
  success: boolean;
  elapsed_ms: number;
  attempt: number;
  error_code?: string;
  error_message?: string;
  nested_cause?: string;
  finding_count?: number;
  findings_byte_length?: number;
  report_byte_length?: number;
  largest_finding_byte_length?: number;
}

// Main entry point
async function persistModuleOutputStaged(ctx, artifact: FinalizationArtifact): Promise<PersistResult>
```

**Stage details:**

| Stage | Operation | Failure classification |
|-------|-----------|----------------------|
| `canonical_validation` | Validate findings against CanonicalFindingSchema | Non-retryable |
| `ensure_schema_columns` | Verify module_outputs table has required columns | Non-retryable |
| `lookup_existing_output` | Check for existing row by module_run_id | Retryable (timeout) |
| `insert_output` | INSERT if no existing | Retryable (timeout/deadlock) |
| `update_output` | UPDATE if existing | Retryable (timeout/deadlock) |
| `verify_persisted_output` | Read-back + fingerprint comparison | Retryable (timeout) |
| `bump_deal_updated_at` | UPDATE deals SET updated_at = now() | Retryable (separate) |

**Read-back verification:**
```typescript
async function verifyPersistedOutput(ctx, runId, artifact): Promise<boolean> {
  const persisted = await readBackOutput(ctx, runId);
  return (
    persisted.generation_id === artifact.generation_id &&
    persisted.finding_count === artifact.finding_count &&
    persisted.findings_fingerprint === artifact.findings_fingerprint &&
    persisted.report_fingerprint === artifact.report_fingerprint
  );
}
```

**Ancillary writes separated:**
- `bump_deal_updated_at` is a separate stage AFTER canonical persistence is verified
- A failure in `bump_deal_updated_at` does NOT roll back the output save
- It logs the failure and continues

**Retry classification:**
```typescript
function classifyError(error: unknown): 'retryable' | 'non_retryable' {
  const msg = String(error);
  if (/timeout|ECONNRESET|pool exhausted|deadlock|temporary/i.test(msg)) return 'retryable';
  if (/validation|malformed|permission|schema|not null/i.test(msg)) return 'non_retryable';
  return 'retryable'; // default to retryable for unknown errors
}
```

**Tests (file: `__tests__/persist-module-output.test.ts`):**
1. Canonical validation failure identifies stage, not retried
2. Insert timeout records payload sizes
3. Write succeeds but deal timestamp fails → output still accepted
4. Existing matching output verified and reused
5. Two finalizers cannot produce divergent outputs (upsert by module_run_id)
6. Save retry does not rerun formatting/analysis
7. Fingerprints match finalization artifact
8. Mismatched read-back prevents completion
9. Verified read-back permits completion
10. Integration error details preserved in StageResult

---

## Commit 6: Integration-Only Diagnostic Endpoint

### Design

**New API: `server/apis/pipeline/diag-run-health.ts`**

Single comprehensive diagnostic endpoint using existing Postgres integration:

```typescript
interface RunHealthReport {
  // Run metadata
  run_status: string;
  current_phase: string;
  last_heartbeat: string;
  last_durable_progress_at: string;
  source_snapshot_fingerprint: string;
  
  // Analysis counts (from analysis_work_items or pipeline_analysis)
  analysis: {
    total: number;
    pending: number;
    claimed: number;
    complete: number;
    failed_retryable: number;
    failed_permanent: number;
  };
  
  // Claims
  claims: {
    total: number;
    pending: number;
    complete: number;
    failed: number;
  };
  
  // Numeric
  numeric_status: string;
  
  // Reconciliation
  reconciliation_status: string;
  
  // Merge/synthesis groups
  merge_groups: {
    total: number;
    complete: number;
    partial_degraded: number;
    pending: number;
  };
  
  // Finalization
  finalization_artifact_present: boolean;
  
  // module_outputs
  output: {
    present: boolean;
    output_id?: string;
    generation_id?: string;
    finding_count?: number;
    report_length?: number;
    findings_fingerprint?: string;
    report_fingerprint?: string;
    last_persistence_stage?: string;
    last_persistence_error?: string;
  };
  
  // Recent invocation traces (last 10)
  recent_invocations: Array<{
    invocation_id: string;
    elapsed_ms: number;
    remaining_budget_ms: number;
    phase_before: Record<string, number>;
    phase_after: Record<string, number>;
    reason_for_return: string;
    timestamp: string;
  }>;
}
```

**Does NOT expose:** report text, finding content, claim text, or any confidential narrative.

**UI integration:**
The DealDashboard should display real phase progress from this endpoint:
```
Analysis: 134 / 381 complete
Claims: 22 / 40 complete
Numeric tables: 88 / 120 complete
Merge groups: 18 / 26 complete
Finalization: artifact ready, persistence pending
```

---

## Operational Behavior

### Immediate continuation
- After each bounded batch completes successfully within budget, the orchestrator immediately starts the next phase's work (no 5-min wait)
- The 5-minute heartbeat / ResumeStalePipelines sweeper is fallback recovery only
- The UI poll loop (`setInterval`) re-invokes on every `in_progress` return

### Feature flags

| Flag | Default | Purpose |
|------|---------|---------|
| `USE_CANONICAL_GROUP_SYNTHESIS` | `true` | New synthesis path |
| `LEGACY_TREE_MERGE_ENABLED` | `true` | Keep old path for comparison |
| `PARALLEL_ORCHESTRATION_ENABLED` | `true` | New orchestrator |
| `ANALYSIS_WORKER_BATCH_SIZE` | `8` | Chunks per worker invocation |
| `SYNTHESIS_MAX_GROUP_SIZE` | `6` | Max findings per synthesis job |

---

## Migration Strategy

### Database migrations (all via `run-migration-015.ts`)
1. `analysis_work_items` table
2. `phase_progress` table
3. `invocation_traces` table
4. `synthesis_checkpoints` table
5. Columns on existing tables: `module_outputs.findings_fingerprint`, `module_outputs.report_fingerprint`, `module_outputs.generation_id`

### Backward compatibility
- Existing `pipeline_analysis` table remains source of truth
- Existing `merge_checkpoints` table retained for legacy merge path
- Feature flag controls which path is used
- The SCG run (currently in progress) completes on the OLD path — it has 380 analysis checkpoints and active merge tree state

### Rollback plan
- All new tables are additive (no destructive schema changes)
- Feature flags allow instant revert to legacy path
- Legacy merge code retained behind `LEGACY_TREE_MERGE_ENABLED`

---

## Delivery Artifacts Per Commit

Each commit will provide:
1. **Exact parent SHA** (from `git log`)
2. **New SHA** (after commit + push)
3. **Files changed** (list)
4. **Migrations** (SQL in run-migration-015.ts or embedded)
5. **Tests** (file path + test output summary)
6. **Typecheck/build output** (`build_debug` result)
7. **Before/after execution trace** (via DiagMergeStall or DiagRunHealth)
8. **Feature flags** (any new flags)
9. **Known limitations** (documented)

---

## Synthetic Benchmark (381-chunk run)

| Metric | Before (current) | After (projected) |
|--------|-------------------|-------------------|
| Time until first analysis checkpoint | 40-80s (waits for claims budget gate) | <5s (parallel orchestration) |
| Analysis throughput | 15 chunks/invocation → ~26 invocations | 8 chunks/worker → ~48 workers but parallel |
| Orchestration invocations | ~50-80 (sequential budget splits) | ~15-25 (parallel, bounded work each) |
| Merge LLM calls | ~130 (5-round tree) | ~30-80 (canonical groups, singletons free) |
| Truncations | 5-10 (round 2+ overflow) | 0-2 (bounded synthesis inputs) |
| Repeated completed phases | 3-5 per invocation (re-checks) | 0 (durable phase_progress) |
| Artifact → verified persistence | N/A (no artifact) | <10s (retry-only on resume) |

---

## Non-Goals (Confirmed)

- Materiality policy unchanged
- Numeric matching rules unchanged
- Reconciliation semantics unchanged
- Consolidation compatibility rules unchanged
- Source authority unchanged
- Canonical finding schema unchanged (FINDING_SCHEMA_VERSION=2)
- Final report format unchanged
- Claim IDs unchanged

---

## Open Questions for Review

1. **analysis_work_items vs existing pipeline_analysis:** Should we replace `pipeline_analysis` entirely, or keep both tables during transition? Plan above keeps both (dual-write).

2. **Phase time slicing:** With 4 parallel phases and 300s budget, each gets ~60s. Is this sufficient for a meaningful batch? Alternative: round-robin phases across invocations.

3. **Synthesis group size:** Spec says 5-8. Current findings tend to be 200-500 chars each in structured JSON. At 6 findings × 500 chars + prompt overhead ≈ 6KB input. Well within limits. Start at 6?

4. **Legacy tree-merge retention:** How long to keep behind feature flag? Suggested: 2 production-verified runs, then remove.

5. **SCG active run:** The current run (33a88bb1) is mid-merge on the old path. Should we let it complete before deploying Commit 3? Or does the feature flag protect it?
