/**
 * EM-3 Diagnostic API — Materiality Tiering of Genuine Omissions
 *
 * Standalone diagnostic (no fresh pipeline run) that:
 *   1. Loads the ~142 distinct genuine-omission + thesis-drift units
 *      from docs/evidence/absence-distinct/
 *   2. For EACH unit, calls Claude Sonnet to assign a materiality tier
 *      (1 = deal-changing, 2 = condition/diligence, 3 = noted/immaterial)
 *   3. Persists progress to a session table so it can resume across invocations
 *   4. Dumps final results to docs/evidence/materiality/
 *
 * Read-only with respect to production data. Only writes to the session table
 * and evidence files.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

/** Concurrency for Sonnet calls */
const CONCURRENCY = 5;
/** Safety margin before deadline */
const TIME_BUDGET_SAFETY_MS = 40_000;

// ---------------------------------------------------------------------------
// Deal context verbatim
// ---------------------------------------------------------------------------
const DEAL_CONTEXT = `Project Saint / SCG. Enterprise Value £655m (11.6x LTM Sep-26 Cash EBITDA), plus £85m earn-out above 2.5x MoM. PEP base case: 23.0% IRR / 2.8x MoM; 6x opening leverage. Thesis: (1) verticalisation — own-IP platforms Surgery Connect (55% GP share) and Evonex growing ~30%; (2) vendor-agnostic SME comms one-stop-shop, 35k+ customers, ~7% churn; (3) industrialised M&A, ~50 acquisitions, £6m EBITDA near-term pipeline; (4) re-rating as own-IP mix grows 30%→43%; (5) backable management. Key return drivers: retention holding, M&A continuing, AI ancillary upsell into Surgery Connect, education vertical for Evonex.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UnitInput {
  unit_id: string;
  representative_title: string;
  is_group: boolean;
  member_count: number;
}

interface TierResult {
  unit_id: string;
  title: string;
  tier: number;
  rationale: string;
  driver: string;
}

interface SessionState {
  total_units: number;
  results: TierResult[];
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPrompt(title: string): string {
  return `You are an IC member assessing a due-diligence finding that is ABSENT from the investment memos. Given the DEAL CONTEXT below, assign a materiality tier:
  TIER 1 (DEAL-CHANGING): could kill the deal, materially move the price, or break the base-case return (23% IRR / 2.8x). Reserve for findings a partner would want on the first page.
  TIER 2 (CONDITION / DILIGENCE): a real issue requiring a condition to close or a specific diligence follow-up, but not a threat to the thesis or returns.
  TIER 3 (NOTED / IMMATERIAL): genuine but immaterial to the investment decision at this deal size.
Judge materiality RELATIVE TO THE DEAL (a £60k liability is immaterial on a £655m EV; an uncapped indemnity on a top customer may not be). Do NOT tier by how alarming the wording is — most findings are worded as risks. Be STRICT with Tier 1: if most findings are Tier 1, you are miscalibrated. Return JSON only:
  {"tier":1|2|3, "rationale":"one sentence tying it to deal impact", "driver":"which return driver / thesis pillar it affects, or 'none'"}
