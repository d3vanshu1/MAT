# NOTCAPTURED: Full pipeline_analysis.result_json

## What was requested
The full `result_json` field (raw, unparsed) for each of 378 `pipeline_analysis` rows
for run `461db6c0-c8a7-4073-96d6-832ff506469b`.

## Why it cannot be captured

### 1. Schema limitation
The `pipeline_analysis` table for this run uses the **old schema** where data is stored in
a single `result_json` JSONB column. The column is NOT called `result_json` in the newer
schema — newer runs store `label`, `extraction`, `truncated` as individual columns.
For run 461db6c0, the storage is:
- `result_json JSONB` — contains keys: `label`, `extraction`, `truncated`, `documentTag`
- `model_used TEXT`
- `prompt_version TEXT`
- `chunk_index INT`
- `created_at TIMESTAMPTZ`
- `run_id UUID`

Columns that do NOT exist for this run (added later by analysis-worker.ts):
- `document_id` → must be inferred from routing order
- `chunk_hash`
- `work_identity`
- `content_identity`
- `result_hash`
- `fence_token`

### 2. Access limitation
The database integration (`ba09e2b9-2715-4460-8131-896f50b0c414`) is ONLY accessible
through pre-built diagnostic APIs executed via `testApi`. There is no direct SQL access.

### 3. Volume vs response size
- 378 rows × average 14,043 chars of extraction text = ~5.3 MB
- `testApi` response serialization truncates individual string fields at ~10K chars
- Capturing full extraction for all 378 rows would require 378+ sequential API calls
  (some rows >8K would require 2+ calls each)
- The orchestrator showed intermittent `NO_AGENT` failures during the session
- This makes full extraction dump impractical via this interface

### 4. What IS captured
See `manifest.json` — complete metadata for all 378 rows:
- `chunk_index` (0–377)
- `label` (filename + part number)
- `model_used` (all: "claude-sonnet-4-6")
- `prompt_version` (all: "aa38c05d832d")
- `truncated` (boolean — whether extraction was truncated by the model)
- `extraction_length` (char count of full extraction text)
- `created_at` (UTC timestamp)
- `document_id` (inferred from routing order, since not stored in table)

See `sample_extractions.json` — first 2 rows with ~8K chars of extraction each,
demonstrating the actual content structure.

### 5. Tables checked
| Table | Column | Available? | Notes |
|-------|--------|-----------|-------|
| `pipeline_analysis` | `result_json` | YES | Contains full extraction — but only accessible via diagnostic API with response truncation |
| `pipeline_analysis` | `document_id` | NO | Column does not exist for this run (old schema) |
| `pipeline_analysis` | `chunk_hash` | NO | Column does not exist for this run |
| `pipeline_analysis` | `work_identity` | NO | Column does not exist for this run |

### 6. How to access the full data
To get full extractions, one would need:
- Direct SQL access to the Supabase database
- Query: `SELECT chunk_index, result_json FROM pipeline_analysis WHERE run_id = '461db6c0-c8a7-4073-96d6-832ff506469b' ORDER BY chunk_index`
- Or: Modify DiagDumpAnalysisRows to write results to a file/blob store rather than returning via API response
