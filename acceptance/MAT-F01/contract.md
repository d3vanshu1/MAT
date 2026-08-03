# MAT-F01: Mandatory Exact IC Claim Ledger and Claim-First Admission

## Contract Summary

Every substantive MAT candidate must originate from one exact, source-validated assertion in an IC memo.

## Schema Version

`ic-claim-v1`

## Required Production Contract

The `CanonicalIcClaim` record is defined in `server/apis/pipeline/canonical-ic-claim.ts` with:

- `schema_version`: `"ic-claim-v1"`
- `claim_id`: SHA-256 content-derived deterministic ID
- `source`: document_id, document_name, memo_version, page_or_slide, section, source_start, source_end
- `exact_claim_text`: verbatim source quotation
- `claim_type`: `"quantitative" | "qualitative"`
- `target`: entity, segment
- `proposition`: metric, qualitative_proposition, period, scope, unit, currency, scale, actual_forecast_status, accounting_basis, stated_value
- `source_validation`: exact_text_found, coordinate_valid, validation_method
- `extraction`: extractor_version, extracted_at

## Claim ID Algorithm

SHA-256 content hash over:
- schema version
- document ID
- memo version
- page/slide coordinate
- claim type
- exact claim text (normalized: lowercase, collapsed whitespace, trimmed)

Format: `ic-v1-{first 32 hex chars of SHA-256}`

## Candidate Admission Gate

At the first substantive candidate-admission boundary:
1. Requires a persisted valid `claim_id`
2. Resolves that ID to exactly one canonical IC claim
3. Rejects ambiguous references (multiple claim IDs)
4. Rejects topic-only linkage (no claim_id)
5. Rejects missing claims (claim_id not in ledger)
6. Rejects claims that failed exact-source validation

## Terminal Rejection Reasons

- `missing_ic_claim`
- `ambiguous_ic_claim`
- `invalid_claim_coordinate`
- `claim_text_not_found`
- `topic_only_linkage`
- `claim_reference_not_resolved`

## Atomicity Rule

When a single source sentence contains multiple distinct metric claims (e.g., "£194m revenue and £57m cash EBITDA"), the system MAY split into atomic claims. Each atomic claim:
- Preserves the SAME `exact_claim_text` (full source sentence)
- Preserves the SAME `source` coordinate (page/slide)
- Receives a DIFFERENT `claim_id` (because the identity payload differs on metric/scope)

## Frozen Acceptance Assertions

1. Exact quantitative claim: `SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26`
2. Exact qualitative claim: deleveraging depends on future M&A
3. No claimless substantive candidate
4. Ambiguous or paraphrased linkage fails closed
5. Stable identity across fresh and resume
