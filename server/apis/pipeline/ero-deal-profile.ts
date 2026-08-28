/**
 * ERO v2 — Stage 2: Build Deal Profile (Packet 2.2 + 2.2-fix)
 *
 * Builds ERO's own understanding of the deal across two field groups:
 *   business_shape — what the company is (sector, revenue model, etc.)
 *   thesis_dependency — discrete falsifiable propositions that must
 *     stay true for the base case to hold.
 *
 * Same provenance discipline as the entity manifest: every field
 * carries a code-extracted verbatim snippet or it is not written.
 *
 * 2.2-fix: TOKEN-ANCHORED verification gate. The model returns
 * anchor_terms (1-3 short distinctive strings) instead of a full
 * anchor_phrase. The gate requires ALL terms to co-occur within a
 * SINGLE chunk. If they do, the snippet is code-extracted from that
 * chunk (~250-char window spanning the matched terms).
 *
 * 2.2-fix: Thesis retrieval breadth. A secondary THESIS_CROWN_QUERY
 * seeds crown-jewel dependency topics (Surgery Connect, own-IP,
 * channel structure) to ensure those chunks rank in FTS. Reserved
 * slots guarantee they aren't crowded out by generic thesis terms.
 *
 * Single LLM call per group. Survivors written to ero_profile.
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./ero-stage-contract.js";

// ── Model ───────────────────────────────────────────────────────────
// Hardcoded per-stage. Model-config centralization happens at Phase 5
// switchover — do NOT touch model-config.ts.
const MODEL = "claude-sonnet-4-6";

// ── Retrieval config ────────────────────────────────────────────────
const SHAPE_TAGS = ["cim", "consultant_report"];
const THESIS_TAGS = ["ic_memo", "consultant_report"];

const SHAPE_QUERY =
  "sector revenue model subscription recurring SaaS UCaaS connectivity B2B SME channel reseller direct geography UK market vertical customer type scale employees";

// Primary thesis query — broad thesis / assumption / financial language
const THESIS_QUERY =
  "thesis growth assumption M&A acquisition EBITDA revenue must churn retention NRR gross margin dependency risk base case returns multiple valuation organic inorganic";

// Crown-jewel thesis query — seeds specific high-value dependency topics
// that the broad query may not pull (Surgery Connect GP market share,
// own-IP gross profit mix-shift, channel structure / disintermediation).
const THESIS_CROWN_QUERY =
  "Surgery Connect market share GP practices own IP gross profit mix shift organic GP growth channel-led disintermediation aggregator";

const MAX_CONTEXT_CHARS = 20_000;
const MAX_CHUNKS_PER_QUERY = 40;
const THESIS_RESERVED_CHUNKS = 4; // guaranteed slots for crown-jewel thesis chunks

// ── business_shape field names (fixed set of 7) ─────────────────────
const SHAPE_FIELDS = [
  "sector",
  "revenue_model",
  "customer_type",
  "channel_mix",
  "geography",
  "scale_band",
  "deal_archetype",
] as const;

// ── Zod schemas ─────────────────────────────────────────────────────
const ChunkRow = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  file_name: z.string(),
  content: z.string(),
  rank: z.coerce.number(),
});

const CountRow = z.object({
  cnt: z.coerce.number(),
});

const ProfileRow = z.object({
  profile_id: z.string(),
  run_id: z.string(),
  field_group: z.string(),
  field_name: z.string(),
  field_value: z.string(),
  source_document_id: z.string(),
  verbatim_snippet: z.string(),
  created_at: z.string(),
});

// 2.2-fix: Model returns anchor_terms (1-3 short tokens) instead of anchor_phrase
const LlmProfileField = z.object({
  field_name: z.string(),
  field_value: z.string(),
  anchor_terms: z.array(z.string()).min(1).max(5),
  source_document_id: z.string(),
});

const AnthropicResponse = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
  usage: z.object({
    input_tokens: z.coerce.number(),
    output_tokens: z.coerce.number(),
  }),
});

// ── Dropped field record ────────────────────────────────────────────
type DroppedProfileField = {
  field_group: string;
  field_name: string;
  field_value: string;
  anchor_terms: string[];
  source_document_id: string;
  reason: string;
  failed_terms?: string[];
};

// ── FTS retrieval SQL (same template as entity manifest) ────────────
const chunkSql = `
  WITH q AS (SELECT websearch_to_tsquery('english', $2) AS tsq)
  SELECT dc.document_id,
         dc.chunk_index,
         dc.file_name,
         dc.content,
         ts_rank_cd(dc.tsv, q.tsq) AS rank
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    CROSS JOIN q
   WHERE dc.deal_id = $1::uuid
     AND d.deal_id = $1::uuid
     AND d.document_tag = ANY($3::text[])
   ORDER BY ts_rank_cd(dc.tsv, q.tsq) DESC, dc.chunk_index ASC
   LIMIT $4`;

// ── Token matching helpers ──────────────────────────────────────────

/** Build a case-insensitive regex for an anchor term.
 *  Short tokens (≤4 chars, e.g. "55%", "NRR") use word-boundary anchors
 *  to avoid false positives. Longer tokens use plain indexOf. */
