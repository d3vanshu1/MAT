/**
 * ERO v2 — Check-family configuration
 *
 * Nine families that drive hypothesis generation. Each family declares
 * its source (entity-sourced or profile-sourced), which entity_types or
 * profile fields feed it, and prompt guidance for what a good hypothesis
 * in that family looks like.
 *
 * No deal-specific strings — families are general. The entities and
 * profile fields that flow through them are deal-specific.
 */

// ── Source types ────────────────────────────────────────────────────
export type EntitySource = {
  kind: "entity";
  /** Entity types from the manifest that feed this family */
  entityTypes: string[];
};

export type ProfileSource = {
  kind: "profile";
  /** field_group + field_name combinations from ero_profile */
  profileFields: {
    fieldGroup: "business_shape" | "thesis_dependency";
    fieldNames: string[];
  }[];
};

export type FamilySource = EntitySource | ProfileSource | {
  kind: "entity_and_profile";
  entityTypes: string[];
  profileFields: {
    fieldGroup: "business_shape" | "thesis_dependency";
    fieldNames: string[];
  }[];
};

// ── Family definition ───────────────────────────────────────────────
export interface CheckFamily {
  id: string;
  name: string;
  source: FamilySource;
  /** Prompt guidance: what does a good hypothesis in this family look like? */
  guidance: string;
  /**
   * Deterministic ranking weight (1–10). Higher = researched earlier.
   * Used by rank_hypotheses as signal 2 (family importance).
   * NOT deal-specific — general config.
   */
  family_weight: number;
}

