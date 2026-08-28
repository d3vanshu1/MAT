/**
 * ERO v2 — Source-tier classifier (Phase 4 admissibility gate)
 *
 * Pure deterministic functions — no ctx, no integrations, no async I/O.
 * Classifies web evidence into source tiers and caps finding severity
 * based on the locked admissibility model.
 *
 * Tier 1 — Official record: Companies House, regulator registers,
 *   court/tribunal decisions, gov domains, statutory accounts.
 * Tier 2 — Edited press & primary corporate: named-byline financial/
 *   trade press, company official announcements, established news orgs.
 * Tier 3 — Everything else: aggregators, content farms, undated posts,
 *   press-wire copy, AI-generated summaries, blogs, forums, social.
 *
 * Severity ceilings by best available source:
 *   critical  → requires ≥1 Tier-1 source, dated
 *   warning   → Tier-2 best caps here
 *   info      → Tier-3 best caps here; undated evidence caps here
 *              regardless of tier; stale enforcement (>24mo) caps here
 */

// ═══════════════════════════════════════════════════════════════════
// PATTERN LISTS — clear data, not control flow.
// Extended per jurisdiction, NOT per deal.
// ═══════════════════════════════════════════════════════════════════

/**
 * Tier 1: Official-record domain signals.
 *
 * Each entry is a { pattern, matchType, label } object.
 *   matchType "exact"    → hostname must equal pattern exactly
 *   matchType "suffix"   → hostname must end with pattern
 *                          (preceded by "." or matching the whole host)
 *   matchType "contains" → hostname must contain pattern as a
 *                          dot-delimited segment (NOT a naive substring)
 *
 * "contains" means the pattern appears as a full dot-separated segment
 * sequence within the hostname — e.g. "companieshouse" matches
 * "beta.companieshouse.gov.uk" but NOT "fakecompanieshouse.com".
 */
const TIER_1_PATTERNS: Array<{
  pattern: string;
  matchType: "exact" | "suffix" | "contains";
  label: string;
}> = [
  // ── UK Companies House ──────────────────────────────────────────
  { pattern: "companieshouse.gov.uk", matchType: "suffix", label: "Companies House" },
  { pattern: "find-and-update.company-information.service.gov.uk", matchType: "exact", label: "Companies House beta" },
  { pattern: "beta.companieshouse.gov.uk", matchType: "exact", label: "Companies House beta" },

  // ── Government TLD patterns ─────────────────────────────────────
  // .gov.uk, .gov, .gov.au, .gov.ca, .gov.ie, etc.
  // Matched as hostname suffix — "data.gov.uk" matches, "govinda.com" does not.
  { pattern: ".gov.uk", matchType: "suffix", label: "gov.uk domain" },
  { pattern: ".gov.au", matchType: "suffix", label: "gov.au domain" },
  { pattern: ".gov.ca", matchType: "suffix", label: "gov.ca domain" },
  { pattern: ".gov.ie", matchType: "suffix", label: "gov.ie domain" },
  { pattern: ".gov.nz", matchType: "suffix", label: "gov.nz domain" },
  { pattern: ".gov", matchType: "suffix", label: "gov domain" },
  { pattern: ".govt.nz", matchType: "suffix", label: "govt.nz domain" },
  { pattern: ".mil", matchType: "suffix", label: "mil domain" },
  { pattern: ".parliament.uk", matchType: "suffix", label: "parliament.uk domain" },

  // ── UK regulators & registries ──────────────────────────────────
  { pattern: "fca.org.uk", matchType: "suffix", label: "FCA" },
  { pattern: "ofcom.org.uk", matchType: "suffix", label: "Ofcom" },
  { pattern: "cqc.org.uk", matchType: "suffix", label: "CQC" },
  { pattern: "ico.org.uk", matchType: "suffix", label: "ICO" },
  { pattern: "ofgem.gov.uk", matchType: "suffix", label: "Ofgem" },
  { pattern: "ofwat.gov.uk", matchType: "suffix", label: "Ofwat" },
  { pattern: "hse.gov.uk", matchType: "suffix", label: "HSE" },
  { pattern: "ons.gov.uk", matchType: "suffix", label: "ONS" },
  { pattern: "nhs.uk", matchType: "suffix", label: "NHS" },

  // ── Courts & tribunals ──────────────────────────────────────────
  { pattern: "judiciary.uk", matchType: "suffix", label: "UK Judiciary" },
  { pattern: "bailii.org", matchType: "suffix", label: "BAILII (case law)" },
  { pattern: "caselaw.nationalarchives.gov.uk", matchType: "exact", label: "National Archives case law" },
  { pattern: "courtserve.net", matchType: "suffix", label: "CourtServe" },

  // ── International regulators (general, not deal-specific) ───────
  { pattern: "sec.gov", matchType: "suffix", label: "SEC" },
  { pattern: "finra.org", matchType: "suffix", label: "FINRA" },
  { pattern: "consumerfinance.gov", matchType: "suffix", label: "CFPB" },
  { pattern: "justice.gov", matchType: "suffix", label: "DOJ" },
  { pattern: "ftc.gov", matchType: "suffix", label: "FTC" },
  { pattern: "europa.eu", matchType: "suffix", label: "EU institution" },
  { pattern: "ecb.europa.eu", matchType: "exact", label: "ECB" },

  // ── Procurement portals ─────────────────────────────────────────
  { pattern: "contracts-finder.service.gov.uk", matchType: "exact", label: "Contracts Finder" },
  { pattern: "ted.europa.eu", matchType: "exact", label: "TED (EU procurement)" },
  { pattern: "sam.gov", matchType: "suffix", label: "SAM.gov" },

  // ── Statutory accounts / filings ────────────────────────────────
  { pattern: "annualreports.com", matchType: "suffix", label: "Annual reports registry" },
];

