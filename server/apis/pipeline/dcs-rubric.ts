/**
 * DCS Rubric — constants and pure functions for Diligence Completeness Scoring.
 *
 * DESIGN INVARIANT: scoring is source-class based, not depth based.
 * The IC memo and CIM can never promote a dimension to "evidenced" because
 * they are the subject being audited — their claims are assertions, not
 * independent evidence. Only work-product documents (consultant reports,
 * legal analyses, financial models, customer data) can promote.
 *
 * All arithmetic in this module is performed in code and never by a
 * language model. The model's role is limited to extraction (which
 * chunks mention which dimensions, whether substantively). Scoring
 * is deterministic from that point forward.
 *
 * HARD CONSTRAINT: this file performs NO I/O. It must not import the
 * database integration, the Anthropic integration, or the Superblocks
 * api helper. It is constants and pure functions only. This is what
 * makes the scoring independently testable.
 */

// ═══════════════════════════════════════════════════════════════════
// 1. DCS_DIMENSIONS — the 10 standard PE diligence dimensions
//    Descriptions verbatim from analyze-chunk.ts lines 322–331.
// ═══════════════════════════════════════════════════════════════════

export interface DcsDimension {
  id: string;
  label: string;
  description: string;
  anchors: string[];
}

export const DCS_DIMENSIONS: readonly DcsDimension[] = [
  {
    id: "commercial",
    label: "Commercial",
    description:
      "Market size, competitive position, customer value proposition, go-to-market",
    anchors: ["market size", "competitive position", "value proposition", "go-to-market"],
  },
  {
    id: "financial_qoe",
    label: "Financial/QoE",
    description:
      "Revenue quality, EBITDA adjustments, working capital, cash conversion",
    anchors: ["revenue quality", "EBITDA adjustments", "working capital", "cash conversion"],
  },
  {
    id: "management",
    label: "Management",
    description:
      "Team depth, track record, incentive alignment, succession planning",
    anchors: ["team depth", "track record", "incentive alignment", "succession planning"],
  },
  {
    id: "technology_product",
    label: "Technology/Product",
    description:
      "Product differentiation, tech stack, IP protection, R&D pipeline",
    anchors: ["product differentiation", "tech stack", "IP protection", "R&D pipeline"],
  },
  {
    id: "legal_regulatory",
    label: "Legal/Regulatory",
    description:
      "Compliance status, pending litigation, regulatory risk, contract quality",
    anchors: ["compliance", "litigation", "regulatory risk", "contract quality"],
  },
  {
    id: "competitive",
    label: "Competitive",
    description:
      "Market share, competitive moats, barriers to entry, disruption risk",
    anchors: ["market share", "competitive moats", "barriers to entry", "disruption risk"],
  },
  {
    id: "customer",
    label: "Customer",
    description:
      "Concentration, retention, satisfaction, contract terms, switching costs",
    anchors: ["concentration", "retention", "satisfaction", "contract terms", "switching costs"],
  },
  {
    id: "operational",
    label: "Operational",
    description:
      "Scalability, key processes, supply chain, operational risk",
    anchors: ["scalability", "key processes", "supply chain", "operational risk"],
  },
  {
    id: "exit",
    label: "Exit",
    description:
      "Comparable transactions, buyer universe, exit timing, value creation narrative",
    anchors: ["comparable transactions", "buyer universe", "exit timing", "value creation"],
  },
  {
    id: "esg_reputational",
    label: "ESG/Reputational",
    description:
      "Environmental compliance, social factors, governance, reputational risk",
    anchors: ["environmental", "social factors", "governance", "reputational risk"],
  },
] as const;

// ═══════════════════════════════════════════════════════════════════
// 2. DOC_CLASS_BY_TAG — document source classification
//    narrative = subject being audited (IC memo, CIM)
//    workproduct = independent evidence (consultant reports, etc.)
// ═══════════════════════════════════════════════════════════════════

export type DocClass = "narrative" | "workproduct";

export const DOC_CLASS_BY_TAG: Record<string, DocClass> = {
  ic_memo: "narrative",
  cim: "narrative",
  consultant_report: "workproduct",
  legal: "workproduct",
  customer_data: "workproduct",
  financial_model: "workproduct",
  other: "narrative",
};

// ═══════════════════════════════════════════════════════════════════
// 3. classifyDocClass — pure lookup with fail-closed default
//    Unknown or missing tags → 'narrative'. An unclassified document
//    must never promote a dimension to evidenced.
// ═══════════════════════════════════════════════════════════════════

export function classifyDocClass(tag: string | null | undefined): DocClass {
  if (!tag) return "narrative";
  return DOC_CLASS_BY_TAG[tag.toLowerCase()] ?? "narrative";
}

// ═══════════════════════════════════════════════════════════════════
// 4. SCORE_VALUES — deterministic numeric mapping
// ═══════════════════════════════════════════════════════════════════

export const SCORE_VALUES = {
  absent: 0,
  asserted: 0.5,
  evidenced: 1.0,
} as const;

export type DimensionState = keyof typeof SCORE_VALUES;

// ═══════════════════════════════════════════════════════════════════
// 5. computeDimensionState — pure, no database access
//    Given evidence rows for ONE dimension, determine the state.
//
//    absent    → no rows at all
//    evidenced → at least one workproduct row that is substantive
//    asserted  → everything else (has rows, but none qualify)
// ═══════════════════════════════════════════════════════════════════

export interface EvidenceInput {
  doc_class: DocClass;
  is_substantive: boolean;
}

export function computeDimensionState(rows: EvidenceInput[]): DimensionState {
  if (rows.length === 0) return "absent";

  const hasWorkproductSubstantive = rows.some(
    (r) => r.doc_class === "workproduct" && r.is_substantive,
  );

  return hasWorkproductSubstantive ? "evidenced" : "asserted";
}

// ═══════════════════════════════════════════════════════════════════
// 6. computeHeadlineScore — pure, no database access
//    sum(score_value) * 10 / count, rounded to 1 decimal place.
//    Returns the 0–10 headline score.
// ═══════════════════════════════════════════════════════════════════

export interface VerdictInput {
  score_value: number;
}

export function computeHeadlineScore(verdicts: VerdictInput[]): number {
  if (verdicts.length === 0) return 0;

  const sum = verdicts.reduce((acc, v) => acc + v.score_value, 0);
  const raw = (sum * 10) / verdicts.length;

  return Math.round(raw * 10) / 10;
}