// ── The nine families ───────────────────────────────────────────────
export const ERO_FAMILIES: CheckFamily[] = [
  {
    id: "corporate_record",
    name: "Corporate Record",
    family_weight: 9,
    source: {
      kind: "entity",
      entityTypes: ["target", "subsidiary", "acquired_entity"],
    },
    guidance: `Generate hypotheses about the corporate record and filing history of each entity.
Good hypotheses:
- Has [Entity] filed annual accounts on time with Companies House for the past 3 years?
- Are there any charges registered against [Entity] that remain outstanding?
- Has [Entity] changed its registered address or officers in the 12 months preceding the transaction?
Each hypothesis should name the specific entity and target a verifiable public record.`,
  },
  {
    id: "litigation_enforcement",
    name: "Litigation & Enforcement",
    family_weight: 7,
    source: {
      kind: "entity",
      entityTypes: ["target", "subsidiary", "acquired_entity", "executive"],
    },
    guidance: `Generate hypotheses about litigation, enforcement actions, or legal proceedings involving each entity or executive.
Good hypotheses:
- Has [Entity] been party to any county court judgments (CCJs) or tribunal proceedings in the past 5 years?
- Has [Executive] been a director of a company that entered insolvency or administration?
- Are there any outstanding enforcement actions or regulatory sanctions against [Entity]?
Each hypothesis should name the specific entity or person and specify a verifiable legal or regulatory record.`,
  },
  {
    id: "regulatory",
    name: "Regulatory",
    family_weight: 9,
    source: {
      kind: "profile",
      profileFields: [
        { fieldGroup: "business_shape", fieldNames: ["sector", "geography", "end_markets"] },
      ],
    },
    guidance: `Generate hypotheses about the regulatory regime(s) applicable to the target's sector and geography.
This family is PROFILE-SOURCED: the entity manifest may have no regulator rows. Derive regulators from the sector/geography fields.
For each applicable regulator or regulatory framework, generate a hypothesis:
- Does [Regulator] have any open investigations or enforcement actions against the target group?
- Has the target's operating licence with [Regulator] been subject to conditions, warnings, or revocation proceedings?
- Are there scheduled regulatory transitions (e.g. technology sunset mandates, licence regime changes) that affect the target's service delivery model?
Name specific regulators implied by the sector (e.g. communications → Ofcom; health/care services → CQC, NHS England; data processing → ICO; financial services → FCA).
Each hypothesis must name a specific regulator or regulatory regime, not generic "regulatory risk".`,
  },
  {
    id: "customer_counterparty",
    name: "Customer & Counterparty",
    family_weight: 8,
    source: {
      kind: "entity",
      entityTypes: ["counterparty", "customer"],
    },
    guidance: `Generate hypotheses about the financial health, creditworthiness, and relationship stability of key counterparties and customers.
Good hypotheses:
- Has [Counterparty] filed accounts showing declining revenue or negative working capital in the past 2 years?
- Has [Counterparty] been subject to any insolvency proceedings, CVAs, or winding-up petitions?
- Is the target's revenue concentration with [Counterparty] above 10% of total revenue?
Each hypothesis should name the specific counterparty or customer.`,
  },
  {
    id: "competitive",
    name: "Competitive",
    family_weight: 6,
    source: {
      kind: "entity",
      entityTypes: ["competitor"],
    },
    guidance: `Generate hypotheses about competitive dynamics and market position threats from named competitors.
Good hypotheses:
- Has [Competitor] publicly announced expansion into the target's core geographic markets in the past 18 months?
- Has [Competitor] acquired businesses in the same sector that would increase its market share relative to the target?
- Is [Competitor] offering materially lower pricing or superior technology that threatens the target's customer retention?
Each hypothesis should name the specific competitor.`,
  },
  {
    id: "technology_platform",
    name: "Technology & Platform",
    family_weight: 5,
    source: {
      kind: "entity",
      entityTypes: ["acquired_entity"],
    },
    guidance: `Generate hypotheses about the technology platforms and products of acquired entities.
Good hypotheses:
- Is [Acquired Entity]'s core product built on technology that is approaching end-of-life or has a scheduled vendor sunset?
- Has [Acquired Entity] experienced publicly reported service outages, security breaches, or data loss incidents?
- Does [Acquired Entity]'s product have a dependency on a third-party platform whose pricing or terms have materially changed?
Each hypothesis should name the specific acquired entity and its product/platform where known.`,
  },
  {
    id: "management_record",
    name: "Management Record",
    family_weight: 5,
    source: {
      kind: "entity",
      entityTypes: ["executive"],
    },
    guidance: `Generate hypotheses about the track record, directorships, and potential conflicts of key executives.
Good hypotheses:
- Has [Executive] been a director of a company that entered administration, liquidation, or CVA?
- Does [Executive] hold concurrent directorships that could represent a conflict of interest with the target?
- Has [Executive] been subject to director disqualification proceedings or regulatory sanctions?
Each hypothesis should name the specific executive.`,
  },
  {
    id: "macro",
    name: "Macro & Sector",
    family_weight: 2,
    source: {
      kind: "profile",
      profileFields: [
        { fieldGroup: "business_shape", fieldNames: ["sector", "geography", "end_markets"] },
        { fieldGroup: "thesis_dependency", fieldNames: [] },  // all thesis_dependency fields
      ],
    },
    guidance: `Generate a NARROW set of macro hypotheses directly relevant to the target's sector and thesis dependencies.
This family is PROFILE-SOURCED. Generate only hypotheses where the macro factor directly threatens a stated thesis dependency.
Good hypotheses:
- Is the sector's organic growth rate declining below the rate assumed in the investment thesis?
- Are there pending legislative or policy changes that would materially affect the target's addressable market?
- Has the sector experienced consolidation that reduces the target's future M&A pipeline?
Keep this family narrow — 2-4 hypotheses maximum, each tied to a specific thesis dependency. Do NOT generate generic macroeconomic commentary.`,
  },
  {
    id: "valuation",
    name: "Valuation & Acquisition Programme",
    family_weight: 10,
    source: {
      kind: "entity_and_profile",
      entityTypes: ["acquired_entity"],
      profileFields: [
        { fieldGroup: "thesis_dependency", fieldNames: [] },  // all thesis_dependency fields
      ],
    },
    guidance: `Generate hypotheses about the valuation, acquisition programme, and post-acquisition performance.
This family uses BOTH entity and profile sources:
- Entity source: the named acquired_entity platforms for entity-level acquisition-multiple checks.
- Profile source: thesis_dependency fields for programme-level assertions (e.g. blended multiple, deal count, organic vs acquired growth).

Programme-level hypotheses (from thesis_dependency, entity_id = null):
- Does the stated blended acquisition multiple withstand verification against public filings for the named platforms?
- Is post-acquisition revenue performance of the named platforms consistent with the organic growth claims in the thesis?

Entity-level hypotheses (from acquired_entity rows):
- What was the reported or inferrable acquisition multiple for [Acquired Entity] based on Companies House filings?
- Has [Acquired Entity] shown revenue growth or decline in its filed accounts since acquisition?

CRITICAL: Always generate at least one programme-level hypothesis targeting the blended acquisition multiple and post-acquisition performance, referencing the named platforms available in the entity manifest.`,
  },
];

// ── Lookup helper ───────────────────────────────────────────────────
export function getFamilyById(id: string): CheckFamily | undefined {
  return ERO_FAMILIES.find((f) => f.id === id);
}
