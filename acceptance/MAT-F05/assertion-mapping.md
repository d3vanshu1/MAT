# MAT-F05 Assertion → Function → Test Mapping

## Frozen Acceptance Assertions

### Assertion A — Controlled narration boundary: LLM receives only locked factual projection

| Component | Location |
|-----------|----------|
| Interface | `LockedNarrationInput` in `narrative-boundary.ts` |
| Production function | `buildLockedNarrationInput()` in `narrative-boundary.ts` |
| Prohibited output list | `PROHIBITED_NARRATIVE_FIELDS` constant in `narrative-boundary.ts` |
| Dispatch entry | `processNarration()` overload (CanonicalFindingRecord path) |
| Tests | Test 22 (canonical record unchanged), Test 19 (fallback uses locked values) |

### Assertion B — Narrative output contract: LLM may output title, summary, explanation, analyst_attention only

| Component | Location |
|-----------|----------|
| Interface | `NarrativeOutput` in `narrative-boundary.ts` |
| Restricted fields | `PROHIBITED_NARRATIVE_FIELDS` (24 fields: verdict, severity, verified, claim_id, etc.) |
| Production function | `processNarration()` strips any extra fields before attaching |
| Tests | Test 17 (severity label rejected), Test 5 (verdict override rejected) |

### Assertion C — Evidence role enforcement: verified:true requires canonical verdict ∈ {confirmed, partially_supported}

| Component | Location |
|-----------|----------|
| Production function | `enforceEvidenceVerification()` in `narrative-authority-gate.ts` |
| Trigger | Called from `applyAuthorityGate()` for every evidence item |
| Wire-in | `applyBatchAuthorityGate()` → `finalize-pipeline-output.ts`, `complete-merge-tree.ts`, `merge-findings.ts` |
| Tests | Test 18 (verified:true stripped by authority gate) |

### Assertion D — Narrative validator: 10 rules enforce factual boundary

| Component | Location |
|-----------|----------|
| Production function | `validateNarrativeOutput()` in `narrative-validator.ts` |
| Rules | RULE_1 (invented numeric), RULE_2 (invented range), RULE_3 (synthesized quotation), RULE_4 (unknown source), RULE_5 (unknown entity), RULE_6 (unknown period), RULE_7 (verdict contradiction), RULE_8 (unsupported verification), RULE_9 (adverse language for supporting), RULE_10 (generated severity) |
| Normalization | ±1% relative tolerance; £194m ≡ £194million ≡ 194000000 |
| Tests | Tests 1–17 (one or more rules each) |

### Assertion E — LLM demotion from severity, claim_ids, source_docs, finding_kind, evidence.verified

| Component | Location |
|-----------|----------|
| Production function | `applyAuthorityGate()` in `narrative-authority-gate.ts` |
| Severity cap | `deriveAuthoritative_severity()` caps LLM severity to `mapVerdictToMaxSeverity(canonicalVerdict)` |
| claim_ids override | Canonical `[canonicalRecord.claim.claim_id]` replaces LLM list |
| source_docs override | `enforceSourceDocs()` replaces LLM list with canonical evidence source names |
| finding_kind override | Forced to `"data_divergence"` when canonical F04 record present |
| LLM diagnostics | Overridden values stored in `_llm_raw_diagnostic` (not discarded silently) |
| Tests | Test 5 (verdict contradiction), Test 17 (severity label), Test 18 (verified:true) |

### Assertion F — Deterministic fallback: invalid LLM narrative replaced without pipeline failure

| Component | Location |
|-----------|----------|
| Production function | `generateDeterministicFallbackNarrative()` in `narrative-boundary.ts` |
| Trigger | Called by `processNarration()` when `validateNarrativeOutput()` returns `passed: false` |
| Fallback content | Uses `locked_input.exact_claim_text`, canonical values, deterministic_verdict only |
| Self-validation | Fallback output is validated by `validateNarrativeOutput()` before return |
| Tests | Test 19 (fallback uses locked values, passes own validation) |

