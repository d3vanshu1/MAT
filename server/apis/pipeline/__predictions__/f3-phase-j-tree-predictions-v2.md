# F3 v2 — Corrected Tree Geometry Predictions for Contradiction Detection

## Date: 2026-08-17
## Deal: Project Saint (c46b4129-8a16-48ae-ad3a-1da061255445)
## Status: SUPERSEDES v1 (f3-phase-j-tree-predictions.md)

### Why v1 is withdrawn

v1 used the full 381-chunk tree (including Legal DD) and estimated claim positions
incorrectly using "distance-to-common-node" reasoning rather than the correct
`floor(P / 2^R)` group-assignment formula. v1 also incorrectly placed PwC FDD at
global positions 310–380 (it is actually 135–205 after Legal DD is excluded).

---

## Tree Parameters (Corrected)

| Parameter | Value |
|-----------|-------|
| MERGE_GROUP_SIZE | 2 (binary tree) |
| Legal DD excluded by `isChunkAllowedForContradictionCheck()` | YES — 175 chunks removed |
| Total chunks entering CC merge tree | **206** |
| Total merge rounds to root | **8** (ceil(log₂(206)) = 8) |
| MERGE_NODE_TEXT_CAP | 2000 chars per node |
| Model | Haiku (claude-haiku-4-5-20251001), max_tokens: 15000 |
| Grouping logic | Sequential slicing: `nodes.slice(g*2, (g+1)*2)` — equivalent to power-of-two alignment |
| LCA formula | `floor(P / 2^R)` — lowest R where both positions share the same group index |

---

## Document Ordering (Corrected — Legal DD EXCLUDED)

UUID sort order determines global position:

| # | UUID prefix | Document | Tag | Chunks | Global Range |
|---|-------------|----------|-----|--------|--------------|
| 1 | 02f3a1cc | SCG - Project Saint-IM_vF.pdf | cim | 31 | 0–30 |
| 2 | 31b3df2f | 2026-06-15 SCG - 3rd IC Memo vS.pdf | ic_memo | 24 | 31–54 |
| 3 | 440a86fb | SCG IC Screening Memo vS.pdf | ic_memo | 12 | 55–66 |
| 4 | 6197a6b2 | 2026-06-21 Saint IC update_vS.pdf | ic_memo | 4 | 67–70 |
| 5 | 7973c0b4 | Altman Solon CDD Report.pdf | consultant_report | 39 | 71–109 |
| 6 | 8fb7f474 | 2026-05-18 SCG - 2nd IC Memo vS.pdf | ic_memo | 25 | 110–134 |
| 7 | e5d69a30 | PwC Vendor FDD Report.pdf | financial_model | 71 | **135–205** |

**Note:** Legal DD (UUID prefix `a5726c37`) is excluded by filename regex match
(`/legal\s*(due\s*)?diligence/i`), even though tagged `consultant_report`.

---

## Singleton Carry Analysis

| Round | Input nodes | Groups | Singleton? | Singleton covers |
|-------|-------------|--------|------------|------------------|
| 1 | 206 | 103 | NO (even) | — |
| 2 | 103 | 51 + singleton | YES | R1 group 102 → positions 204–205 |
| 3 | 52 | 26 | NO | — |
| 4 | 26 | 13 | NO (even) | — |
| 5 | 13 | 6 + singleton | YES | Covers tail only |
| 6 | 7 | 3 + singleton | YES | Covers tail only |
| 7 | 4 | 2 | NO | — |
| 8 | 2 | 1 (root) | NO | — |

All singletons occur at the TAIL of the array. For positions ≤ 190 (all PwC FDD positions of interest), singletons never shift alignment. Power-of-two LCA formula is valid.

---

## EBITDA Contradiction — Claim Positions (DB-Verified)

### Finding: Both figures co-exist in multiple single chunks

Query against `universal_extractions` for PwC FDD (`e5d69a30-d768-4988-998f-bfdcb1a28058`):

