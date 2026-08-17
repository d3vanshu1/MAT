# F3 — Tree Geometry Predictions for Contradiction Detection

## Date: 2026-08-17
## Deal: Project Saint (c46b4129-8a16-48ae-ad3a-1da061255445)

## Tree Parameters
- MERGE_GROUP_SIZE: 2 (binary tree)
- Total chunks entering CC merge tree: 381
- Total merge rounds to root: 9 (ceil(log2(381)))
- MERGE_NODE_TEXT_CAP: 2000 chars per node
- Model: Haiku (claude-haiku-4-5-20251001), max_tokens: 15000

## Document Ordering in Tree (by UUID sort)

| Position | Document | Tag | Chunks | Global Range |
|----------|----------|-----|--------|--------------|
| 1 | SCG - Project Saint-IM_vF.pdf (CIM) | cim | 31 | 0–30 |
| 2 | 2026-06-15 SCG - 3rd IC Memo vS.pdf | ic_memo | 24 | 31–54 |
| 3 | SCG IC Screening Memo vS.pdf | ic_memo | 12 | 55–66 |
| 4 | 2026-06-21 Saint IC update_vS.pdf | ic_memo | 4 | 67–70 |
| 5 | Altman Solon CDD Report.pdf | consultant_report | 39 | 71–109 |
| 6 | 2026-05-18 SCG - 2nd IC Memo vS.pdf | ic_memo | 25 | 110–134 |
| 7 | Legal Due Diligence Report.pdf | consultant_report | 175 | 135–309 |
| 8 | PwC Vendor FDD Report.pdf | financial_model | 71 | 310–380 |

## Key Observation: PwC FDD Claims Are Siblings

Both contradictory claims are from the SAME document (PwC Vendor FDD):
- p.8 EBITDA £69.1m claim → chunk ~1 (early in the 71-chunk document) → global ~311
- p.29 EBITDA £55.9m claim → chunk ~5-6 (within first quarter) → global ~315-316

At MERGE_GROUP_SIZE=2, adjacent chunks merge first:
- Round 1: (310,311), (312,313), (314,315), (316,317), ...
- The two claims are likely within the SAME document's first 8 chunks (pages 1-40 of a ~350-page PDF at ~5000 chars/chunk ≈ 2-3 pages/chunk)

## Per-Gold-Case Predictions

### EBITDA Contradiction (p.8 vs p.29 — same document)

**Claim A chunk estimate:** p.8 content → chunk 1-2 (global ~311-312)
**Claim B chunk estimate:** p.29 content → chunk 5-6 (global ~315-316)

**LCA Round:** Round 2 or 3 (distance of ~4 chunks → paired by R1 with neighbors, then merge at R2-R3)

**Prediction: DETECTABLE** — LCA ≤ 3. Both claims arrive at the same merge node within the first 3 rounds, well before truncation erodes content. The Phase J experiment confirms Haiku detects this pair when co-present.

**HOWEVER — the actual failure mode is different:**

The pipeline does NOT feed raw text to the merge tree. It feeds EXTRACTION RESULTS — the sub-agent's JSON output per chunk. Each extraction produces a structured object with `flags`, `key_claims`, `data_points`, and `raw_summary`. The merge tree merges THESE extraction outputs, not the original text.

The contradiction is detectable if and only if:
1. The sub-agent extraction for chunk ~311 includes the £69.1m figure in its output
2. The sub-agent extraction for chunk ~315 includes the £55.9m figure in its output
3. Both survive `truncateMergeNodeText` (2000 char cap)
4. The merge-node LLM recognizes the contradiction from the truncated extraction JSON

**Structural risk at cap 2000:** If an extraction JSON is >2000 chars, `truncateMergeNodeText` trims in priority order: data_points first → key_claims → raw_summary. The EBITDA figures could be in `data_points` (trimmed first) OR `key_claims` (trimmed second). If both the £69.1m and £55.9m figures are stored as data_points, they may be evicted before the merge node ever sees them.

### Predictions for remaining gold cases (pending gold case list from user)

Gold cases not yet supplied. Tree geometry for any intra-PwC-FDD case:
- Same-document claims: LCA ≤ 4 (detection likely from geometry alone)
- Cross-document claims (e.g. IC Memo vs PwC FDD): LCA = 8-9 (structurally at risk)

## Threshold Rule

- **LCA ≤ 6**: Detectable from geometry (claims co-present before severe truncation accumulates)
- **LCA ≥ 7**: Structurally at risk (claims diluted by 64+ other extraction summaries at that node)

## Critical Caveat

This prediction assumes the contradiction survives the extraction phase (sub-agent outputs contain the relevant figures) AND survives truncation (figures are in a field that isn't trimmed at 2000 chars). Even at LCA=2, a contradiction fails if:
- The sub-agent doesn't extract the figure (hallucination-free extraction requires the figure to be in the chunk's text)
- The figure lands in `data_points` which is trimmed first by `truncateMergeNodeText`
- The merge-node Haiku fails to cross-reference two figures from different extraction JSONs

The Phase J experiment (bespoke user message, 6/6 detection) establishes that model capability is NOT the bottleneck. The bottleneck is evidence routing: whether the two figures reach the same merge node with enough context to be compared.