### Assertion G — Process object exclusion: operational/diagnostic findings never emitted as findings

| Component | Location |
|-----------|----------|
| Production function | `shouldExcludeAsProcessObject()` in `narrative-boundary.ts` |
| Pattern library | Title patterns: "Analysis Complete", "No findings", "Module Diagnostic", "Degraded Run Notice", "Processing Summary", etc. |
| Integration check | `isProcessObject()` checks title + detail + source_docs |
| Wire-in | `applyBatchAuthorityGate()` calls `applyAuthorityGate()` which calls `shouldExcludeAsProcessObject()` |
| Tests | Test 20 (5 process objects excluded, substantive finding not excluded) |

### Assertion H — Narrative does not alter finding identity

| Component | Location |
|-----------|----------|
| Production guarantee | `processNarration()` returns `canonical_unchanged: true` — original `LockedNarrationInput` is never mutated |
| Authority gate guarantee | `applyAuthorityGate()` uses `{ ...finding }` spread — original finding not mutated |
| Tests | Test 21 (finding_id unchanged after gate), Test 22 (locked input unchanged after processNarration) |

---

## Test → Assertion Mapping

| # | Test | Assertion |
|---|------|-----------|
| 1  | Changed currency value rejected (£195m, £180m) | D (RULE_1) |
| 2  | Invented percentage rejected (12.3%) | D (RULE_1) |
| 3  | Invented numeric range rejected (5–15pp) | D (RULE_2) |
| 4  | Changed delta rejected (£15m) | D (RULE_1) |
| 5  | Changed verdict ignored by authority gate | B, D (RULE_7), E |
| 6  | Synthesized quotation rejected | D (RULE_3) |
| 7  | Exact admitted quotation allowed | D (RULE_3 — negative case) |
| 8  | Normalized numeric formatting allowed (£194m vs £194 million) | D (normalization tolerance) |
| 9  | Unknown source name rejected | D (RULE_4) |
| 10 | Unknown entity rejected | D (RULE_5) |
| 11 | Unknown period rejected (FY2028) | D (RULE_6) |
| 12 | Supporting evidence cannot become adverse | D (RULE_9) |
| 13 | Contextual market evidence cannot prove SCG proposition | D (RULE_9) |
| 14 | Rejected evidence cannot reappear | D (RULE_4) |
| 15 | Confirmed finding cannot become contradicted via narrative | D (RULE_7) |
| 16 | Contradicted finding cannot become confirmed via narrative | D (RULE_7) |
| 17 | Severity returned by LLM is ignored | B, D (RULE_10) |
| 18 | verified:true returned by LLM is ignored (authority gate) | C, E |
| 19 | Deterministic fallback generation | F |
| 20 | Process/fallback object cannot become a finding | G |
| 21 | Narrative changes do not alter identity | H |
| 22 | Canonical record survives narration unchanged | A, H |

---

## Wire-In Points (Production Path)

| Integration Point | File | Change |
|-------------------|------|--------|
| Final finding output | `finalize-pipeline-output.ts` | Loads Q3 canonical records; applies `shouldExcludeAsProcessObject` + `applyBatchAuthorityGate`; saves `gatedFindings` |
| Merge tree completion | `complete-merge-tree.ts` | After LLM parse; applies exclusion + authority gate before checkpoint save |
| Module merge findings | `merge-findings.ts` | After LLM parse; applies exclusion + authority gate before `mergedText` build |

---

## Known Limitations (Out of Scope for F05)

1. **Full narration re-wiring**: `processNarration()` is available but live merge prompts have not been refactored to call it as the LLM generation step; authority gate covers the output path
2. **Q5 display layer**: Consumes gated findings; no F05 changes to presentation fields downstream
3. **Full Saint precision run**: Requires complete deal rerun (deferred per governance)
4. **LLM prompt input construction**: `buildLockedNarrationInput()` is available for future prompt wiring; not yet replacing live prompt construction in `merge-findings.ts`
5. **RULE_8 (unsupported verification)**: Present in validator but no dedicated F05 test; covered by RULE_9 scenarios