| Chunk (local) | Contains £69.1m? | Contains £55.9m? | Both? | Global Position |
|---------------|------------------|------------------|-------|-----------------|
| 2 | ✅ | ✅ | **BOTH** | 137 |
| 3 | ✅ | ✅ | **BOTH** | 138 |
| 15 | ✅ | ✅ | **BOTH** | 150 |
| 23 | ✅ | ✅ | **BOTH** | 158 |
| 35 | ❌ | ✅ | £55.9m only | 170 |
| 39 | ✅ | ❌ | £69.1m only | 174 |
| 46 | ❌ | ✅ | £55.9m only | 181 |
| 48 | ❌ | ✅ | £55.9m only | 183 |
| 55 | ✅ | ❌ | £69.1m only | 190 |

### Critical Discovery: Intra-chunk contradiction

In chunks 2, 3, 15, and 23, both £69.1m and £55.9m are present in the SAME extraction.
This means the contradiction is potentially detectable at **Round 0** (the extraction itself)
— the sub-agent extraction for these chunks already has both figures visible.

The claim text from chunk 15 illustrates why this is contradictory:
- Claim `15:3`: "EBITDA is expected to increase from £49.9m in FY25 to **£55.9m in FY28**, reflecting a CAGR of 10.4%" (page 28)
- Data point in same chunk: "FY28 EBITDA Forecast: **£69.1m**"

The discrepancy: £55.9m vs £69.1m for FY28 EBITDA — a £13.2m delta.

---

## LCA Calculations

### Case A: Widest separation (different-chunk-only claims)

£69.1m at chunk 55 → global **190**; £55.9m at chunk 35 → global **170**

| Round R | Group(190) = floor(190/2^R) | Group(170) = floor(170/2^R) | Same? |
|---------|-------|-------|-------|
| 1 | 95 | 85 | ❌ |
| 2 | 47 | 42 | ❌ |
| 3 | 23 | 21 | ❌ |
| 4 | 11 | 10 | ❌ |
| 5 | **5** | **5** | ✅ |

**LCA = Round 5.** Group 5 at R5 spans positions [160, 191].

### Case B: Closest different-chunk separation

£69.1m at chunk 39 → global **174**; £55.9m at chunk 35 → global **170**

| Round R | Group(174) | Group(170) | Same? |
|---------|------------|------------|-------|
| 1 | 87 | 85 | ❌ |
| 2 | 43 | 42 | ❌ |
| 3 | **21** | **21** | ✅ |

**LCA = Round 3.** Group 21 at R3 spans positions [168, 175].

### Case C: Same-chunk scenario (most favourable)

Both figures in chunk 2 → global **137** — they enter the tree as a SINGLE node.

**LCA = Round 0** (no merge needed — both values are in the same extraction text).

---

## Revised Predictions

### Verdict: Structurally DETECTABLE (all scenarios LCA ≤ 5)

Even in the worst case (figures only survive in their isolated chunks), LCA = 5
is well within the ≤ 6 "geometry safe" threshold.

### But the REAL bottleneck is not geometry

**Finding:** 4 out of 9 chunks containing these figures have BOTH values present.
The contradiction exists within single extraction nodes. The tree doesn't need to
bring them together — they're already together.

**Why it might still fail:**

1. **Truncation at cap 2000:** The extraction JSON for chunk 2 is likely >2000 chars
   (it contains ≥10 claims + data_points). `truncateMergeNodeText` evicts `data_points`
   first. The £55.9m appears in a `data_points` field with category "financial" and
   could be evicted before any merge sees it. The £69.1m appears both as a claim
   (`key_claims`) and a data_point — so it might survive longer.

2. **Merge prompt isn't contradiction-focused:** The CC merge template asks the model
   to synthesize/summarize. It does not explicitly instruct "flag contradictions."
   Even if both figures reach the same node, the merge model may simply average them
   or report both without flagging a conflict.