/**
 * Tier 2: Established press, trade press, and official-corporate signals.
 *
 * These are domains with editorial standards or primary corporate
 * announcements. A publisher's own domain for IR/press releases
 * is handled separately via the publisher heuristic.
 */
const TIER_2_PATTERNS: Array<{
  pattern: string;
  matchType: "exact" | "suffix" | "contains";
  label: string;
}> = [
  // ── Major financial / business press ────────────────────────────
  { pattern: "ft.com", matchType: "suffix", label: "Financial Times" },
  { pattern: "reuters.com", matchType: "suffix", label: "Reuters" },
  { pattern: "bloomberg.com", matchType: "suffix", label: "Bloomberg" },
  { pattern: "wsj.com", matchType: "suffix", label: "Wall Street Journal" },
  { pattern: "economist.com", matchType: "suffix", label: "The Economist" },
  { pattern: "bbc.co.uk", matchType: "suffix", label: "BBC" },
  { pattern: "bbc.com", matchType: "suffix", label: "BBC" },
  { pattern: "theguardian.com", matchType: "suffix", label: "The Guardian" },
  { pattern: "telegraph.co.uk", matchType: "suffix", label: "The Telegraph" },
  { pattern: "thetimes.co.uk", matchType: "suffix", label: "The Times" },
  { pattern: "thetimes.com", matchType: "suffix", label: "The Times" },
  { pattern: "nytimes.com", matchType: "suffix", label: "New York Times" },
  { pattern: "washingtonpost.com", matchType: "suffix", label: "Washington Post" },
  { pattern: "cnbc.com", matchType: "suffix", label: "CNBC" },
  { pattern: "sky.com", matchType: "suffix", label: "Sky News" },
  { pattern: "independent.co.uk", matchType: "suffix", label: "The Independent" },
  { pattern: "cityam.com", matchType: "suffix", label: "City AM" },

  // ── Trade / sector press ────────────────────────────────────────
  { pattern: "techcrunch.com", matchType: "suffix", label: "TechCrunch" },
  { pattern: "wired.com", matchType: "suffix", label: "Wired" },
  { pattern: "arstechnica.com", matchType: "suffix", label: "Ars Technica" },
  { pattern: "theregister.com", matchType: "suffix", label: "The Register" },
  { pattern: "healthcareitnews.com", matchType: "suffix", label: "Healthcare IT News" },
  { pattern: "channele2e.com", matchType: "suffix", label: "ChannelE2E" },
  { pattern: "channelfutures.com", matchType: "suffix", label: "Channel Futures" },
  { pattern: "commsdealer.com", matchType: "suffix", label: "Comms Dealer" },
  { pattern: "ispreview.co.uk", matchType: "suffix", label: "ISPreview" },
  { pattern: "telecoms.com", matchType: "suffix", label: "Telecoms.com" },
  { pattern: "capacitymedia.com", matchType: "suffix", label: "Capacity Media" },
  { pattern: "totaltele.com", matchType: "suffix", label: "Total Telecom" },
  { pattern: "lightreading.com", matchType: "suffix", label: "Light Reading" },

  // ── Regulatory news services ────────────────────────────────────
  { pattern: "londonstockexchange.com", matchType: "suffix", label: "LSE RNS" },
  { pattern: "investegate.co.uk", matchType: "suffix", label: "Investegate" },

  // ── Corporate IR / press heuristic paths ────────────────────────
  // (Handled by publisher heuristic below, not here)
];

