/**
 * oa-taxonomy.ts — Seeded topic spine for the OA rebuild.
 *
 * Pure constants. No DB access, no LLM calls, no side effects.
 * 47 seeded topics across 4 obligation classes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const OBLIGATION_CHECKLIST_VERSION = "v1.1.0";

export type ObligationClass =
  | "required"
  | "conditional"
  | "optional"
  | "not_memo_relevant";

export interface SeededTopic {
  topic_id: string;
  topic_label: string;
  obligation_class: ObligationClass;
  obligation_basis: string;
  parent_topic_id: string | null;
}

// ---------------------------------------------------------------------------
// Seeded Topics (47 total: 21 required, 16 conditional, 5 optional, 5 excluded)
// ---------------------------------------------------------------------------

export const SEEDED_TOPICS: SeededTopic[] = [
  // ─── REQUIRED (21) ─────────────────────────────────────────────────────
  { topic_id: "deal.structure",            topic_label: "Deal structure, sources & uses",           obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "deal.price-mechanism",      topic_label: "Price, earn-out, contingent consideration", obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "deal.financing",            topic_label: "Debt quantum, terms, covenants",          obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "valuation.entry-multiple",  topic_label: "Entry multiple and basis",                obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "valuation.exit-assumptions", topic_label: "Exit multiple assumptions",              obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "returns.base-case",         topic_label: "Base case IRR / MoM",                     obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "returns.downside",          topic_label: "Downside / delayed-exit scenario",        obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "returns.sensitivity",       topic_label: "Sensitivity analysis",                    obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "revenue-quality.recurring", topic_label: "Recurring revenue proportion",            obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "revenue-quality.churn",     topic_label: "Churn / retention",                       obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "revenue-quality.nrr-grr",   topic_label: "NRR / GRR",                              obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "revenue-quality.concentration", topic_label: "Customer concentration",              obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "growth.organic-inorganic",  topic_label: "Organic vs acquisition split",            obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "growth.drivers",            topic_label: "Growth drivers and plan bridge",          obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "margin.sustainability",     topic_label: "Margin trajectory and pressure",          obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "mgmt.team",                 topic_label: "Management team, roll, retention",        obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "mgmt.key-person",           topic_label: "Key person risk",                         obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "risk.legal-material",       topic_label: "Material legal / litigation exposure",    obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "risk.regulatory",           topic_label: "Regulatory exposure",                     obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "risk.customer-contract",    topic_label: "Change-of-control / termination risk",    obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },
  { topic_id: "dd.coverage",               topic_label: "Diligence scope and open items",          obligation_class: "required", obligation_basis: "IC memo must address", parent_topic_id: null },

  // ─── CONDITIONAL (16) ──────────────────────────────────────────────────
  { topic_id: "tech.debt",                 topic_label: "Technical debt",                          obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "tech.ip-ownership",         topic_label: "IP ownership and protection",             obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "esg.material",              topic_label: "Material ESG considerations",             obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "tax.structure",             topic_label: "Tax structure and exposure",              obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "pension.liability",         topic_label: "Pension liability",                       obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "integration.track-record",  topic_label: "Integration track record",               obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "supplier.concentration",    topic_label: "Supplier concentration",                  obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "working-capital",           topic_label: "Working capital requirements",            obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "capex.requirements",        topic_label: "Capital expenditure requirements",        obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "fx.exposure",              topic_label: "Foreign exchange exposure",                obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "insurance.coverage",        topic_label: "Insurance coverage adequacy",             obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "data-protection",           topic_label: "Data protection and privacy",             obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "employment.material",       topic_label: "Material employment matters",             obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "property.leases",           topic_label: "Property and lease obligations",          obligation_class: "conditional", obligation_basis: "Required if reference set carries material content", parent_topic_id: null },
  { topic_id: "acquisition.historic-terms", topic_label: "Terms of Group's prior acquisitions — warranties, earn-outs, consideration", obligation_class: "conditional", obligation_basis: "Required if reference set shows material unresolved exposure from prior M&A", parent_topic_id: null },
  { topic_id: "partner.channel-agreements", topic_label: "Dealer, reseller and channel partner agreements", obligation_class: "conditional", obligation_basis: "Required if channel is a material route to market", parent_topic_id: null },

  // ─── OPTIONAL (5) ──────────────────────────────────────────────────────
  { topic_id: "market.tam",                topic_label: "Total addressable market",                obligation_class: "optional", obligation_basis: "Surfaced only at Tier 3", parent_topic_id: null },
  { topic_id: "competitive.landscape",     topic_label: "Competitive landscape",                   obligation_class: "optional", obligation_basis: "Surfaced only at Tier 3", parent_topic_id: null },
  { topic_id: "brand",                     topic_label: "Brand strength and recognition",          obligation_class: "optional", obligation_basis: "Surfaced only at Tier 3", parent_topic_id: null },
  { topic_id: "culture",                   topic_label: "Organisational culture",                  obligation_class: "optional", obligation_basis: "Surfaced only at Tier 3", parent_topic_id: null },
  { topic_id: "nps-csat",                  topic_label: "NPS / CSAT scores",                       obligation_class: "optional", obligation_basis: "Surfaced only at Tier 3", parent_topic_id: null },

  // ─── NOT MEMO RELEVANT (5) ────────────────────────────────────────────
  { topic_id: "adviser.methodology",       topic_label: "Adviser methodology description",         obligation_class: "not_memo_relevant", obligation_basis: "Never compared", parent_topic_id: null },
  { topic_id: "adviser.scope-limitations", topic_label: "Adviser scope limitations",               obligation_class: "not_memo_relevant", obligation_basis: "Never compared", parent_topic_id: null },
  { topic_id: "adviser.boilerplate",       topic_label: "Adviser boilerplate and disclaimers",     obligation_class: "not_memo_relevant", obligation_basis: "Never compared", parent_topic_id: null },
  { topic_id: "document.formatting",       topic_label: "Document formatting and structure",       obligation_class: "not_memo_relevant", obligation_basis: "Never compared", parent_topic_id: null },
  { topic_id: "entity.corporate-structure", topic_label: "Corporate structure, share capital, registration, addresses, corporate history", obligation_class: "not_memo_relevant", obligation_basis: "Group corporate hygiene; not an IC memo disclosure obligation", parent_topic_id: null },
];

// ---------------------------------------------------------------------------
// Derived exports
// ---------------------------------------------------------------------------

const _topicMap = new Map<string, SeededTopic>();
for (const t of SEEDED_TOPICS) {
  _topicMap.set(t.topic_id, t);
}

/** Retrieve a seeded topic by ID, or undefined if not seeded. */
export function getSeededTopic(id: string): SeededTopic | undefined {
  return _topicMap.get(id);
}

/** Returns true if the given ID belongs to the seeded taxonomy. */
export function isSeededTopic(id: string): boolean {
  return _topicMap.has(id);
}

/** All topic IDs with obligation_class = 'required'. Derived from SEEDED_TOPICS. */
export const REQUIRED_TOPIC_IDS: string[] = SEEDED_TOPICS
  .filter(t => t.obligation_class === "required")
  .map(t => t.topic_id);