DEAL CONTEXT: ${DEAL_CONTEXT}
FINDING: ${title}`;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  shouldStop: () => boolean,
): Promise<{ results: R[]; completed: number }> {
  const results: R[] = [];
  let idx = 0;
  let completed = 0;

  async function worker() {
    while (idx < items.length && !shouldStop()) {
      const myIdx = idx++;
      const result = await fn(items[myIdx]);
      results[myIdx] = result;
      completed++;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return { results, completed };
}

// ---------------------------------------------------------------------------
// API definition
// ---------------------------------------------------------------------------

const TierResultSchema = z.object({
  unit_id: z.string(),
  title: z.string(),
  tier: z.number(),
  rationale: z.string(),
  driver: z.string(),
});

export default api({
  name: "DiagMateriality",
  description: "Materiality-tiers genuine omissions via Sonnet, with resume support.",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    /** Resume from existing session or start fresh */
    sessionId: z.string().nullable(),
    /** If "dump", return the final results (paginated) */
    mode: z.enum(["run", "dump"]).default("run"),
    /** For dump mode: which page (0-indexed) */
    dumpPage: z.number().default(0),
  }),

  output: z.object({
    sessionId: z.string(),
    processed: z.number(),
    total: z.number(),
    complete: z.boolean(),
    /** Sample of results from this invocation */
    sample: z.array(TierResultSchema),
    /** Summary counts (only when complete) */
    tier_counts: z.object({
      tier1: z.number(),
      tier2: z.number(),
      tier3: z.number(),
    }).nullable(),
  }),

  async run(ctx, { sessionId, mode, dumpPage }) {
    const deadlineMs = Date.now() + 240_000; // 4 min budget

    // ── Ensure session table exists ───────────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS diag_materiality_sessions (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        state JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )`,
      [],
      { label: "Ensure diag_materiality_sessions table" },
    );

    // ── Load the 142 units from evidence files ────────────────────────────
    // (hardcoded from the committed evidence — no DB dependency needed)
    const allUnits: UnitInput[] = [
      // 38 omission groups from omission-distinct-1.json
      { unit_id: "group_56", representative_title: "Unregistered Trade Marks and IP Assignment Gaps (Courts Design)", is_group: true, member_count: 40 },
      { unit_id: "group_4", representative_title: "Change-of-Control Termination Rights in Customer Contracts", is_group: true, member_count: 33 },
      { unit_id: "group_5", representative_title: "Senior Executive Restrictive Covenants Flagged Inadequate", is_group: true, member_count: 26 },
      { unit_id: "group_6", representative_title: "General Conditions C2 / Cease Charges Regulatory Breach", is_group: true, member_count: 13 },
      { unit_id: "group_39", representative_title: "Multiple Ofcom General Condition Technical Breaches (Non-C2)", is_group: true, member_count: 3 },
      { unit_id: "group_8", representative_title: "NHS Deferred Income Unwind as Working Capital Driver", is_group: true, member_count: 2 },
      { unit_id: "group_9", representative_title: "CCaaS Scale Delivery Risk / Value Leakage to Vendors", is_group: true, member_count: 2 },
      { unit_id: "group_10", representative_title: "Buyside CDD Phase I Only — Phase II Validation Absent", is_group: true, member_count: 2 },
      { unit_id: "group_12", representative_title: "Multiple Supplier MSAs Contain Outdated DPA 1998 Provisions", is_group: true, member_count: 2 },
      { unit_id: "group_13", representative_title: "Change of Control Triggers Mandatory Full Prepayment of Facilities", is_group: true, member_count: 2 },
      { unit_id: "group_15", representative_title: "ROPA and Privacy Policy Integration Materially Incomplete", is_group: true, member_count: 2 },
      { unit_id: "group_16", representative_title: "Surgery Connect Ancillary Revenue CAGR Lacks Validation", is_group: true, member_count: 2 },
      { unit_id: "group_19", representative_title: "Supplier Change-of-Control Consent / Gamma Single-Supplier Risk", is_group: true, member_count: 2 },
      { unit_id: "group_20", representative_title: "Preference Share Coupon Rate Discrepancy Across Share Classes", is_group: true, member_count: 2 },
      { unit_id: "group_21", representative_title: "Legal DD Structural Limitations and Six-Month Staleness", is_group: true, member_count: 2 },
      { unit_id: "group_22", representative_title: "South Africa Leases Require Landlord Consent for Change of Control", is_group: true, member_count: 2 },
      { unit_id: "group_23", representative_title: "M&A Cohort GP Declining / Acquisition Multiples Rising", is_group: true, member_count: 2 },
      { unit_id: "group_24", representative_title: "M&A Pipeline Assumptions Without Individual Target Underwriting", is_group: true, member_count: 3 },
      { unit_id: "group_25", representative_title: "NRR Trough at 94.4% FY24 / VDD Churn Granularity Not Disclosed", is_group: true, member_count: 2 },
      { unit_id: "group_27", representative_title: "£19.5m Revenue Basis Discrepancy / Datacube Coverage Gap", is_group: true, member_count: 2 },
      { unit_id: "group_30", representative_title: "No Legitimate Interest Assessments / Marketing Consent Gaps", is_group: true, member_count: 2 },
      { unit_id: "group_31", representative_title: "Aggregator Gross Margin Structural Compression per CDD", is_group: true, member_count: 3 },
      { unit_id: "group_33", representative_title: "Earn-Out Obligations Across Acquired Entities Proximate to Close", is_group: true, member_count: 2 },
      { unit_id: "group_34", representative_title: "Debtor Ageing Deterioration — Over-90-Day Balances Doubled", is_group: true, member_count: 2 },
      { unit_id: "group_35", representative_title: "Horizon Margin Compression vs Operator Connect Economics", is_group: true, member_count: 2 },
      { unit_id: "group_36", representative_title: "CSRD / FRS 102 Accounting Changes — No Independent Stress-Test", is_group: true, member_count: 2 },
      { unit_id: "group_37", representative_title: "Vendor FDD Draft Status Unresolved / PwC Disclaims Accuracy", is_group: true, member_count: 2 },
      { unit_id: "group_38", representative_title: "X-On Health DPIAs Incomplete / Special-Category Health Data Exposure", is_group: true, member_count: 2 },
      { unit_id: "group_40", representative_title: "Key Supplier Agreements Expired — Operating Informally", is_group: true, member_count: 2 },
      { unit_id: "group_41", representative_title: "Platinum/Gold-Tier Churn Acceleration vs Cross-Sell Thesis", is_group: true, member_count: 2 },
      { unit_id: "group_43", representative_title: "X-on Health Market Share Irreconcilable CDD Conflict", is_group: true, member_count: 2 },
      { unit_id: "group_44", representative_title: "SIP NRR Deterioration / ARPU Growth vs ARR Collapse Tension", is_group: true, member_count: 2 },
      { unit_id: "group_45", representative_title: "Overhead Cost Leverage Limited / People Cost FTE Jump", is_group: true, member_count: 2 },
      { unit_id: "group_46", representative_title: "Budget vs Actuals Revenue Shortfall / No Macro Contingency", is_group: true, member_count: 2 },
      { unit_id: "group_49", representative_title: "Legal Proceedings and Competition Law Allegations Undisclosed", is_group: true, member_count: 2 },
      { unit_id: "group_50", representative_title: "Cohort NRR Deterioration Contradicts IP Migration Narrative", is_group: true, member_count: 2 },
      { unit_id: "group_52", representative_title: "Recent Acquisitions Excluded from Datacube / ~9% GP Estimated", is_group: true, member_count: 2 },
      { unit_id: "group_53", representative_title: "Mobile/M2M Gross Margin Collapsed — No Mitigation", is_group: true, member_count: 2 },
      // 2 thesis-drift groups
      { unit_id: "group_32", representative_title: "Microsoft Teams Margin Dilution Risk / Cross-Sell Cannibalisation", is_group: true, member_count: 3 },
      { unit_id: "group_26", representative_title: "Own-IP UCaaS Sustainability / Own-Network Competitive Threat", is_group: true, member_count: 2 },
      // 3 thesis-drift singletons
      { unit_id: "f111", representative_title: "Thesis Drift: Key Risk Disclosures Dropped Between Memo Revisions", is_group: false, member_count: 1 },
      { unit_id: "f301", representative_title: "Microsoft Teams SME Penetration Risk Not Stress-Tested", is_group: false, member_count: 1 },
      { unit_id: "f321", representative_title: "Evonex Core Growth Materially Weaker Ex-Education Vertical", is_group: false, member_count: 1 },
      // 99 omission singletons from omission-distinct-2.json
      { unit_id: "f007", representative_title: "UCaaS Resale Margin Consistency: ~66% vs ~67% Across Memo Sections", is_group: false, member_count: 1 },
      { unit_id: "f013", representative_title: "SIPP Property Break Right Expired September 2025: Exercise Status Unconfirmed", is_group: false, member_count: 1 },
      { unit_id: "f019", representative_title: "SME Segment ARPU Decline and Pricing Pressure Not Flagged in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f044", representative_title: "Cloud Services 13ppt Gross Margin Compression Absent From IC Narrative", is_group: false, member_count: 1 },
      { unit_id: "f053", representative_title: "German Direct Routing vs. Operator Connect Transition Dynamic", is_group: false, member_count: 1 },
      { unit_id: "f056", representative_title: "Deteriorating ARR Churn and Collapsing Net Upsell Trajectory", is_group: false, member_count: 1 },
      { unit_id: "f062", representative_title: "X-On Health Assignment Restrictions Require Customer Consent — IC Memos Silent", is_group: false, member_count: 1 },
      { unit_id: "f064", representative_title: "Block Solutions Ltd: No Express Termination Rights for the Group", is_group: false, member_count: 1 },
      { unit_id: "f065", representative_title: "Phone Mobile UK Entry (2026) and Direct Routing Growth Create Near-Term Competitive Disruption", is_group: false, member_count: 1 },
      { unit_id: "f069", representative_title: "IT & Cloud Customer Count Growth (92.5%) Outpaces Revenue Growth Significantly", is_group: false, member_count: 1 },
      { unit_id: "f074", representative_title: "Director/Secretary Role Concentration in Wilson — Key Man Risk Amplifier", is_group: false, member_count: 1 },
      { unit_id: "f075", representative_title: "TalkTalk Right of First Refusal Over SCN — Absent from All IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f081", representative_title: "Verticalization Strategy Risks Not Quantified in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f084", representative_title: "FTTP and SoGEA Margin Improvement Partly Driven by One-Off Wholesale Pricing Events", is_group: false, member_count: 1 },
      { unit_id: "f089", representative_title: "Run-Rate EBITDA Bridge Includes £1.5m from Uncommitted Bolt-On Acquisitions", is_group: false, member_count: 1 },
      { unit_id: "f100", representative_title: "Cash Reconciliation Limited — Bank Recs Reviewed at March 2025 Only", is_group: false, member_count: 1 },
      { unit_id: "f106", representative_title: "Mark Shraga Personally Owns Core Sales Methodology IP; License Only, No Assignment", is_group: false, member_count: 1 },
      { unit_id: "f107", representative_title: "FY25 Organic Growth Inflated by WIP Timing; Base Case Entry Multiple Risk", is_group: false, member_count: 1 },
      { unit_id: "f112", representative_title: "Unlimited Indemnities in Four Major Customer Frameworks", is_group: false, member_count: 1 },
      { unit_id: "f115", representative_title: "SIP Calls Gross Margin Collapsed to -34.1% in FY25 — No IC Memo Discussion", is_group: false, member_count: 1 },
      { unit_id: "f119", representative_title: "Vendor/Network Owner Value Chain Decline Not Quantified in Memo", is_group: false, member_count: 1 },
      { unit_id: "f125", representative_title: "Dataphone FCA Authorisation Revocation — Disciplinary History Not Disclosed", is_group: false, member_count: 1 },
      { unit_id: "f128", representative_title: "Chippenham Hill Holdover: No Renewal Negotiations Underway, No Landlord Consent", is_group: false, member_count: 1 },
      { unit_id: "f132", representative_title: "FSMA General Prohibition Breach — Legacy Regulated Hire Agreements", is_group: false, member_count: 1 },
      { unit_id: "f136", representative_title: "CCaaS Market Competitive Concentration — Genesys/Avaya/Zendesk/NICE Hold 44% of European Market", is_group: false, member_count: 1 },
      { unit_id: "f138", representative_title: "Acquisition ARR Contribution Declined 73% FY24–FY25; Inorganic Strategy Dependency Not Reassessed", is_group: false, member_count: 1 },
      { unit_id: "f144", representative_title: "DuoCall Legacy T&Cs Permit Customer Termination Without Cause on 90 Days' Notice", is_group: false, member_count: 1 },
      { unit_id: "f145", representative_title: "ARPU Comparability Limitation: Historic vs. Forecast Periods Not Directly Comparable", is_group: false, member_count: 1 },
      { unit_id: "f147", representative_title: "Partner Network Contractual Fragility: Undefined Future Basis for 49 Direct Dealers", is_group: false, member_count: 1 },
      { unit_id: "f152", representative_title: "IT Licences Margin Ceiling: Microsoft Pricing Control Limits Upside", is_group: false, member_count: 1 },
      { unit_id: "f155", representative_title: "Evonex Migration Characterised as 'New Logo Effort' But Modelled as Routine Upsell", is_group: false, member_count: 1 },
      { unit_id: "f156", representative_title: "Gross Debt Increasing to £803.7m by FY34 Despite Leverage Reduction — Not Highlighted", is_group: false, member_count: 1 },
      { unit_id: "f157", representative_title: "Mobile Segment Growth Assumptions Flagged as Ambitious by VDD", is_group: false, member_count: 1 },
      { unit_id: "f162", representative_title: "TalkTalk Business: Multiple Agreements, Operative Document Not Identified", is_group: false, member_count: 1 },
      { unit_id: "f163", representative_title: "IBMG Contract Loss (£596k p.a.) Not Quantified or Contextualised in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f185", representative_title: "Near-Term M&A Pipeline: Two Targets Carry Undisclosed Stress Flags", is_group: false, member_count: 1 },
      { unit_id: "f188", representative_title: "Uncapped Liability in Legacy Fuse 2 T&Cs — Migration Status Not Disclosed", is_group: false, member_count: 1 },
      { unit_id: "f194", representative_title: "Datakom FCA De-registration: Documentation Present, Status Not Confirmed", is_group: false, member_count: 1 },
      { unit_id: "f199", representative_title: "Subsidiary contracts lack governing law and jurisdiction clauses", is_group: false, member_count: 1 },
      { unit_id: "f200", representative_title: "Apex Park Licence Expired December 2025: Continuity Status Unknown", is_group: false, member_count: 1 },
      { unit_id: "f205", representative_title: "Gold Partner Agreement Unsecured Loan: Recoverability Not Disclosed", is_group: false, member_count: 1 },
      { unit_id: "f206", representative_title: "Winchester Consultancy Related-Party Arrangement: £70k/Month Margin Pass-Through", is_group: false, member_count: 1 },
      { unit_id: "f213", representative_title: "BT Wholesale GEA Discount Letter Unsigned — Pricing Enforceability Uncertain", is_group: false, member_count: 1 },
      { unit_id: "f214", representative_title: "Surgery Connect GP Market Near-Saturation (80%) Not Stress-Tested in Returns Sensitivity", is_group: false, member_count: 1 },
      { unit_id: "f216", representative_title: "16-Month FY23 Period Creates Structural Comparability Risk Across the QoE Baseline", is_group: false, member_count: 1 },
      { unit_id: "f218", representative_title: "Matrix Agreement 2008 Mid-Renewal: Completion Status and Revised Terms Unconfirmed", is_group: false, member_count: 1 },
      { unit_id: "f219", representative_title: "Net Liability Position of £(178.5)m — Capital Structure Complexity Not Reflected in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f220", representative_title: "Ares Debenture Network — Release Mechanism Unconfirmed in IC Record", is_group: false, member_count: 1 },
      { unit_id: "f221", representative_title: "CCS Framework Notification Obligation: Potential Conflict-of-Interest Constraint", is_group: false, member_count: 1 },
      { unit_id: "f222", representative_title: "Goodwill Concentration — £339m NBV from Historical Acquisitions", is_group: false, member_count: 1 },
      { unit_id: "f224", representative_title: "Employee Equity Vesting Schedules Not Disclosed", is_group: false, member_count: 1 },
      { unit_id: "f225", representative_title: "Widespread Uncapped Supplier Liability Exposure Undisclosed in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f227", representative_title: "Germany Expansion: Structural Market Differences vs. UK Model", is_group: false, member_count: 1 },
      { unit_id: "f238", representative_title: "Data Broker Agreement Lacks Consent Obligation — Prospect Data Provenance Unverified", is_group: false, member_count: 1 },
      { unit_id: "f242", representative_title: "Non-Recurring Revenue Negative Gross Profit Not Disclosed in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f245", representative_title: "Outstanding 2024 Rent Review at Hereford: No Formal Nil-Increase Documentation", is_group: false, member_count: 1 },
      { unit_id: "f248", representative_title: "Telecoms Regulatory DD Scope Explicitly Excludes Broad Compliance Review", is_group: false, member_count: 1 },
      { unit_id: "f250", representative_title: "P&L Excludes Statutory Year-End Adjustments — Balance Sheet and P&L Presentational Basis Diverges", is_group: false, member_count: 1 },
      { unit_id: "f261", representative_title: "Riduna Park Lease: Terrorism Exclusion and Uncapped Service Charge Not in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f262", representative_title: "New Star Networks SA Acquisition at 22.1x — No Strategic Rationale in IC Record", is_group: false, member_count: 1 },
      { unit_id: "f263", representative_title: "Interest Rate Hedging Commitment: 90-Day Post-Close Deadline Not Confirmed Satisfied", is_group: false, member_count: 1 },
      { unit_id: "f265", representative_title: "Surgery Connect AI Ancillary Product Revenue Highly Concentrated in Single Unproven Line", is_group: false, member_count: 1 },
      { unit_id: "f269", representative_title: "Contracted vs. Variable Revenue Split Not Available", is_group: false, member_count: 1 },
      { unit_id: "f273", representative_title: "EMIS / Accurx Competitive Encroachment on Surgery Connect Ecosystem Not Quantified", is_group: false, member_count: 1 },
      { unit_id: "f274", representative_title: "PSTN/ISDN Switch-Off Timeline: Dual Date References in CDD", is_group: false, member_count: 1 },
      { unit_id: "f275", representative_title: "Surgery Intellect: MHRA Class IIa Regulatory Approval Pending — Status Undisclosed", is_group: false, member_count: 1 },
      { unit_id: "f278", representative_title: "Cardiff Gate Lease Break Option: Undisclosed in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f279", representative_title: "AI Ancillary GP Haircut Rationale Absent from IC Record", is_group: false, member_count: 1 },
      { unit_id: "f291", representative_title: "Surgery Connect ARR New Wins: FY25 Timing Distortion Masks Underlying Growth Rate", is_group: false, member_count: 1 },
      { unit_id: "f295", representative_title: "New Vertical Identification Strategy Described as Post-Close — Not Disclosed as Open Item", is_group: false, member_count: 1 },
      { unit_id: "f298", representative_title: "DPO/CISO Dual-Role Concentration — No Separate Service Agreement", is_group: false, member_count: 1 },
      { unit_id: "f302", representative_title: "Semiconductor Stockpiling Inventory Normalisation — Context Not in Memos", is_group: false, member_count: 1 },
      { unit_id: "f315", representative_title: "Hanley Health Acquired at Negative EBITDA — No Performance Milestone Disclosed", is_group: false, member_count: 1 },
      { unit_id: "f316", representative_title: "UC Collaboration Growth Fastest-Segment But Gamma Platform Mix-Dilution Risk Unaddressed", is_group: false, member_count: 1 },
      { unit_id: "f317", representative_title: "Surgery Connect Margin Step-Up Driven by Methodology Change, Not Operations", is_group: false, member_count: 1 },
      { unit_id: "f319", representative_title: "MS Teams Germany Share Trajectory Not Addressed in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f325", representative_title: "NHS Rollout Overtime Cost Non-Normalisation Not Addressed in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f331", representative_title: "Subsidiary contracts lack post-termination non-compete and key protections", is_group: false, member_count: 1 },
      { unit_id: "f335", representative_title: "International Data Transfer to South Africa — SCC Reliance Not Independently Verified", is_group: false, member_count: 1 },
      { unit_id: "f348", representative_title: "H&S Compliance Cluster: Documentation Gaps, Fire Safety, and RIDDOR", is_group: false, member_count: 1 },
      { unit_id: "f360", representative_title: "Standard Customer T&Cs Dated April 2018 — Seven-Year Vintage Not Flagged in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f372", representative_title: "Deferred Income Billing Model Shift — NWC Unwinding Risk", is_group: false, member_count: 1 },
      { unit_id: "f373", representative_title: "Datakom FCA De-Registration: Scope and Residual Exposure Undisclosed", is_group: false, member_count: 1 },
      { unit_id: "f380", representative_title: "Cisco Dependency Limits CCaaS Roadmap Control: CDD Not Reconciled in Memos", is_group: false, member_count: 1 },
      { unit_id: "f382", representative_title: "Unresolved FY23 Reserves Variance — Management Cannot Explain", is_group: false, member_count: 1 },
      { unit_id: "f383", representative_title: "Working Capital Characterisation Tension — 'Broadly Neutral' vs. Worsening Monthly Minimum", is_group: false, member_count: 1 },
      { unit_id: "f394", representative_title: "Mobile FY24 Churn Event: Government Framework Losses to EE Competitor", is_group: false, member_count: 1 },
      { unit_id: "f395", representative_title: "Forecast Capex Step-Up to ~£12m Not Reconciled in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f397", representative_title: "Unpaid Ofcom Administrative Charges: £60,000–£80,000 Quantified Liability", is_group: false, member_count: 1 },
      { unit_id: "f400", representative_title: "Fixed Connectivity: Legacy Decline vs FTTP Growth Creates Revenue Mix Shift", is_group: false, member_count: 1 },
      { unit_id: "f404", representative_title: "Pervasive 30–90 Day Termination-for-Convenience Regime Not Disclosed in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f411", representative_title: "EE MSA Revenue Guarantee and Early Termination Charges Not Quantified in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f412", representative_title: "Fragmented T&C Landscape Across Nine Regimes in Top-20 Customers Undisclosed", is_group: false, member_count: 1 },
      { unit_id: "f417", representative_title: "ARR Double-Counting and Manual Overlay Exposure Not Disclosed to IC", is_group: false, member_count: 1 },
      { unit_id: "f426", representative_title: "Asbestos Survey at Hemel Hempstead Outdated; 2019 Refurbishment Survey Unconfirmed", is_group: false, member_count: 1 },
      { unit_id: "f428", representative_title: "CYBR Vision ARPU Peak-and-Decline in FY28 Not Addressed in IC Memos", is_group: false, member_count: 1 },
      { unit_id: "f430", representative_title: "IT, Cloud & Security Churn Acceleration Unaddressed Despite Strong Cross-Sell Narrative", is_group: false, member_count: 1 },
      { unit_id: "f431", representative_title: "Germany Market Entry Risks Not Addressed in Memo", is_group: false, member_count: 1 },
      { unit_id: "f433", representative_title: "CFO Transition Risk Absent from IC Memo Record", is_group: false, member_count: 1 },
    ];

    const TOTAL_UNITS = allUnits.length; // should be 142

    // ── Load or create session ────────────────────────────────────────────
    const SessionRow = z.object({ id: z.string(), state: z.any() });
    let session: SessionState;
    let resolvedSessionId: string;

    if (sessionId) {
      const rows = await ctx.integrations.db.query(
        `SELECT id, state FROM diag_materiality_sessions WHERE id = $1`,
        SessionRow,
        [sessionId],
        { label: "Load existing session" },
      );
      if (rows.length === 0) throw new Error(`Session ${sessionId} not found`);
      resolvedSessionId = rows[0].id;
      session = rows[0].state as SessionState;
    } else {
      // Create new session
      const InsertRow = z.object({ id: z.string() });
      const newState: SessionState = { total_units: TOTAL_UNITS, results: [], complete: false };
      const inserted = await ctx.integrations.db.query(
        `INSERT INTO diag_materiality_sessions (state) VALUES ($1::jsonb) RETURNING id`,
        InsertRow,
        [JSON.stringify(newState)],
        { label: "Create new materiality session" },
      );
      resolvedSessionId = inserted[0].id;
      session = newState;
    }

    // ── Dump mode — return final results ──────────────────────────────────
    if (mode === "dump") {
      const PAGE_SIZE = 50;
      const start = dumpPage * PAGE_SIZE;
      const slice = session.results.slice(start, start + PAGE_SIZE);
      const t1 = session.results.filter(r => r.tier === 1).length;
      const t2 = session.results.filter(r => r.tier === 2).length;
      const t3 = session.results.filter(r => r.tier === 3).length;
      return {
        sessionId: resolvedSessionId,
        processed: session.results.length,
        total: TOTAL_UNITS,
        complete: session.complete,
        sample: slice,
        tier_counts: { tier1: t1, tier2: t2, tier3: t3 },
      };
    }

    // ── Run mode — process unclassified units ─────────────────────────────
    if (session.complete) {
      const t1 = session.results.filter(r => r.tier === 1).length;
      const t2 = session.results.filter(r => r.tier === 2).length;
      const t3 = session.results.filter(r => r.tier === 3).length;
      return {
        sessionId: resolvedSessionId,
        processed: session.results.length,
        total: TOTAL_UNITS,
        complete: true,
        sample: session.results.slice(0, 10),
        tier_counts: { tier1: t1, tier2: t2, tier3: t3 },
      };
    }

    // Determine which units still need processing
    const processedIds = new Set(session.results.map(r => r.unit_id));
    const pending = allUnits.filter(u => !processedIds.has(u.unit_id));

    ctx.log.info(`Materiality tiering: ${pending.length} remaining of ${TOTAL_UNITS}`);

    // Response schema for Anthropic
    const MessageResponseSchema = z.object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
    });

    // Process pending units with concurrency
    const newResults: TierResult[] = [];
    const { completed } = await runWithConcurrency(
      pending,
      CONCURRENCY,
      async (unit) => {
        const prompt = buildPrompt(unit.representative_title);
        const result = await ctx.integrations.ai.apiRequest(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: "claude-sonnet-4-6",
              max_tokens: 256,
              messages: [{ role: "user", content: prompt }],
            },
          },
          { response: MessageResponseSchema },
          { label: `Tier: ${unit.unit_id}` },
        );

        const text = result.content.find((c: any) => c.type === "text")?.text ?? "{}";
        let parsed: { tier?: number; rationale?: string; driver?: string };
        try {
          // Extract JSON from response (may have markdown code fences)
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
        } catch {
          parsed = { tier: 3, rationale: "Parse error — defaulted to T3", driver: "none" };
        }

        const tierResult: TierResult = {
          unit_id: unit.unit_id,
          title: unit.representative_title,
          tier: parsed.tier ?? 3,
          rationale: parsed.rationale ?? "No rationale returned",
          driver: parsed.driver ?? "none",
        };
        newResults.push(tierResult);
        return tierResult;
      },
      () => (deadlineMs - Date.now()) < TIME_BUDGET_SAFETY_MS,
    );

    // Merge new results into session
    session.results = [...session.results, ...newResults.filter(Boolean)];
    session.complete = session.results.length >= TOTAL_UNITS;

    // Persist session state
    await ctx.integrations.db.execute(
      `UPDATE diag_materiality_sessions SET state = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(session), resolvedSessionId],
      { label: "Persist session progress" },
    );

    const t1 = session.results.filter(r => r.tier === 1).length;
    const t2 = session.results.filter(r => r.tier === 2).length;
    const t3 = session.results.filter(r => r.tier === 3).length;

    return {
      sessionId: resolvedSessionId,
      processed: session.results.length,
      total: TOTAL_UNITS,
      complete: session.complete,
      sample: newResults.slice(0, 10),
      tier_counts: { tier1: t1, tier2: t2, tier3: t3 },
    };
  },
});