// ═══════════════════════════════════════════════════════════════════
// HOST EXTRACTION — robust, not naive substring
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract the lowercase hostname from a URL.
 * Strips www. prefix, handles protocol-less URLs, query strings, etc.
 * Returns empty string on unparseable input.
 *
 * Uses regex-based parsing (not the URL constructor) because the
 * Superblocks SDK runtime may not expose the URL global.
 */
function extractHost(url: string): string {
  if (!url || typeof url !== "string") return "";

  let s = url.trim().toLowerCase();

  // Strip protocol
  s = s.replace(/^https?:\/\//i, "");

  // Strip userinfo (user:pass@)
  const atIdx = s.indexOf("@");
  if (atIdx !== -1) {
    s = s.slice(atIdx + 1);
  }

  // Strip path, query, fragment — take everything before the first / ? #
  const endIdx = s.search(/[/?#]/);
  if (endIdx !== -1) {
    s = s.slice(0, endIdx);
  }

  // Strip port
  const colonIdx = s.lastIndexOf(":");
  if (colonIdx !== -1) {
    s = s.slice(0, colonIdx);
  }

  // Strip leading www.
  if (s.startsWith("www.")) {
    s = s.slice(4);
  }

  // Sanity: must contain at least one dot
  if (!s.includes(".")) return "";

  return s;
}


/**
 * Check if hostname matches a pattern according to the matchType.
 *
 * "exact"    → host === pattern
 * "suffix"   → host ends with pattern AND the character before
 *              the suffix is "." or the suffix IS the whole host.
 *              This prevents "evilgov.uk" from matching ".gov.uk"
 *              while allowing "data.gov.uk" and "gov.uk" itself.
 * "contains" → pattern appears as a complete dot-segment sequence
 *              within the host.  "companieshouse" matches inside
 *              "beta.companieshouse.gov.uk" but NOT inside
 *              "fakecompanieshouse.com".
 */
function hostMatchesPattern(
  host: string,
  pattern: string,
  matchType: "exact" | "suffix" | "contains",
): boolean {
  const p = pattern.toLowerCase();

  if (matchType === "exact") {
    return host === p;
  }

  if (matchType === "suffix") {
    if (host === p || host === p.replace(/^\./, "")) return true;
    // Pattern may or may not start with "."
    const dotPattern = p.startsWith(".") ? p : "." + p;
    return host.endsWith(dotPattern);
  }

  if (matchType === "contains") {
    // Split host into segments, check if pattern appears as a
    // contiguous subsequence of segments.
    const hostParts = host.split(".");
    const patternParts = p.split(".");
    for (let i = 0; i <= hostParts.length - patternParts.length; i++) {
      let match = true;
      for (let j = 0; j < patternParts.length; j++) {
        if (hostParts[i + j] !== patternParts[j]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
    return false;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════
// classifyTier
// ═══════════════════════════════════════════════════════════════════

export type TierResult = {
  tier: 1 | 2 | 3;
  reason: string;
};

/**
 * Classify a URL into source tier 1, 2, or 3.
 *
 * Priority: Tier 1 patterns checked first. If no Tier 1 match,
 * Tier 2 patterns checked. If neither matches, Tier 3 default.
 *
 * The optional `publisher` field provides a belt-and-suspenders
 * signal: if the publisher name indicates a corporate IR page or
 * established press org, it can upgrade from Tier 3 to Tier 2.
 * It never upgrades to Tier 1 (official records are domain-gated).
 */
export function classifyTier(
  url: string,
  publisher?: string | null,
): TierResult {
  const host = extractHost(url);

  if (!host) {
    return { tier: 3, reason: "tier3: unparseable URL" };
  }

  // ── Check Tier 1 patterns ───────────────────────────────────────
  for (const p of TIER_1_PATTERNS) {
    if (hostMatchesPattern(host, p.pattern, p.matchType)) {
      return { tier: 1, reason: `tier1: ${p.label} (${host})` };
    }
  }

  // ── Check Tier 2 patterns ───────────────────────────────────────
  for (const p of TIER_2_PATTERNS) {
    if (hostMatchesPattern(host, p.pattern, p.matchType)) {
      return { tier: 2, reason: `tier2: ${p.label} (${host})` };
    }
  }

  // ── Publisher heuristic (Tier 2 upgrade) ─────────────────────────
  // Corporate IR pages, investor-relations paths, and press releases
  // from a company's own domain are Tier 2 (primary corporate).
  if (publisher && publisher.trim().length > 0) {
    const pubLower = publisher.toLowerCase();
    const irSignals = [
      "investor relations",
      "press release",
      "newsroom",
      "media centre",
      "media center",
      "corporate announcement",
      "regulatory news",
      "rns",
    ];
    if (irSignals.some((s) => pubLower.includes(s))) {
      return {
        tier: 2,
        reason: `tier2: publisher indicates corporate/IR source ("${publisher}")`,
      };
    }
  }

  // ── Default: Tier 3 ─────────────────────────────────────────────
  // Path-based IR heuristic intentionally removed (Packet 4.1-fix).
  // A source earns Tier 2 via a recognized press/corporate domain or
  // an explicit publisher signal — not via a path substring that
  // anyone (content farms, blogs, wire services) can put in a URL.
  // Conservative failure (default Tier 3) is the correct direction
  // for an admissibility gate.
  return { tier: 3, reason: `tier3: no official/press pattern matched (${host})` };
}

// ═══════════════════════════════════════════════════════════════════
// parsePublicationDate
// ═══════════════════════════════════════════════════════════════════

export type DateResult = {
  date: string | null;  // ISO YYYY-MM-DD or null
  isDated: boolean;
};

/**
 * Normalize common date forms to ISO YYYY-MM-DD.
 * Returns { date: null, isDated: false } for null/undefined/empty/
 * unparseable input. Does NOT guess a date from nothing.
 */
export function parsePublicationDate(
  raw: string | null | undefined,
): DateResult {
  if (!raw || raw.trim() === "") {
    return { date: null, isDated: false };
  }

  const cleaned = raw.trim();

  // ── Already ISO-like: YYYY-MM-DD ────────────────────────────────
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    if (isValidDate(+y!, +m!, +d!)) {
      return { date: `${y}-${m}-${d}`, isDated: true };
    }
  }

  // ── DD/MM/YYYY or DD-MM-YYYY (UK convention) ────────────────────
  const ukMatch = cleaned.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (ukMatch) {
    const [, dd, mm, yyyy] = ukMatch;
    const d = +dd!, m = +mm!, y = +yyyy!;
    if (isValidDate(y, m, d)) {
      return {
        date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        isDated: true,
      };
    }
  }

  // ── "DD Month YYYY" or "Month DD, YYYY" ─────────────────────────
  const namedMonthMatch1 = cleaned.match(
    /^(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i,
  );
  if (namedMonthMatch1) {
    const [, dd, monthName, yyyy] = namedMonthMatch1;
    const m = monthNameToNumber(monthName!);
    if (m && isValidDate(+yyyy!, m, +dd!)) {
      return {
        date: `${yyyy}-${String(m).padStart(2, "0")}-${String(+dd!).padStart(2, "0")}`,
        isDated: true,
      };
    }
  }

  const namedMonthMatch2 = cleaned.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})$/i,
  );
  if (namedMonthMatch2) {
    const [, monthName, dd, yyyy] = namedMonthMatch2;
    const m = monthNameToNumber(monthName!);
    if (m && isValidDate(+yyyy!, m, +dd!)) {
      return {
        date: `${yyyy}-${String(m).padStart(2, "0")}-${String(+dd!).padStart(2, "0")}`,
        isDated: true,
      };
    }
  }

  // ── "DD Mon YYYY" short month ───────────────────────────────────
  const shortMonthMatch = cleaned.match(
    /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i,
  );
  if (shortMonthMatch) {
    const [, dd, monthName, yyyy] = shortMonthMatch;
    const m = monthNameToNumber(monthName!);
    if (m && isValidDate(+yyyy!, m, +dd!)) {
      return {
        date: `${yyyy}-${String(m).padStart(2, "0")}-${String(+dd!).padStart(2, "0")}`,
        isDated: true,
      };
    }
  }

  // ── ISO-8601 datetime: YYYY-MM-DDTHH:MM:SS... ──────────────────
  const isoDatetimeMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (isoDatetimeMatch) {
    const [, y, m, d] = isoDatetimeMatch;
    if (isValidDate(+y!, +m!, +d!)) {
      return { date: `${y}-${m}-${d}`, isDated: true };
    }
  }

  // ── Unparseable ─────────────────────────────────────────────────
  return { date: null, isDated: false };
}

function monthNameToNumber(name: string): number | null {
  const months: Record<string, number> = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12,
  };
  return months[name.toLowerCase()] ?? null;
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (y < 1900 || y > 2100) return false;
  // Basic month-length check
  const daysInMonth = new Date(y, m, 0).getDate();
  return d <= daysInMonth;
}

// ═══════════════════════════════════════════════════════════════════
// applyCeiling
// ═══════════════════════════════════════════════════════════════════

export type EvidenceForCeiling = {
  tier: 1 | 2 | 3;
  isDated: boolean;
  publicationDate: string | null;  // ISO YYYY-MM-DD or null
  isEnforcementOrLitigation: boolean;
};

export type CeilingResult = {
  severity: "critical" | "warning" | "info";
  ceilingReason: string;
  needsRecheck: boolean;
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/**
 * Apply admissibility ceilings to a proposed severity based on the
 * evidence set.
 *
 * Fail closed: empty evidence → info, "no admissible evidence".
 *
 * @param proposedSeverity - The severity the adjudicator wants to assign
 * @param evidence - Array of evidence items with tier, date, enforcement flag
 * @param nowMs - Optional "now" timestamp for age calculations (default: Date.now())
 */
export function applyCeiling(
  proposedSeverity: "critical" | "warning" | "info",
  evidence: EvidenceForCeiling[],
  nowMs?: number,
): CeilingResult {
  // ── Fail closed: no evidence → info ─────────────────────────────
  if (evidence.length === 0) {
    return {
      severity: "info",
      ceilingReason: "no admissible evidence",
      needsRecheck: false,
    };
  }

  const now = nowMs ?? Date.now();
  const TWENTY_FOUR_MONTHS_MS = 24 * 30.44 * 24 * 60 * 60 * 1000; // ~730.5 days

  // ── Compute best tier ───────────────────────────────────────────
  const bestTier = Math.min(...evidence.map((e) => e.tier)) as 1 | 2 | 3;

  // ── Check for undated evidence ──────────────────────────────────
  const hasUndated = evidence.some((e) => !e.isDated);

  // ── Check for stale enforcement/litigation evidence ─────────────
  // If any enforcement/litigation evidence is older than 24 months,
  // flag needs_recheck and cap at info until rechecked.
  let needsRecheck = false;
  let hasStaleEnforcement = false;

  for (const e of evidence) {
    if (e.isEnforcementOrLitigation && e.publicationDate) {
      const pubDate = new Date(e.publicationDate).getTime();
      if (!isNaN(pubDate) && (now - pubDate) > TWENTY_FOUR_MONTHS_MS) {
        hasStaleEnforcement = true;
        needsRecheck = true;
      }
    }
  }

  // ── Apply ceiling rules in priority order ───────────────────────
  let ceiling: "critical" | "warning" | "info" = "critical";
  let ceilingReason = "";

  // Rule 1: Undated evidence → cap at info regardless of tier
  if (hasUndated) {
    ceiling = "info";
    ceilingReason = "capped at info: undated evidence present";
  }
  // Rule 2: Stale enforcement → cap at info, flag recheck
  else if (hasStaleEnforcement) {
    ceiling = "info";
    ceilingReason = "capped at info: enforcement/litigation evidence older than 24 months (needs recheck)";
  }
  // Rule 3: Best tier determines ceiling
  else if (bestTier === 1) {
    ceiling = "critical";
    ceilingReason = "critical: tier-1 source present, dated";
  } else if (bestTier === 2) {
    ceiling = "warning";
    ceilingReason = "capped at warning: best source tier 2";
  } else {
    ceiling = "info";
    ceilingReason = "capped at info: best source tier 3";
  }

  // ── Apply ceiling to proposed severity ──────────────────────────
  const proposedRank = SEVERITY_RANK[proposedSeverity] ?? 1;
  const ceilingRank = SEVERITY_RANK[ceiling] ?? 1;

  const finalSeverity: "critical" | "warning" | "info" =
    proposedRank <= ceilingRank
      ? proposedSeverity
      : ceiling;

  // If the proposed was already within the ceiling, note that
  const finalReason =
    proposedRank <= ceilingRank
      ? `${ceilingReason} (proposed ${proposedSeverity} within ceiling)`
      : ceilingReason;

  return {
    severity: finalSeverity,
    ceilingReason: finalReason,
    needsRecheck,
  };
}
