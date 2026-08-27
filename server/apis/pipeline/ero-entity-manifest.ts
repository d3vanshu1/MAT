/**
 * ERO v2 — Stage 1: Build Entity Manifest (Packet 2.1)
 *
 * Extracts named entities the research agent will investigate:
 * parent, target, subsidiaries, acquired entities, executives,
 * customers, competitors, regulators, jurisdictions.
 *
 * Each entity carries a source_document_id and verbatim_snippet.
 * The FABRICATION GATE (code, not prompt) verifies every entity's
 * legal_name appears as a word-boundary match in the retrieved chunks.
 * The stored snippet is extracted from source in code — the model's
 * snippet is advisory only. Unverifiable names are dropped.
 *
 * Single-LLM-call stage: builds full list in memory, inserts once.
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./ero-stage-contract.js";
// matchSnippet no longer used — gate verifies legal_name directly
// and extracts snippet from source in code.

// ── Model ───────────────────────────────────────────────────────────
// Hardcoded per-stage. Model-config centralization happens at Phase 5
// switchover — do NOT touch model-config.ts.
const MODEL = "claude-sonnet-4-6";

// ── Retrieval config ────────────────────────────────────────────────
// legal: Legal DD — primary source of registered entity names, SPA parties,
//   and litigation counterparties.
// consultant_report: Vendor FDD — group-structure appendix, subsidiary names.
// cim, ic_memo: secondary narrative sources.
// Excluded: financial_model (xlsx, low entity density — dilutes context
//   budget with numeric tables, not registered names).
const ALLOWLIST_TAGS = ["legal", "consultant_report", "cim", "ic_memo"];

// FTS boost queries — primary pulls both the FDD group-structure appendix
// AND the Legal DD's entity/litigation content.
const PRIMARY_QUERY = "subsidiaries group structure trading entities parties litigation claimant defendant registered company number";
const SECONDARY_QUERY = "parent company executive management team board";
// Tertiary: acquisition history and group-structure content — source for acquired_entity rows.
// Generic terms only — roster pass (6b) handles dense company-name retrieval by suffix density.
const TERTIARY_QUERY = "acquisition acquired trading companies group structure organisation business units direct indirect subsidiaries Ltd Limited";
// Regulatory content — pulls regulator mentions for regulator type.
const REGULATORY_QUERY = "regulator regulatory compliance licence authority statutory regime approved supplier framework";

const MAX_CONTEXT_CHARS = 40_000;
const MAX_CHUNKS_PER_QUERY = 60; // overfetch then dedupe + cap

// ── Entity types ────────────────────────────────────────────────────
const ENTITY_TYPES = [
  "parent",
  "target",
  "subsidiary",
  "acquired_entity",
  "executive",
  "customer",
  "competitor",
  "regulator",
  "adviser",
  "counterparty",
] as const;

// ── Company-name normalization (Layer 2) ────────────────────────────
// Strips trailing company suffixes to produce a dedup KEY.
// The stored legal_name keeps its original form — only the key is normalized.
const COMPANY_SUFFIX_RE = /\s+(?:limited|ltd\.?|plc|l\.?l\.?c\.?|inc\.?|\(uk\))\s*$/i;

function normalizeCompanyName(name: string): string {
  let key = name.toLowerCase().trim();
  // Collapse internal whitespace
  key = key.replace(/\s+/g, " ");
  // Strip trailing suffix (repeat once in case of double like "Ltd.")
  key = key.replace(COMPANY_SUFFIX_RE, "");
  key = key.trim();
  return key;
}

// ── Zod schemas ─────────────────────────────────────────────────────
const ChunkRow = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  file_name: z.string(),
  content: z.string(),
  rank: z.coerce.number(),
});

const EntityCountRow = z.object({
  cnt: z.coerce.number(),
});

const EntityRow = z.object({
  entity_id: z.string(),
  run_id: z.string(),
  entity_type: z.string(),
  legal_name: z.string(),
  registration_number: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  role: z.string().nullable(),
  source_document_id: z.string(),
  verbatim_snippet: z.string(),
  rank_signal: z.any().nullable(),
  created_at: z.string(),
});

// LLM response schema (loose — we validate in code)
const LlmEntity = z.object({
  entity_type: z.string(),
  legal_name: z.string(),
  registration_number: z.string().nullable().optional(),
  jurisdiction: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  source_document_id: z.string(),
  verbatim_snippet: z.string(),
  rank_signal: z.any().nullable().optional(),
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

// ── Dropped entity record ───────────────────────────────────────────
type DroppedEntity = {
  legal_name: string;
  entity_type: string;
  source_document_id: string;
  reason: string;
};

// ── Exported handler ────────────────────────────────────────────────
export async function buildEntityManifest(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult & { dropped?: DroppedEntity[]; semanticDedup?: any }> {
  const db = ctx.integrations.ic_diligence_db;
  const claude = ctx.integrations.claude;

  // ── 1. Idempotency check ──────────────────────────────────────────
  const existing = await db.query(
    `SELECT count(*)::int AS cnt FROM ero_entities WHERE run_id = $1`,
    EntityCountRow,
    [runId],
    { label: "EntityManifest: idempotency check" },
  );
  if (existing[0].cnt > 0) {
    return {
      stage: "build_entity_manifest",
      status: "complete",
      message: `already built, ${existing[0].cnt} entities`,
    };
  }

  // ── 2. Retrieve chunks via FTS ────────────────────────────────────
  // Three queries: primary (group structure / subsidiaries / legal parties),
  // secondary (parent / executives), tertiary (acquisitions / org chart).
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

  const primaryChunks = await db.query(
    chunkSql,
    ChunkRow,
    [dealId, PRIMARY_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "EntityManifest: FTS primary (subsidiaries/group)" },
  );

  const secondaryChunks = await db.query(
    chunkSql,
    ChunkRow,
    [dealId, SECONDARY_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "EntityManifest: FTS secondary (parent/exec)" },
  );

  const tertiaryChunks = await db.query(
    chunkSql,
    ChunkRow,
    [dealId, TERTIARY_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "EntityManifest: FTS tertiary (acquisitions/group structure)" },
  );

  const regulatoryChunks = await db.query(
    chunkSql,
    ChunkRow,
    [dealId, REGULATORY_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "EntityManifest: FTS regulatory (Ofcom/ICO/CQC/NHS)" },
  );

  // ── Deduplicate and merge FTS results ──────────────────────────────
  // Merge order: primary → secondary → tertiary → regulatory.
  // Roster-density chunks are fetched separately in section 6b.
  const seen = new Set<string>();
  const allFtsChunks: z.infer<typeof ChunkRow>[] = [];
  for (const pool of [primaryChunks, secondaryChunks, tertiaryChunks, regulatoryChunks]) {
    for (const c of pool) {
      const key = `${c.document_id}:${c.chunk_index}`;
      if (!seen.has(key)) {
        seen.add(key);
        allFtsChunks.push(c);
      }
    }
  }

  // Cap at MAX_CONTEXT_CHARS
  let totalChars = 0;
  const contextChunks: z.infer<typeof ChunkRow>[] = [];
  const markerLen = 60; // approximate marker line length

  for (const c of allFtsChunks) {
    if (totalChars + c.content.length + markerLen > MAX_CONTEXT_CHARS) break;
    contextChunks.push(c);
    totalChars += c.content.length + markerLen;
  }

  if (contextChunks.length === 0) {
    return {
      stage: "build_entity_manifest",
      status: "failed",
      message: "No document chunks found for FTS retrieval. Check document_chunks and allowlist tags.",
    };
  }

  // ── 3. Build context string with doc markers ──────────────────────
  // Build a lookup of document_id → chunks (for fabrication gate later)
  const chunksByDocId = new Map<string, string[]>();
  const contextParts: string[] = [];

  for (const c of contextChunks) {
    const marker = `[DOC_ID: ${c.document_id} | FILE: ${c.file_name}]`;
    contextParts.push(`${marker}\n${c.content}`);

    if (!chunksByDocId.has(c.document_id)) {
      chunksByDocId.set(c.document_id, []);
    }
    chunksByDocId.get(c.document_id)!.push(c.content);
  }

  const contextBlock = contextParts.join("\n\n---\n\n");

  // ── 4. LLM call ──────────────────────────────────────────────────
  const systemPrompt = `You are an entity extraction specialist for M&A due diligence. Your task is to extract every named entity from the provided document extracts that a research analyst would need to investigate.

ENTITY TYPE DEFINITIONS:
- parent: The acquiring fund, sponsor, or holding company that is buying the target.
- target: The company being acquired (use full registered name).
- subsidiary: A company currently owned by the target group.
- acquired_entity: A company the target has acquired or is acquiring, named as a legal entity (typically ending Ltd, Limited). The group-structure appendix and acquisition history are the primary source. Emit EVERY named acquired trading entity individually as its own row. Do NOT summarise them as a count (e.g. do NOT emit "50 acquisitions" as one entity — emit each named entity separately).
- executive: A named individual in a leadership, board, or deal team role.
- customer: A specifically NAMED counterparty that buys from the target — a company or organisation name (e.g. "Whitley Stimpson Limited", "Celtic Leisure"). NOT a market segment, vertical, or customer class. "GP practices", "schools", "care homes", "SMEs", "Diamond customers" are END-MARKETS, not customers — do NOT emit these as customer entities. If the source only describes customers by segment or spend tier, emit NO customer entities rather than emitting the segment.
- competitor: A named company that competes with the target.
- regulator: A named government body or statutory authority with legal jurisdiction over the target's operations (e.g. Ofcom, ICO, CQC, NHS England), OR a named statutory regime the business is legally subject to. A procurement framework, a commercial supplier framework, a clinical IT system, or an integration partner is NOT a regulator. Do NOT classify advisers, banks, lenders, investors, bidders, or prior owners as regulators. If no named statutory regulator or regime appears verbatim in the source, emit NO regulator entities. An empty regulator set is the correct and expected output when the documents do not name regulators — do not substitute frameworks, systems, or deal parties to fill it.
- adviser: A professional services firm engaged on the transaction — financial/legal/commercial due diligence, investment banks, M&A advisers. Examples of the kind: a vendor DD accountant, a commercial DD consultancy, a sell-side bank.
- counterparty: A financing party, lender, investor, prior owner, or competing bidder connected to the deal but not a customer, competitor, or adviser.

RULES:
1. Extract entities of these types ONLY: ${ENTITY_TYPES.join(", ")}.
2. Every entity MUST include a verbatim_snippet — a short passage from the source text near where the entity name appears. This is advisory context only (the system will verify the entity name and extract the final snippet from source). Include enough surrounding text to show the entity in context.
3. source_document_id must be the exact DOC_ID from the marker line of the chunk where you found the entity.
4. For subsidiaries and acquired entities, include any stated EBITDA, revenue, acquisition year, or employee count in rank_signal as a JSON object (e.g. {"ebitda": "£2.1m", "year": "2019"}). Set rank_signal to null if no such data is present.
5. registration_number: company registration / incorporation number if stated, else null.
6. jurisdiction: country or jurisdiction of incorporation if stated, else null.
7. role: the entity's role in the deal context (e.g. "target parent", "trading subsidiary", "CEO", "key customer", "primary competitor").
8. For parent and target entities, legal_name MUST be the full registered company name as it appears in the source text (e.g. a name ending in Limited, Ltd, Holdings, plc), NOT a trading abbreviation or project shorthand. If only an abbreviation appears in the retrieved context, still copy it verbatim but set needs_registered_name to true in rank_signal (e.g. {"needs_registered_name": true}).
9. Do not invent entities. Every entity must be explicitly named in the text.
10. Do not duplicate — if the same entity appears in multiple chunks, emit it once with the best snippet.

Return ONLY a JSON array. No markdown, no explanation, no wrapper object.`;

  const userPrompt = `Extract all named entities from these due diligence document extracts:\n\n${contextBlock}`;

  const llmResult = await claude.apiRequest(
    {
      method: "POST",
      path: "/v1/messages",
      body: {
        model: MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
    },
    { response: AnthropicResponse },
    { label: "EntityManifest: extract entities" },
  );

  // ── 5. Parse LLM response ────────────────────────────────────────
  const textBlock = llmResult.content.find((c: any) => c.type === "text");
  if (!textBlock?.text) {
    return {
      stage: "build_entity_manifest",
      status: "failed",
      message: "LLM returned no text content.",
    };
  }

  let rawEntities: z.infer<typeof LlmEntity>[];
  try {
    // Strip markdown code fences if present (```json ... ```)
    let jsonText = textBlock.text.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const parsed = JSON.parse(jsonText);
    const arr = Array.isArray(parsed) ? parsed : parsed.entities ?? parsed.data ?? [];
    // Normalise field names: LLM sometimes returns "name" instead of "legal_name"
    rawEntities = arr.map((e: any) => {
      if (e.name && !e.legal_name) e.legal_name = e.name;
      return LlmEntity.parse(e);
    });
  } catch (err: any) {
    return {
      stage: "build_entity_manifest",
      status: "failed",
      message: `Failed to parse LLM JSON: ${err.message}. Raw head: ${textBlock.text.slice(0, 300)}`,
    };
  }

  // ── 6. FABRICATION GATE — name-anchored verification ────────────
  // The model's verbatim_snippet is advisory only. The gate verifies
  // each entity by searching for legal_name as an exact (case-insensitive,
  // word-boundary) substring across ALL retrieved chunks. If found, the
  // snippet is extracted from source in code (200-char centred window).
  // If the name is not found anywhere in retrieved context, the entity
  // is dropped — this keeps recalled-from-training names out.

  /** Build a word-boundary regex for a legal_name. */
  function buildNameRegex(name: string): RegExp {
    // Escape regex special characters in the name
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word-boundary anchors: \b works for alphanumeric boundaries.
    // For names starting/ending with non-word chars (e.g. parenthesised),
    // use a lookaround that accepts start/end of string or whitespace.
    return new RegExp(`(?:^|\\b|(?<=\\s))${escaped}(?:$|\\b|(?=\\s))`, "i");
  }

  /** Extract a ~200-char snippet centred on `matchIndex` from `text`. */
  function extractSnippet(text: string, matchIndex: number, nameLen: number): string {
    const WINDOW = 200;
    const pad = Math.max(0, Math.floor((WINDOW - nameLen) / 2));
    let start = Math.max(0, matchIndex - pad);
    let end = Math.min(text.length, matchIndex + nameLen + pad);
    // Extend to word boundaries to avoid mid-word cuts
    while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
    while (end < text.length && !/\s/.test(text[end]!)) end++;
    return text.slice(start, end).trim();
  }

  const survivors: z.infer<typeof LlmEntity>[] = [];
  const dropped: DroppedEntity[] = [];

  for (const entity of rawEntities) {
    // ── Check 1: entity_type validity ───────────────────────────────
    if (!ENTITY_TYPES.includes(entity.entity_type as any)) {
      dropped.push({
        legal_name: entity.legal_name,
        entity_type: entity.entity_type,
        source_document_id: entity.source_document_id,
        reason: `invalid entity_type '${entity.entity_type}'`,
      });
      continue;
    }

    // ── Check 2: cited document in retrieved context ────────────────
    if (!chunksByDocId.has(entity.source_document_id)) {
      dropped.push({
        legal_name: entity.legal_name,
        entity_type: entity.entity_type,
        source_document_id: entity.source_document_id,
        reason: `cited document not in retrieved context`,
      });
      continue;
    }

    // ── Check 3: name-anchored search across ALL retrieved chunks ───
    const nameRegex = buildNameRegex(entity.legal_name);
    let foundDocId: string | null = null;
    let foundSnippet: string | null = null;

    for (const chunk of contextChunks) {
      const match = nameRegex.exec(chunk.content);
      if (match) {
        foundDocId = chunk.document_id;
        foundSnippet = extractSnippet(chunk.content, match.index, entity.legal_name.length);
        break;
      }
    }

    if (!foundDocId || !foundSnippet) {
      dropped.push({
        legal_name: entity.legal_name,
        entity_type: entity.entity_type,
        source_document_id: entity.source_document_id,
        reason: `legal_name not present in any retrieved chunk`,
      });
      continue;
    }

    // ── Survivor: set source + code-extracted snippet ───────────────
    const sourceCorrected = foundDocId !== entity.source_document_id;
    entity.source_document_id = foundDocId;
    entity.verbatim_snippet = foundSnippet;

    if (sourceCorrected) {
      const existingSignal =
        entity.rank_signal && typeof entity.rank_signal === "object"
          ? { ...(entity.rank_signal as Record<string, unknown>) }
          : {};
      entity.rank_signal = {
        ...existingSignal,
        source_corrected: true,
      };
    }

    survivors.push(entity);
  }

  // ── 6b. ROSTER PASS — recover entity names from high-density company-name chunks ──
  // Dense roster chunks (org charts, company schedules, guarantor lists) contain
  // many company names that prose extraction misses because the names appear in
  // list/table form rather than narrative sentences. This pass identifies roster
  // chunks by a deal-agnostic structural signal: company-suffix token density
  // (count of Ltd/Limited/plc/PLC/Pty word-boundary tokens per chunk). Chunks
  // with high suffix density are entity rosters regardless of the deal. If no
  // chunk exceeds the minimum floor, the pass silently produces nothing.
  //
  // The signal follows the same tokenize-count-ratio pattern as
  // bss-chunk-quality.ts classifyTable (numeric-token ratio), applied here to
  // company-suffix tokens instead.

  // Minimum suffix count for a chunk to qualify as a roster candidate.
  // Calibrated: prose chunks typically have 0-5 suffix tokens; roster/schedule
  // chunks have 15+. Floor of 10 sits in the gap.
  const ROSTER_SUFFIX_FLOOR = 10;
  const ROSTER_MAX_CHUNKS = 6;

  // Fetch the top suffix-density chunks from consultant_report documents.
  // This is a direct SQL query — not FTS — so it does not depend on term overlap.
  // The suffix counting is done in Postgres via regexp_matches for efficiency,
  // then the top N are returned. No deal-specific strings anywhere.
  const RosterChunkRow = z.object({
    document_id: z.string(),
    chunk_index: z.coerce.number(),
    file_name: z.string(),
    content: z.string(),
    suffix_count: z.coerce.number(),
  });

  const rosterCandidates = await db.query(
    `SELECT dc.document_id,
            dc.chunk_index,
            dc.file_name,
            dc.content,
            (SELECT count(*)::int
               FROM regexp_matches(dc.content, '\\m(Ltd|Limited|plc|PLC|Pty)\\M', 'g')
            ) AS suffix_count
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
      WHERE dc.deal_id = $1::uuid
        AND d.deal_id  = $1::uuid
        AND d.document_tag = ANY($2::text[])
      ORDER BY suffix_count DESC
      LIMIT $3`,
    RosterChunkRow,
    [dealId, ALLOWLIST_TAGS, ROSTER_MAX_CHUNKS],
    { label: "EntityManifest: roster candidate fetch by suffix density" },
  );

  // Filter to chunks above the suffix floor
  const rosterChunks = rosterCandidates.filter(
    (c: z.infer<typeof RosterChunkRow>) => c.suffix_count >= ROSTER_SUFFIX_FLOOR,
  );

  // Merge roster chunks into contextChunks + chunksByDocId so the
  // fabrication gate can verify names against them.
  for (const rc of rosterChunks) {
    const key = `${rc.document_id}:${rc.chunk_index}`;
    if (!seen.has(key)) {
      seen.add(key);
      const chunkWithRank = { ...rc, rank: 0 };
      contextChunks.push(chunkWithRank);
      if (!chunksByDocId.has(rc.document_id)) {
        chunksByDocId.set(rc.document_id, []);
      }
      chunksByDocId.get(rc.document_id)!.push(rc.content);
    }
  }

  let appendixTokensIn = 0;
  let appendixTokensOut = 0;
  let appendixExtracted = 0;
  let appendixDropped = 0;

  if (rosterChunks.length > 0) {
    const rosterContext = rosterChunks
      .map((c: z.infer<typeof RosterChunkRow>) => `[DOC_ID: ${c.document_id} | FILE: ${c.file_name}]\n${c.content}`)
      .join("\n\n---\n\n");

    const rosterSystemPrompt = `You are an entity extraction specialist. The following text contains company roster sections — group-structure charts, company schedules, guarantor lists, or registration tables from due diligence documents.

Each distinct company name is a separate entity. Extract every distinct company name (typically ending Ltd, Limited, Pty Ltd, plc, or similar) as an acquired_entity.

These sections are lists or tables, not prose — do not expect sentences or "acquired" framing around each name. Each named company is its own entity.

RULES:
1. entity_type must be "acquired_entity" for every extracted entity.
2. legal_name must be the company name EXACTLY as it appears in the text. Copy character-for-character. Do not add or remove "Ltd"/"Limited".
3. source_document_id must be the exact DOC_ID from the marker line.
4. verbatim_snippet: a short passage from the text near where the name appears (advisory — system will verify).
5. role: brief description (e.g. "trading subsidiary", "group company", "guarantor entity").
6. registration_number: if a company registration number (typically a 6-8 digit number) appears adjacent to or paired with the entity name in the roster (e.g. in a table column, after a pipe, or in parentheses), capture it exactly. If no registration number is adjacent, set to null.
7. rank_signal: include any stated classification if apparent (e.g. {"category": "Direct BU"}), else null.
8. Do not include holding companies, topco/bidco/newco SPVs, or investment vehicles — only trading/operational entities. Indicators of non-trading entities: names containing "Holdings", "Investments", "Topco", "Bidco", "Newco", "EBT", or entities described as dormant/non-trading.
9. Do not include the parent group name itself.
10. Do not duplicate — emit each company once even if it appears in multiple places.

Return ONLY a JSON array. No markdown, no explanation.`;

    const rosterUserPrompt = `Extract all named trading entities from these company roster sections:\n\n${rosterContext}`;

    try {
      const appendixLlmResult = await claude.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: MODEL,
            max_tokens: 16384,
            system: rosterSystemPrompt,
            messages: [{ role: "user", content: rosterUserPrompt }],
          },
        },
        { response: AnthropicResponse },
        { label: "EntityManifest: roster pass entity extraction" },
      );

      appendixTokensIn = appendixLlmResult.usage.input_tokens;
      appendixTokensOut = appendixLlmResult.usage.output_tokens;

      const appendixTextBlock = appendixLlmResult.content.find((c: any) => c.type === "text");
      if (appendixTextBlock?.text) {
        let jsonText = appendixTextBlock.text.trim();
        if (jsonText.startsWith("```")) {
          jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
        }
        const parsed = JSON.parse(jsonText);
        const arr = Array.isArray(parsed) ? parsed : parsed.entities ?? parsed.data ?? [];
        const appendixEntities: z.infer<typeof LlmEntity>[] = arr.map((e: any) => {
          if (e.name && !e.legal_name) e.legal_name = e.name;
          return LlmEntity.parse(e);
        });

        // Dedup set: normalized keys already in survivors
        const existingNormKeys = new Set(
          survivors.map((s) => normalizeCompanyName(s.legal_name)),
        );

        for (const entity of appendixEntities) {
          appendixExtracted++;

          // Skip if already extracted in main pass (normalized match)
          if (existingNormKeys.has(normalizeCompanyName(entity.legal_name))) {
            continue;
          }

          // entity_type must be acquired_entity
          if (entity.entity_type !== "acquired_entity") {
            entity.entity_type = "acquired_entity";
          }

          // Run through the SAME fabrication gate
          const nameRegex = buildNameRegex(entity.legal_name);
          let foundDocId: string | null = null;
          let foundSnippet: string | null = null;

          for (const chunk of contextChunks) {
            const match = nameRegex.exec(chunk.content);
            if (match) {
              foundDocId = chunk.document_id;
              foundSnippet = extractSnippet(chunk.content, match.index, entity.legal_name.length);
              break;
            }
          }

          if (!foundDocId || !foundSnippet) {
            appendixDropped++;
            dropped.push({
              legal_name: entity.legal_name,
              entity_type: "acquired_entity",
              source_document_id: entity.source_document_id,
              reason: `roster pass: legal_name not present in any retrieved chunk`,
            });
            continue;
          }

          // Survivor — set source + code-extracted snippet
          const sourceCorrected = foundDocId !== entity.source_document_id;
          entity.source_document_id = foundDocId;
          entity.verbatim_snippet = foundSnippet;

          if (sourceCorrected) {
            const existingSignal =
              entity.rank_signal && typeof entity.rank_signal === "object"
                ? { ...(entity.rank_signal as Record<string, unknown>) }
                : {};
            entity.rank_signal = {
              ...existingSignal,
              source_corrected: true,
            };
          }

          // Tag as roster-pass-sourced for diagnostics
          const sig =
            entity.rank_signal && typeof entity.rank_signal === "object"
              ? { ...(entity.rank_signal as Record<string, unknown>) }
              : {};
          entity.rank_signal = { ...sig, roster_pass: true };

          survivors.push(entity);
          existingNormKeys.add(normalizeCompanyName(entity.legal_name));
        }
      }
    } catch (err: any) {
      // Non-fatal: roster pass failure should not block the main extraction
      dropped.push({
        legal_name: "[roster_pass_error]",
        entity_type: "acquired_entity",
        source_document_id: "",
        reason: `Roster LLM call failed: ${err.message?.slice(0, 200)}`,
      });
    }
  }

  // ── 6c. Name-normalization dedup (Layer 2) ─────────────────────────
  // Collapse suffix variants (Limited/Ltd/Ltd.) into one row per real
  // entity. Registration-number-aware: same-name + different non-null
  // reg numbers are kept as distinct rows and flagged for Family A.
  const beforeNormCount = survivors.length;
  let normCollapses = 0;
  let normConflictPairs = 0;

  {
    // Group survivors by normalized key
    const groups = new Map<
      string,
      z.infer<typeof LlmEntity>[]
    >();
    for (const s of survivors) {
      const key = normalizeCompanyName(s.legal_name);
      const arr = groups.get(key);
      if (arr) arr.push(s);
      else groups.set(key, [s]);
    }

    const deduped: z.infer<typeof LlmEntity>[] = [];

    for (const [normKey, group] of groups) {
      if (group.length === 1) {
        deduped.push(group[0]);
        continue;
      }

      // Partition by registration_number
      const byReg = new Map<string, z.infer<typeof LlmEntity>[]>();
      for (const e of group) {
        const regKey = e.registration_number ?? "";
        const arr = byReg.get(regKey);
        if (arr) arr.push(e);
        else byReg.set(regKey, [e]);
      }

      // Collect non-null distinct reg numbers
      const nonNullRegs = [...byReg.keys()].filter((k) => k !== "");

      if (nonNullRegs.length <= 1) {
        // Same or compatible reg numbers: collapse to one.
        // Prefer: row with reg number > row without; among those, longest legal_name.
        const sorted = [...group].sort((a, b) => {
          // Prefer non-null reg
          const aHasReg = a.registration_number ? 1 : 0;
          const bHasReg = b.registration_number ? 1 : 0;
          if (bHasReg !== aHasReg) return bHasReg - aHasReg;
          // Prefer longer legal_name (fuller form)
          return b.legal_name.length - a.legal_name.length;
        });
        deduped.push(sorted[0]);
        normCollapses += group.length - 1;
      } else {
        // Different non-null reg numbers: keep ALL rows, flag each.
        normConflictPairs++;
        for (const e of group) {
          const sig =
            e.rank_signal && typeof e.rank_signal === "object"
              ? { ...(e.rank_signal as Record<string, unknown>) }
              : {};
          e.rank_signal = { ...sig, name_reg_conflict: true };
          deduped.push(e);
        }
      }
    }

    // Replace survivors in-place
    survivors.length = 0;
    survivors.push(...deduped);
  }

  // ── 6d. LLM semantic dedup (acquired_entity only) ──────────────────
  // The deterministic Layer 2 catches suffix variants but cannot detect
  // semantic duplicates: acronym↔expansion (TIC Ltd = TIC (The Independent
  // Choice) Limited), or related trading names within the same group.
  // An LLM proposes groupings; code enforces that different non-null
  // registration numbers NEVER merge regardless of what the model says.
  const acquiredBefore = survivors.filter(
    (s) => s.entity_type === "acquired_entity",
  );
  const nonAcquired = survivors.filter(
    (s) => s.entity_type !== "acquired_entity",
  );

  let semanticMerges = 0;
  let semanticVetoes = 0;
  let semanticTokensIn = 0;
  let semanticTokensOut = 0;
  const semanticAliasMap: Record<string, string[]> = {};
  const semanticVetoLog: Array<{
    proposed_group: string[];
    blocked_pair: [string, string];
    regs: [string, string];
  }> = [];
  let semanticRawGroups: string[][] = [];

  if (acquiredBefore.length > 1) {
    // Build input: name + reg for the model
    const inputLines = acquiredBefore.map((e) => {
      const reg = e.registration_number ? ` [reg: ${e.registration_number}]` : "";
      return `- ${e.legal_name}${reg}`;
    });

    const semanticSystemPrompt = `You are an entity deduplication specialist for corporate group structures. The following are company names extracted from due diligence documents. Some may be the SAME underlying company appearing under different names — an acronym and its expansion (e.g. "TIC Ltd" and "TIC (The Independent Choice) Limited"), or closely related trading names within the same corporate group.

Group the names that refer to the same underlying company. Return a JSON array where each element is an array of the input company names (exactly as provided) that refer to one company. Names you are unsure about go in their own single-element group.

CRITICAL RULES:
1. Do NOT group companies merely because they share a word like "Southern", "Communications", "MPS", or "Pink". Only group when you are CONFIDENT they are the same legal entity.
2. Registration numbers in [reg: ...] are authoritative identifiers. If two names have DIFFERENT registration numbers, they are DIFFERENT companies even if the names look similar. Do NOT group them.
3. If two names have the SAME registration number, they are definitely the same company — group them.
4. Names without registration numbers can be grouped with a named entity if you are confident they refer to the same company (e.g. "GHM (NexusCare)" with "GHM Care Limited").
5. Copy names EXACTLY as provided — do not modify, abbreviate, or invent names.
6. Every input name must appear in exactly one group.

Return ONLY a JSON array of arrays. No markdown, no explanation.`;

    const semanticUserPrompt = `Group these company names by underlying entity:\n\n${inputLines.join("\n")}`;

    try {
      const semanticLlm = await claude.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: MODEL,
            max_tokens: 4096,
            system: semanticSystemPrompt,
            messages: [{ role: "user", content: semanticUserPrompt }],
          },
        },
        { response: AnthropicResponse },
        { label: "EntityManifest: semantic dedup acquired_entity" },
      );

      semanticTokensIn = semanticLlm.usage.input_tokens;
      semanticTokensOut = semanticLlm.usage.output_tokens;

      const semText = semanticLlm.content.find((c: any) => c.type === "text");
      if (semText?.text) {
        let semJson = semText.text.trim();
        if (semJson.startsWith("```")) {
          semJson = semJson
            .replace(/^```(?:json)?\s*\n?/, "")
            .replace(/\n?```\s*$/, "");
        }
        const proposedGroups: string[][] = JSON.parse(semJson);

        // Validate: only keep names that are in our input set
        const inputNameSet = new Set(acquiredBefore.map((e) => e.legal_name));
        const validGroups = proposedGroups
          .map((g: string[]) => g.filter((n: string) => inputNameSet.has(n)))
          .filter((g: string[]) => g.length > 0);

        semanticRawGroups = validGroups;

        // Build entity lookup by legal_name
        const entityByName = new Map<string, z.infer<typeof LlmEntity>>();
        for (const e of acquiredBefore) {
          entityByName.set(e.legal_name, e);
        }

        const mergedAcquired: z.infer<typeof LlmEntity>[] = [];
        const consumed = new Set<string>();

        for (const group of validGroups) {
          if (group.length === 1) {
            const ent = entityByName.get(group[0]);
            if (ent && !consumed.has(group[0])) {
              mergedAcquired.push(ent);
              consumed.add(group[0]);
            }
            continue;
          }

          // Multi-name group: apply reg-number veto
          // Collect all entities in this group
          const groupEntities = group
            .map((n: string) => entityByName.get(n))
            .filter((e): e is z.infer<typeof LlmEntity> => !!e && !consumed.has(e.legal_name));

          if (groupEntities.length === 0) continue;

          // Partition by registration_number
          const regBuckets = new Map<string, z.infer<typeof LlmEntity>[]>();
          for (const e of groupEntities) {
            const rk = e.registration_number ?? "";
            const arr = regBuckets.get(rk);
            if (arr) arr.push(e);
            else regBuckets.set(rk, [e]);
          }

          const nonNullRegKeys = [...regBuckets.keys()].filter((k) => k !== "");

          // Log vetoes: if model grouped entities with different non-null regs
          if (nonNullRegKeys.length > 1) {
            for (let i = 0; i < nonNullRegKeys.length; i++) {
              for (let j = i + 1; j < nonNullRegKeys.length; j++) {
                const nameA = regBuckets.get(nonNullRegKeys[i])![0].legal_name;
                const nameB = regBuckets.get(nonNullRegKeys[j])![0].legal_name;
                semanticVetoLog.push({
                  proposed_group: group,
                  blocked_pair: [nameA, nameB],
                  regs: [nonNullRegKeys[i], nonNullRegKeys[j]],
                });
                semanticVetoes++;
              }
            }
          }

          // Build mergeable subgroups: each unique non-null reg is its own
          // subgroup. Null-reg entities join the first non-null subgroup if
          // one exists; otherwise they form their own subgroup.
          const subgroups: z.infer<typeof LlmEntity>[][] = [];

          // Non-null reg subgroups first
          for (const rk of nonNullRegKeys) {
            subgroups.push(regBuckets.get(rk)!);
          }

          // Null-reg entities
          const nullRegEntities = regBuckets.get("") ?? [];
          if (nullRegEntities.length > 0) {
            if (subgroups.length > 0) {
              // Attach null-reg entities to the first non-null subgroup
              subgroups[0].push(...nullRegEntities);
            } else {
              // All null-reg: form one subgroup
              subgroups.push(nullRegEntities);
            }
          }

          // Merge each subgroup: keep fullest record, record aliases
          for (const sub of subgroups) {
            const sorted = [...sub].sort((a, b) => {
              const aHasReg = a.registration_number ? 1 : 0;
              const bHasReg = b.registration_number ? 1 : 0;
              if (bHasReg !== aHasReg) return bHasReg - aHasReg;
              return b.legal_name.length - a.legal_name.length;
            });

            const winner = sorted[0];
            const aliases = sorted.slice(1).map((e) => e.legal_name);

            if (aliases.length > 0) {
              const sig =
                winner.rank_signal && typeof winner.rank_signal === "object"
                  ? { ...(winner.rank_signal as Record<string, unknown>) }
                  : {};
              sig.merged_aliases = aliases;
              winner.rank_signal = sig;
              semanticMerges += aliases.length;
              semanticAliasMap[winner.legal_name] = aliases;
            }

            mergedAcquired.push(winner);
            for (const e of sorted) consumed.add(e.legal_name);
          }
        }

        // Any input entity not consumed by valid groups (model dropped it)
        for (const e of acquiredBefore) {
          if (!consumed.has(e.legal_name)) {
            mergedAcquired.push(e);
          }
        }

        // Replace survivors
        survivors.length = 0;
        survivors.push(...nonAcquired, ...mergedAcquired);
      }
    } catch (err: any) {
      // Non-fatal: semantic dedup failure leaves Layer 2 result intact
      survivors.length = 0;
      survivors.push(...nonAcquired, ...acquiredBefore);
    }
  }

  // ── 7. Insert surviving entities ──────────────────────────────────
  if (survivors.length > 0) {
    // Build batch INSERT
    const valueClauses: string[] = [];
    const params: unknown[] = [runId]; // $1 = runId
    let paramIdx = 2;

    for (const e of survivors) {
      valueClauses.push(
        `($1, $${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6})`,
      );
      params.push(
        e.entity_type,
        e.legal_name,
        e.registration_number ?? null,
        e.jurisdiction ?? null,
        e.role ?? null,
        e.source_document_id,
        e.verbatim_snippet,
      );
      paramIdx += 7;
    }

    // rank_signal in a second pass to keep param indexing clean
    // Actually, include rank_signal in the INSERT. Re-build.
    const valueClauses2: string[] = [];
    const params2: unknown[] = [runId]; // $1 = runId
    let pIdx = 2;

    for (const e of survivors) {
      valueClauses2.push(
        `($1, $${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}::jsonb)`,
      );
      params2.push(
        e.entity_type,
        e.legal_name,
        e.registration_number ?? null,
        e.jurisdiction ?? null,
        e.role ?? null,
        e.source_document_id,
        e.verbatim_snippet,
        e.rank_signal ? JSON.stringify(e.rank_signal) : null,
      );
      pIdx += 8;
    }

    await db.execute(
      `INSERT INTO ero_entities
         (run_id, entity_type, legal_name, registration_number,
          jurisdiction, role, source_document_id, verbatim_snippet, rank_signal)
       VALUES ${valueClauses2.join(", ")}
       ON CONFLICT (run_id, entity_type, legal_name) DO NOTHING`,
      params2,
      { label: `EntityManifest: insert ${survivors.length} entities` },
    );
  }

  // ── 8. Build summary ─────────────────────────────────────────────
  const byType: Record<string, number> = {};
  for (const e of survivors) {
    byType[e.entity_type] = (byType[e.entity_type] || 0) + 1;
  }
  const breakdown = Object.entries(byType)
    .map(([t, n]) => `${t}:${n}`)
    .join(", ");

  const messageParts = [
    `${survivors.length} entities inserted`,
    `${dropped.length} dropped`,
    `breakdown: ${breakdown || "none"}`,
    `context: ${contextChunks.length} chunks / ${totalChars} chars`,
    `tokens: in=${llmResult.usage.input_tokens} out=${llmResult.usage.output_tokens}`,
  ];
  if (rosterChunks.length > 0) {
    messageParts.push(
      `roster: ${rosterChunks.length} chunks (suffix≥${ROSTER_SUFFIX_FLOOR}), ${appendixExtracted} extracted, ${appendixDropped} dropped, tokens: in=${appendixTokensIn} out=${appendixTokensOut}`,
    );
  }
  if (normCollapses > 0 || normConflictPairs > 0) {
    messageParts.push(
      `norm: ${beforeNormCount}->${beforeNormCount - normCollapses} (${normCollapses} collapsed, ${normConflictPairs} conflict groups kept)`,
    );
  }
  if (semanticMerges > 0 || semanticVetoes > 0) {
    const acquiredAfter = survivors.filter(
      (s) => s.entity_type === "acquired_entity",
    ).length;
    messageParts.push(
      `semantic: ${acquiredBefore.length}->${acquiredAfter} (${semanticMerges} merged, ${semanticVetoes} reg-vetoed, tokens: in=${semanticTokensIn} out=${semanticTokensOut})`,
    );
  }
  const message = messageParts.join(" | ");

  const semanticDedup = {
    rawGroups: semanticRawGroups,
    vetoes: semanticVetoLog,
    aliasMap: semanticAliasMap,
    merges: semanticMerges,
    vetoeCount: semanticVetoes,
    acquiredBefore: acquiredBefore.length,
    acquiredAfter: survivors.filter(
      (s) => s.entity_type === "acquired_entity",
    ).length,
  };

  return {
    stage: "build_entity_manifest",
    status: "complete",
    message,
    stageData: {
      dropped,
      semanticDedup,
    },
  };
}

// Re-export types the test harness needs
export type { DroppedEntity };
export { EntityRow, ALLOWLIST_TAGS };