3. **No CC has ever run on this deal:** All module_runs for Saint are `omission_audit`.
   This prediction is entirely hypothetical — we cannot validate it against actual output.

### Truncation Risk Assessment

At chunk 2 (global 137):
- Claims visible: extraction contains ≥10 key_claims + multiple data_points
- Estimated extraction JSON size: likely 3000–5000 chars
- At 2000-char cap: data_points evicted first, then key_claims trimmed
- **Risk:** £55.9m (in data_points) evicted before £69.1m (in key_claims) survives
- **Result:** Only one figure may survive truncation at node level 0

At LCA Round 3 (group span [168,175], covering chunks 35–39):
- By Round 3, each node is the merger of 8 original chunks
- Each of those 8 extractions was already truncated to 2000 chars at Round 0
- The merge output is again truncated to 2000 chars
- Cumulative information loss: severe for specific numeric values

---

## Threshold Rule (Revised)

| LCA | Geometry | Detection Probability |
|-----|----------|----------------------|
| 0 (same chunk) | Claims co-present in raw extraction | HIGH — but truncation may still evict one figure |
| 1–3 | Claims merge within same document section | MODERATE — depends on truncation survival |
| 4–5 | Claims merge within same document | LOW-MODERATE — significant dilution from other chunks |
| 6 | Claims merge across document boundaries | LOW — heavy truncation accumulation |
| 7–8 | Near root | VERY LOW — figures diluted among 64–128 merged nodes |

### For this specific EBITDA case:

- **Best case (LCA=0, same chunk):** ~60% detection — limited by truncation evicting data_points
- **Realistic case (LCA=3):** ~30% detection — figures survive truncation AND merge model flags them
- **Worst case (LCA=5):** ~10% detection — extreme cumulative truncation

---

## F2 Summary: Group Span Table at Each Round for Key Positions

PwC FDD chunk_index=2 (global 137) — the chunk with both EBITDA figures:

| Round | Group Index | Span Start | Span End | Nodes Merged | Notes |
|-------|-------------|------------|----------|--------------|-------|
| 0 | 137 | 137 | 137 | 1 | Raw extraction |
| 1 | 68 | 136 | 137 | 2 | Paired with chunk_index=1 |
| 2 | 34 | 136 | 139 | 4 | |
| 3 | 17 | 136 | 143 | 8 | |
| 4 | 8 | 128 | 143* | 16 | *Actual upper bound limited by tree width |
| 5 | 4 | 128 | 159 | 32 | |
| 6 | 2 | 128 | 191 | 64 | Spans most of PwC FDD |
| 7 | 1 | 64 | 127 → merged with 128–191 | 128 | Includes IC memos + CDD + FDD |
| 8 | 0 | 0 | 205 (root) | 206 | All documents merged |

---

## Conclusion

**The EBITDA £69.1m / £55.9m contradiction is structurally detectable by tree geometry**
(LCA ≤ 5 in all scenarios, LCA = 0 for the 4 chunks containing both figures).

**The binding constraint is NOT whether the claims meet — it's whether they survive
truncation and whether the merge prompt elicits contradiction flagging.**

Evidence:
- Phase J experiment: 6/6 models detect the contradiction when both claims are presented directly
- Tree geometry: Claims co-exist in same node at Round 0 (4 chunks)
- Truncation: `data_points` evicted first — the £55.9m figure may be lost before any comparison
- No CC has ever run: Prediction cannot be validated empirically on this deal

---

## v1 Errors Corrected

| Item | v1 (incorrect) | v2 (corrected) |
|------|----------------|----------------|
| CC chunk count | 381 | **206** (Legal DD excluded) |
| Merge rounds | 9 | **8** |
| PwC FDD global range | 310–380 | **135–205** |
| LCA method | "distance" heuristic | `floor(P/2^R)` group assignment |
| LCA estimate | Round 2–3 | Round 0 (same chunk) to Round 5 (worst case) |
| Key finding | Geometry limits detection | **Geometry is NOT the bottleneck — truncation is** |
