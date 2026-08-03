# Known Limitations — MAT-F01

## In-Scope, Implemented

1. **CanonicalIcClaim schema** — complete with all required fields
2. **SHA-256 content-derived claim IDs** — deterministic, stable across runs
3. **Source validation** — verbatim substring match in normalized text
4. **Claim-first admission gate** — enforces all rejection reasons
5. **Qualitative claim support** — full qualitative proposition extraction
6. **Atomic split for quantitative** — same source text, different metric IDs
7. **Deduplication** — same content hash = same claim = one entry
8. **Terminal rejection records** — persisted with reason and timestamp

## Known Limitations

### L1: LLM Qualitative Extraction Not Wired Into Pipeline Orchestration

The qualitative extraction prompt (`QUALITATIVE_EXTRACTION_PROMPT`) is defined and tested via fixture data. It is NOT yet wired into the `runClaimsExtraction` function in `claims-extraction.ts` as a live LLM call. The existing `runClaimsExtraction` continues to produce quantitative claims. Integration requires:
- Adding a qualitative extraction pass to `runClaimsExtraction`
- Calling the `buildCanonicalLedgerFromExtractions` function with both outputs

This is intentional: the contract requires provable schema and admission logic, not full pipeline orchestration in this batch.

### L2: Source Validation Uses Whitespace-Normalized Match

The `validateClaimSource` function normalizes both claim text and source text (collapse whitespace to single space) before matching. This means a claim extracted with slightly different internal whitespace from the PDF parser will still validate. This is correct behavior for PDF-extracted text but means the validation is "whitespace-insensitive verbatim" rather than byte-exact.

### L3: Page Coordinate Validation is Presence-Only

The `coordinate_valid` check only verifies that `page_or_slide` is non-empty and `document_id` and `memo_version` are present. It does NOT verify that the page number is within the document's actual page count. This would require parsed-text page boundary metadata not currently available in the extraction pipeline.

### L4: Entity Derivation is Heuristic

The `deriveEntity` function extracts entity names from document names and scope qualifiers using simple pattern matching. It does not use NER or a canonical entity registry. For the SCG deal this is sufficient; for multi-entity deals it may need enhancement.

### L5: Existing claims-ledger-identity.ts Remains Active

The existing `claims-ledger-identity.ts` (FNV-1a-based) remains in use by the current pipeline for backward compatibility. The new `canonical-ic-claim.ts` (SHA-256-based) operates alongside it. Full migration requires updating `pipeline-core.ts` to use the canonical ledger, which is out of scope for this batch.

### L6: Admission Gate Not Yet Wired as Inline Pipeline Gate

The `admitCandidate` function is tested and proven to reject/admit correctly. It is NOT yet called inline within `pipeline-core.ts` at the candidate-admission boundary. Wiring it requires:
- Identifying the exact code point where candidates transition to substantive status
- Inserting the gate call with the loaded canonical ledger
- Routing rejected candidates to terminal storage

This integration is deferred to avoid destabilizing the pipeline in this batch.

## Explicit Non-Goals (Not Modified)

- Evidence routing
- Gamma vs SCG compatibility
- PwC/Legal DD/Altman authority rules
- Numeric claim-vs-model comparison
- Signed delta calculations
- Deterministic final verdict rules
- Materiality rules
- Canonical Q4 family construction
- Q5 evidence aggregation
- Report wording or styling
- LLM demotion outside claim extraction
- Finalizer/write/resume parity
- Full Saint precision and recall