function findTermInChunk(
  chunkContent: string,
  term: string,
): { index: number; length: number } | null {
  if (term.length <= 4) {
    // Word-boundary regex for short tokens
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\b|(?<=\\s))${escaped}(?:$|\\b|(?=\\s))`, "i");
    const m = re.exec(chunkContent);
    return m ? { index: m.index, length: term.length } : null;
  }
  // Case-insensitive substring for longer phrases
  const idx = chunkContent.toLowerCase().indexOf(term.toLowerCase());
  return idx >= 0 ? { index: idx, length: term.length } : null;
}

/** Extract a ~250-char snippet spanning ALL matched term positions in a chunk. */
function extractSpanSnippet(
  text: string,
  matches: Array<{ index: number; length: number }>,
): string {
  const WINDOW = 250;
  // Find the span covering all matched terms
  const spanStart = Math.min(...matches.map((m) => m.index));
  const spanEnd = Math.max(...matches.map((m) => m.index + m.length));
  const spanLen = spanEnd - spanStart;

  // Distribute remaining window budget as padding around the span
  const remaining = Math.max(0, WINDOW - spanLen);
  const padBefore = Math.floor(remaining / 2);
  const padAfter = remaining - padBefore;

  let start = Math.max(0, spanStart - padBefore);
  let end = Math.min(text.length, spanEnd + padAfter);

  // Extend to word boundaries to avoid mid-word cuts
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  while (end < text.length && !/\s/.test(text[end]!)) end++;

  return text.slice(start, end).trim();
}

// ── Exported handler ────────────────────────────────────────────────
export async function buildDealProfile(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult & { dropped?: DroppedProfileField[] }> {
  const db = ctx.integrations.ic_diligence_db;
  const claude = ctx.integrations.claude;

  // ── 1. Clean-slate guard ─────────────────────────────────────────
  // Two LLM groups (business_shape, thesis_dependency) are inserted
  // separately. A death between the two would leave partial rows.
  // DELETE all so we redo the full stage atomically.
  await db.execute(
    `DELETE FROM ero_profile WHERE run_id = $1`,
    [runId],
    { label: "DealProfile: clean slate (delete partial rows)" },
  );

  // ── 2. Retrieve chunks for business_shape ─────────────────────────
  const shapeRawChunks = await db.query(
    chunkSql,
    ChunkRow,
    [dealId, SHAPE_QUERY, SHAPE_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "DealProfile: FTS business_shape" },
  );

  // ── 3. Retrieve chunks for thesis_dependency ──────────────────────
  // Two queries: broad thesis terms + crown-jewel topic terms.
  // Crown-jewel chunks get reserved slots (like entity manifest appendix).
  const thesisRawChunks = await db.query(
    chunkSql,
    ChunkRow,
    [dealId, THESIS_QUERY, THESIS_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "DealProfile: FTS thesis_dependency (broad)" },
  );

  const thesisCrownChunks = await db.query(
    chunkSql,
    ChunkRow,
    [dealId, THESIS_CROWN_QUERY, THESIS_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "DealProfile: FTS thesis_dependency (crown-jewel topics)" },
  );

  // ── 4. Dedupe & cap ───────────────────────────────────────────────
  function dedupeAndCap(
    chunks: z.infer<typeof ChunkRow>[],
    maxChars: number,
  ): z.infer<typeof ChunkRow>[] {
    const seen = new Set<string>();
    const result: z.infer<typeof ChunkRow>[] = [];
    let total = 0;
    const markerLen = 60;
    for (const c of chunks) {
      const key = `${c.document_id}:${c.chunk_index}`;
      if (seen.has(key)) continue;
      if (total + c.content.length + markerLen > maxChars) break;
      seen.add(key);
      result.push(c);
      total += c.content.length + markerLen;
    }
    return result;
  }

  const shapeChunks = dedupeAndCap(shapeRawChunks, MAX_CONTEXT_CHARS);

  // ── Thesis: reserved slots for crown-jewel chunks, then fill ──────
  const thesisSeen = new Set<string>();
  const thesisReserved: z.infer<typeof ChunkRow>[] = [];
  for (const c of thesisCrownChunks) {
    if (thesisReserved.length >= THESIS_RESERVED_CHUNKS) break;
    const key = `${c.document_id}:${c.chunk_index}`;
    if (!thesisSeen.has(key)) {
      thesisSeen.add(key);
      thesisReserved.push(c);
    }
  }

  // Fill remaining budget with broad thesis chunks
  const thesisRemainder: z.infer<typeof ChunkRow>[] = [];
  for (const c of thesisRawChunks) {
    const key = `${c.document_id}:${c.chunk_index}`;
    if (!thesisSeen.has(key)) {
      thesisSeen.add(key);
      thesisRemainder.push(c);
    }
  }
  // Remaining crown chunks beyond reserved set
  for (const c of thesisCrownChunks) {
    const key = `${c.document_id}:${c.chunk_index}`;
    if (!thesisSeen.has(key)) {
      thesisSeen.add(key);
      thesisRemainder.push(c);
    }
  }

  // Cap at MAX_CONTEXT_CHARS — reserved first, then remainder
  let thesisTotalChars = 0;
  const thesisChunks: z.infer<typeof ChunkRow>[] = [];
  const markerLen = 60;

  for (const c of thesisReserved) {
    if (thesisTotalChars + c.content.length + markerLen > MAX_CONTEXT_CHARS)
      break;
    thesisChunks.push(c);
    thesisTotalChars += c.content.length + markerLen;
  }
  for (const c of thesisRemainder) {
    if (thesisTotalChars + c.content.length + markerLen > MAX_CONTEXT_CHARS)
      break;
    thesisChunks.push(c);
    thesisTotalChars += c.content.length + markerLen;
  }

  if (shapeChunks.length === 0 && thesisChunks.length === 0) {
    return {
      stage: "build_deal_profile",
      status: "failed",
      message: "No document chunks found for either field group.",
    };
  }

  // ── 5. Build context blocks + chunk-by-doc lookup ─────────────────
  function buildContext(
    chunks: z.infer<typeof ChunkRow>[],
  ): { contextBlock: string; chunksByDocId: Map<string, string[]> } {
    const chunksByDocId = new Map<string, string[]>();
    const parts: string[] = [];
    for (const c of chunks) {
      const marker = `[DOC_ID: ${c.document_id} | FILE: ${c.file_name}]`;
      parts.push(`${marker}\n${c.content}`);
      if (!chunksByDocId.has(c.document_id)) {
        chunksByDocId.set(c.document_id, []);
      }
      chunksByDocId.get(c.document_id)!.push(c.content);
    }
    return {
      contextBlock: parts.join("\n\n---\n\n"),
      chunksByDocId,
    };
  }

  const shapeCtx = buildContext(shapeChunks);
  const thesisCtx = buildContext(thesisChunks);

  // Merge chunk maps for cross-group anchor search
  const allChunksByDocId = new Map<string, string[]>();
  for (const [docId, texts] of shapeCtx.chunksByDocId) {
    allChunksByDocId.set(docId, [...texts]);
  }
  for (const [docId, texts] of thesisCtx.chunksByDocId) {
    const existing2 = allChunksByDocId.get(docId);
    if (existing2) {
      const existingSet = new Set(existing2);
      for (const t of texts) {
        if (!existingSet.has(t)) existing2.push(t);
      }
    } else {
      allChunksByDocId.set(docId, [...texts]);
    }
  }

  // Flatten all chunks for sweep search
  const allChunks = [
    ...shapeChunks,
    ...thesisChunks.filter(
      (tc) =>
        !shapeChunks.some(
          (sc) =>
            sc.document_id === tc.document_id &&
            sc.chunk_index === tc.chunk_index,
        ),
    ),
  ];

  // ── 6. LLM call — business_shape ─────────────────────────────────
  const shapeSystemPrompt = `You are a deal profile analyst for M&A due diligence. Extract structured business characteristics from the provided document extracts.

FIELDS TO EXTRACT (exactly these 7):
- sector: The primary industry sector (e.g. "UCaaS / unified communications", "enterprise software"). Be specific, not generic.
- revenue_model: How the company earns revenue (e.g. "recurring subscription + usage-based", "project-based consulting"). Include the mix if stated.
- customer_type: Who the customers are (e.g. "UK SMEs 10-250 FTEs", "enterprise >1000 employees"). Include stated size/segment criteria.
- channel_mix: How the company sells (e.g. "60% direct, 40% channel partners/resellers", "100% direct sales force"). Include % if stated.
- geography: Where the company operates (e.g. "UK-only, headquartered South East England", "US + Western Europe").
- scale_band: Revenue or EBITDA scale (e.g. "~£85m revenue, ~£25m EBITDA", "£50-100m revenue"). Use actual stated figures.
- deal_archetype: The deal type (e.g. "PE buyout of founder-led SME", "platform acquisition for buy-and-build", "carve-out from corporate parent").

RULES:
1. Each field_value must be a SHORT, FACTUAL phrase — not a paragraph. 5-30 words max.
2. anchor_terms: provide 1-3 SHORT, DISTINCTIVE strings that ground the claim. Each term should be a named entity, a specific number/percentage, or a short phrase (2-5 words) that appears verbatim in the source. Examples: ["96% recurring", "£187m"], ["UCaaS", "B2B communications"]. Do NOT provide full sentences.
3. source_document_id must be the exact DOC_ID from the marker line of the chunk where the anchor terms appear. All anchor terms must appear in the SAME chunk.
4. Do not invent facts. If a field cannot be determined from the text, omit that field entirely rather than guessing.

Return ONLY a JSON array of objects with keys: field_name, field_value, anchor_terms, source_document_id. No markdown, no explanation.`;

  const shapeUserPrompt = `Extract business shape characteristics from these due diligence document extracts:\n\n${shapeCtx.contextBlock}`;

  let shapeFields: z.infer<typeof LlmProfileField>[] = [];
  let shapeTokens = { input: 0, output: 0 };

  if (shapeChunks.length > 0) {
    const shapeResult = await claude.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: MODEL,
          max_tokens: 4096,
          system: shapeSystemPrompt,
          messages: [{ role: "user", content: shapeUserPrompt }],
        },
      },
      { response: AnthropicResponse },
      { label: "DealProfile: LLM business_shape" },
    );
    shapeTokens = {
      input: shapeResult.usage.input_tokens,
      output: shapeResult.usage.output_tokens,
    };
    shapeFields = parseLlmFields(shapeResult);
  }

  // ── 7. LLM call — thesis_dependency ───────────────────────────────
  const thesisSystemPrompt = `You are a deal thesis analyst for M&A due diligence. Extract the discrete falsifiable propositions that underpin the investment base case.

A thesis dependency is a SPECIFIC, MEASURABLE claim that must remain true for the base case to hold. It is NOT a vague adjective or a direction of travel.

GOOD thesis dependencies (specific, falsifiable, grounded):
- "~50-acquisition programmatic M&A at ~5.5x blended must keep delivering ~£6m EBITDA/yr per acquisition"
- "Organic NRR must stay above 100% for existing installed base to avoid revenue erosion"
- "PSTN/ISDN switch-off by 2027 forces migration of ~8m UK lines, driving demand for UCaaS replacement"
- "Gross margin must hold above 60% as product mix shifts toward connectivity"
- "Top-10 customer concentration below 15% of revenue — loss of any single customer is manageable"

BAD thesis dependencies (vague, unfalsifiable, boilerplate):
- "Growth must continue"
- "Management is strong"
- "Market tailwinds are favourable"
- "M&A integration must be successful"
- "Revenue must grow"

RULES:
1. Extract 5-8 thesis dependencies. Quality over quantity — each must be grounded in specific text.
2. Each field_value is the proposition itself — a single sentence, specific and falsifiable.
3. field_name should be a short snake_case label (e.g. "td_mna_ebitda_delivery", "td_organic_nrr", "td_pstn_switchoff").
4. anchor_terms: provide 1-3 SHORT, DISTINCTIVE strings that ground the claim. Each term should be a named entity, a specific number/percentage, or a short phrase (2-5 words). Examples: ["Surgery Connect", "55%", "market share"], ["organic GP growth", "10%"]. All terms must appear in the SAME chunk. Do NOT provide full sentences — short load-bearing tokens only.
5. source_document_id must be the exact DOC_ID from the marker line where the anchor terms appear.
6. Extract what the memos actually assert. Do NOT invent propositions absent from text.

Return ONLY a JSON array of objects with keys: field_name, field_value, anchor_terms, source_document_id. No markdown, no explanation.`;

  const thesisUserPrompt = `Extract thesis dependencies from these IC memo and due diligence document extracts:\n\n${thesisCtx.contextBlock}`;

  let thesisFields: z.infer<typeof LlmProfileField>[] = [];
  let thesisTokens = { input: 0, output: 0 };

  if (thesisChunks.length > 0) {
    const thesisResult = await claude.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: MODEL,
          max_tokens: 4096,
          system: thesisSystemPrompt,
          messages: [{ role: "user", content: thesisUserPrompt }],
        },
      },
      { response: AnthropicResponse },
      { label: "DealProfile: LLM thesis_dependency" },
    );
    thesisTokens = {
      input: thesisResult.usage.input_tokens,
      output: thesisResult.usage.output_tokens,
    };
    thesisFields = parseLlmFields(thesisResult);
  }

  // ── 8. VERIFICATION GATE — token-anchored co-occurrence ───────────
  // For each field, ALL anchor_terms must co-occur within a SINGLE
  // retrieved chunk. If they do, extract a ~250-char window spanning
  // the matched terms. If any term is missing from every chunk, DROP.
  //
  // This replaces the 2.2 anchor_phrase substring gate. Same grounding
  // principle — a dependency survives only if its key claim is verifiably
  // in retrieved source — but anchoring on short tokens instead of a
  // full sentence avoids transcription / table-format mismatches.

  const survivors: Array<{
    field_group: string;
    field_name: string;
    field_value: string;
    anchor_terms: string[];
    source_document_id: string;
    verbatim_snippet: string;
  }> = [];
  const dropped: DroppedProfileField[] = [];

  function verifyAndCollect(
    fields: z.infer<typeof LlmProfileField>[],
    fieldGroup: string,
  ): void {
    for (const f of fields) {
      // Try cited document first, then sweep all chunks
      let foundDocId: string | null = null;
      let foundSnippet: string | null = null;

      // Search order: cited doc chunks → all chunks
      const searchPasses: Array<{
        docId: string | null;
        chunks: string[];
      }> = [];

      // Pass 1: cited document
      const citedChunks = allChunksByDocId.get(f.source_document_id);
      if (citedChunks) {
        searchPasses.push({
          docId: f.source_document_id,
          chunks: citedChunks,
        });
      }

      // Pass 2: all chunks (sweep)
      searchPasses.push({ docId: null, chunks: [] }); // sentinel for sweep

      for (const pass of searchPasses) {
        if (foundDocId) break;

        const chunksToSearch =
          pass.docId !== null
            ? pass.chunks.map((content) => ({
                content,
                document_id: pass.docId!,
              }))
            : allChunks.map((c) => ({
                content: c.content,
                document_id: c.document_id,
              }));

        for (const chunk of chunksToSearch) {
          // Check ALL anchor terms co-occur in THIS chunk
          const termMatches: Array<{ index: number; length: number }> = [];
          let allFound = true;

          for (const term of f.anchor_terms) {
            const m = findTermInChunk(chunk.content, term);
            if (!m) {
              allFound = false;
              break;
            }
            termMatches.push(m);
          }

          if (allFound && termMatches.length === f.anchor_terms.length) {
            foundDocId = chunk.document_id;
            foundSnippet = extractSpanSnippet(chunk.content, termMatches);
            break;
          }
        }
      }

      if (!foundDocId || !foundSnippet) {
        // Determine which terms failed for diagnostics
        const failedTerms: string[] = [];
        for (const term of f.anchor_terms) {
          let termFound = false;
          for (const chunk of allChunks) {
            if (findTermInChunk(chunk.content, term)) {
              termFound = true;
              break;
            }
          }
          if (!termFound) failedTerms.push(term);
        }

        dropped.push({
          field_group: fieldGroup,
          field_name: f.field_name,
          field_value: f.field_value,
          anchor_terms: f.anchor_terms,
          source_document_id: f.source_document_id,
          reason:
            failedTerms.length > 0
              ? `anchor terms not in any retrieved chunk: [${failedTerms.join(", ")}]`
              : "anchor terms do not co-occur in any single chunk",
          failed_terms: failedTerms.length > 0 ? failedTerms : undefined,
        });
        continue;
      }

      survivors.push({
        field_group: fieldGroup,
        field_name: f.field_name,
        field_value: f.field_value,
        anchor_terms: f.anchor_terms,
        source_document_id: foundDocId,
        verbatim_snippet: foundSnippet,
      });
    }
  }

  verifyAndCollect(shapeFields, "business_shape");
  verifyAndCollect(thesisFields, "thesis_dependency");

  // ── 9. Insert surviving profile fields ────────────────────────────
  if (survivors.length > 0) {
    const valueClauses: string[] = [];
    const params: unknown[] = [runId]; // $1 = runId
    let paramIdx = 2;

    for (const s of survivors) {
      valueClauses.push(
        `(gen_random_uuid(), $1, $${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}::uuid, $${paramIdx + 4}, now())`,
      );
      params.push(
        s.field_group,
        s.field_name,
        s.field_value,
        s.source_document_id,
        s.verbatim_snippet,
      );
      paramIdx += 5;
    }

    await db.execute(
      `INSERT INTO ero_profile
         (profile_id, run_id, field_group, field_name, field_value,
          source_document_id, verbatim_snippet, created_at)
       VALUES ${valueClauses.join(", ")}`,
      params,
      { label: `DealProfile: insert ${survivors.length} profile fields` },
    );
  }

  // ── 10. Build summary ─────────────────────────────────────────────
  const byGroup: Record<string, number> = {};
  for (const s of survivors) {
    byGroup[s.field_group] = (byGroup[s.field_group] || 0) + 1;
  }
  const breakdown = Object.entries(byGroup)
    .map(([g, n]) => `${g}:${n}`)
    .join(", ");

  const totalIn = shapeTokens.input + thesisTokens.input;
  const totalOut = shapeTokens.output + thesisTokens.output;

  const message = [
    `${survivors.length} profile fields inserted`,
    `${dropped.length} dropped`,
    `breakdown: ${breakdown || "none"}`,
    `context: shape=${shapeChunks.length}chunks thesis=${thesisChunks.length}chunks (${thesisReserved.length} reserved)`,
    `tokens: in=${totalIn} out=${totalOut}`,
  ].join(" | ");

  return {
    stage: "build_deal_profile",
    status: "complete",
    message,
    dropped,
  };
}

// ── LLM response parser ─────────────────────────────────────────────
function parseLlmFields(
  llmResult: z.infer<typeof AnthropicResponse>,
): z.infer<typeof LlmProfileField>[] {
  const textBlock = llmResult.content.find((c: any) => c.type === "text");
  if (!textBlock?.text) return [];

  let jsonText = textBlock.text.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(jsonText);
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed.fields ?? parsed.data ?? [];
  return arr.map((f: any) => {
    // Normalise: if model still sends anchor_phrase, convert to anchor_terms
    if (f.anchor_phrase && !f.anchor_terms) {
      f.anchor_terms = [f.anchor_phrase];
    }
    return LlmProfileField.parse(f);
  });
}

// Re-export types the test harness needs
export type { DroppedProfileField };
export { ProfileRow };
