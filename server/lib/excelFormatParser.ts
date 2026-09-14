/**
 * Excel Number Format Parser
 *
 * Parses Excel format strings to extract:
 *   - unit_class: currency | percent | multiple | count | ratio | date | text
 *   - currency: USD | GBP | EUR | null
 *   - decimals: digit count after decimal point in the first section
 *   - scaleFromFormat: trailing-comma scaling (1, 1000, 1000000)
 *
 * Single source of truth for format classification — used by the server-side
 * Phase 4 processor.
 *
 * Excel format string structure: positive ; negative ; zero ; text
 * Most bugs come from reading only the first section.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatParseResult {
  unitClass: "currency" | "percent" | "multiple" | "count" | "ratio" | "date" | "text";
  currency: string | null;        // USD, GBP, EUR, etc.
  decimals: number;               // digit count after decimal in first section
  scaleFromFormat: number;        // 1, 1000, 1000000 from trailing commas
  zeroDisplay: string | null;     // what the zero section renders (e.g. "--", "–")
  negativeInParens: boolean;      // true if negative section uses parentheses
  isTextSubstitution: boolean;    // true if format is purely literal text per section
  literalSuffix: string | null;   // e.g. "x", "Mo.", "Years"
}

// ---------------------------------------------------------------------------
// Currency symbol map
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  "$": "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
  "₩": "KRW",
  "₹": "INR",
  "₽": "RUB",
  "R$": "BRL",
  "CHF": "CHF",
};

// Locale codes in [$...-xxx] format — map to currency
const LOCALE_CURRENCY: Record<string, string> = {
  "$$": "USD",
  "$$-409": "USD",       // en-US
  "$$-380A": "USD",      // locale variant
  "£-809": "GBP",       // en-GB
  "€-407": "EUR",       // de-DE
};

// ---------------------------------------------------------------------------
// Date format codes
// ---------------------------------------------------------------------------

const DATE_CODES = /\b(yyyy|yy|mmm{1,4}|dd?|h{1,2}|ss?|AM\/PM)\b/i;
// More precise: check for date-specific tokens not ambiguous with number formats
// "mm" is ambiguous (minutes vs months) but in combo with d/y/h it's a date
const DATE_PATTERN = /(^|[^\\])([dhy]|mmm|AM\/PM)/i;

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse an Excel number format string and classify it.
 *
 * @param fmt  The format string (e.g. `#,##0.0_);\(#,##0.0\);"--"_)`)
 * @param valueType  Optional: the cell's value_type for General fallback
 * @returns  Parsed classification, or null if fmt is null/empty
 */
export function parseExcelFormat(fmt: string | null, valueType?: string): FormatParseResult | null {
  if (!fmt || !fmt.trim()) return null;

  const trimmed = fmt.trim();

  // Split into sections: positive ; negative ; zero ; text
  // Respect escaped semicolons (\;) and quoted strings ("...")
  const sections = splitFormatSections(trimmed);
  const posSection = sections[0] ?? "";
  const negSection = sections[1] ?? "";
  const zeroSection = sections[2] ?? "";

  // --- Text substitution detection ---
  // Formats like "Yes"_);"Yes"_);"No"_) — all sections are literal text
  if (isTextSubstitution(posSection) && sections.length >= 3) {
    return {
      unitClass: "text",
      currency: null,
      decimals: 0,
      scaleFromFormat: 1,
      zeroDisplay: extractLiteralText(zeroSection),
      negativeInParens: false,
      isTextSubstitution: true,
      literalSuffix: null,
    };
  }

  // --- Hidden format ---
  if (trimmed === ";;;" || trimmed === ";;;") {
    return {
      unitClass: "text",
      currency: null,
      decimals: 0,
      scaleFromFormat: 1,
      zeroDisplay: "",
      negativeInParens: false,
      isTextSubstitution: false,
      literalSuffix: null,
    };
  }

  // --- General format ---
  // General, General"E", General"A", General")", General "Years"
  if (/^General/i.test(posSection)) {
    const literalMatch = posSection.match(/General\s*(?:\\.|"([^"]*)")/i);
    const literal = literalMatch
      ? (literalMatch[1] ?? posSection.replace(/^General\s*/i, "").replace(/[\\_ )]/g, ""))
      : null;
    return {
      unitClass: literal ? "text" : inferFromValueType(valueType),
      currency: null,
      decimals: 0,
      scaleFromFormat: 1,
      zeroDisplay: null,
      negativeInParens: false,
      isTextSubstitution: false,
      literalSuffix: literal,
    };
  }

  // --- @ (text format) ---
  if (/^@/.test(posSection.replace(/\\./g, "").replace(/"[^"]*"/g, ""))) {
    // Text format with optional footnote suffixes
    return {
      unitClass: "text",
      currency: null,
      decimals: 0,
      scaleFromFormat: 1,
      zeroDisplay: null,
      negativeInParens: false,
      isTextSubstitution: false,
      literalSuffix: null,
    };
  }

  // --- Date detection ---
  // Check for date codes in the format (before checking for numeric patterns)
  if (DATE_PATTERN.test(posSection)) {
    return {
      unitClass: "date",
      currency: null,
      decimals: 0,
      scaleFromFormat: 1,
      zeroDisplay: null,
      negativeInParens: false,
      isTextSubstitution: false,
      literalSuffix: null,
    };
  }

  // --- Percent detection ---
  // % anywhere in the positive section (outside quotes and escapes)
  if (containsUnescaped(posSection, "%")) {
    const currency = extractCurrency(posSection);
    return {
      unitClass: "percent",
      currency: currency,
      decimals: countDecimals(posSection),
      scaleFromFormat: 1, // percent format doesn't have trailing-comma scaling
      zeroDisplay: extractZeroDisplay(zeroSection),
      negativeInParens: hasParenNeg(negSection),
      isTextSubstitution: false,
      literalSuffix: extractLiteralSuffix(posSection),
    };
  }

  // --- Currency detection ---
  const currency = extractCurrency(posSection);
  if (currency) {
    return {
      unitClass: "currency",
      currency,
      decimals: countDecimals(posSection),
      scaleFromFormat: countTrailingCommaScale(posSection),
      zeroDisplay: extractZeroDisplay(zeroSection),
      negativeInParens: hasParenNeg(negSection),
      isTextSubstitution: false,
      literalSuffix: null,
    };
  }

  // --- Multiple detection ---
  // \x suffix (escaped literal "x")
  if (/\\x/.test(posSection)) {
    return {
      unitClass: "multiple",
      currency: null,
      decimals: countDecimals(posSection),
      scaleFromFormat: 1,
      zeroDisplay: extractZeroDisplay(zeroSection),
      negativeInParens: hasParenNeg(negSection),
      isTextSubstitution: false,
      literalSuffix: "x",
    };
  }

  // --- Literal suffix detection ---
  // "Mo.", "Years", "S + " prefix with percent
  const literalSuffix = extractLiteralSuffix(posSection);
  if (literalSuffix) {
    // Check if it contains percent after the literal
    if (containsUnescaped(posSection, "%")) {
      return {
        unitClass: "percent",
        currency: null,
        decimals: countDecimals(posSection),
        scaleFromFormat: 1,
        zeroDisplay: extractZeroDisplay(zeroSection),
        negativeInParens: hasParenNeg(negSection),
        isTextSubstitution: false,
        literalSuffix,
      };
    }
  }

  // --- Plain numeric ---
  const decimals = countDecimals(posSection);
  const scale = countTrailingCommaScale(posSection);

  return {
    unitClass: decimals === 0 ? "count" : "ratio",
    currency: null,
    decimals,
    scaleFromFormat: scale,
    zeroDisplay: extractZeroDisplay(zeroSection),
    negativeInParens: hasParenNeg(negSection),
    isTextSubstitution: false,
    literalSuffix: literalSuffix,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split format string by unescaped, unquoted semicolons.
 */
function splitFormatSections(fmt: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuote = false;
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
      i++;
    } else if (ch === "\\" && !inQuote && i + 1 < fmt.length) {
      current += ch + fmt[i + 1];
      i += 2;
    } else if (ch === ";" && !inQuote) {
      sections.push(current);
      current = "";
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Check if a character appears outside quotes and escapes.
 */
function containsUnescaped(section: string, char: string): boolean {
  let inQuote = false;
  for (let i = 0; i < section.length; i++) {
    if (section[i] === '"') { inQuote = !inQuote; continue; }
    if (section[i] === "\\" && !inQuote) { i++; continue; }
    // '_' means "pad with the width of next char" — skip the next char entirely
    if (section[i] === "_" && !inQuote) { i++; continue; }
    if (section[i] === char && !inQuote) return true;
  }
  return false;
}

/**
 * Count decimal places from the first section's digit pattern.
 * Looks for 0s and #s after the decimal point.
 */
function countDecimals(section: string): number {
  // Strip quoted text and escape sequences to find the digit pattern
  const stripped = section.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  // Find decimal point followed by 0s or #s
  const match = stripped.match(/\.([0#]+)/);
  return match ? match[1].length : 0;
}

/**
 * Count trailing commas before the end of the digit pattern.
 * Each trailing comma scales by 1000x.
 * e.g. #,##0, → 1000, #,##0,, → 1000000
 */
function countTrailingCommaScale(section: string): number {
  // Strip quoted text and escape sequences
  const stripped = section.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  // Find the digit pattern and count trailing commas
  // Trailing commas come after the last digit placeholder (0 or #)
  // but before any spacing/alignment chars (_) % etc
  const match = stripped.match(/[0#](,+)(?=[^0-9#,]|$)/);
  if (!match) return 1;
  const commaCount = match[1].length;
  return Math.pow(1000, commaCount);
}

/**
 * Extract currency symbol from a format section.
 */
function extractCurrency(section: string): string | null {
  // Check for locale-style currency: [$USD-409], [$$], [$$-380A]
  const localeMatch = section.match(/\[(\$[^\]]*)\]/);
  if (localeMatch) {
    const code = localeMatch[1];
    // Try direct lookup
    for (const [key, val] of Object.entries(LOCALE_CURRENCY)) {
      if (code === key) return val;
    }
    // [$X-nnn] pattern where X is the symbol
    const symMatch = code.match(/^\$(.+?)(?:-[0-9A-Fa-f]+)?$/);
    if (symMatch) {
      const sym = symMatch[1];
      if (sym === "$" || sym === "") return "USD";
      return CURRENCY_SYMBOLS[sym] ?? sym;
    }
    return "USD"; // fallback for [$...] patterns
  }

  // Check for literal currency symbols: "$", "£", "€"
  // These appear either as "X" quoted or escaped \X or bare
  const quotedMatch = section.match(/"([$£€¥₩₹₽]|R\$|CHF)"/);
  if (quotedMatch) return CURRENCY_SYMBOLS[quotedMatch[1]] ?? "USD";

  // Bare $ in format (common: "$"#,##0.0)
  if (containsUnescaped(section, "$")) return "USD";

  return null;
}

/**
 * Extract the zero-section display string.
 */
function extractZeroDisplay(zeroSection: string): string | null {
  if (!zeroSection) return null;
  const literal = extractLiteralText(zeroSection);
  if (literal) return literal;
  return null;
}

/**
 * Extract literal text from a format section (inside quotes).
 */
function extractLiteralText(section: string): string | null {
  const match = section.match(/"([^"]*)"/);
  return match ? match[1] : null;
}

/**
 * Check if the negative section uses parentheses.
 */
function hasParenNeg(negSection: string): boolean {
  if (!negSection) return false;
  return /\(/.test(negSection) || /\\[()]/.test(negSection);
}

/**
 * Check if a section is purely a text substitution (all content in quotes/escapes).
 */
function isTextSubstitution(section: string): boolean {
  // Strip quotes, escapes, spacing chars, and check if only placeholders remain
  const stripped = section
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_ )(]/g, "")
    .replace(/%/g, "")
    .trim();
  // If no digit placeholders remain, it's text
  return stripped.length === 0 || !/[0#.,]/.test(stripped);
}

/**
 * Extract literal suffix from a format section.
 * e.g. 0.0\x → "x", 0 "Mo." → "Mo.", "S + "0.0% → "S + "
 */
function extractLiteralSuffix(section: string): string | null {
  // Check for escaped literal at end: \x, \⁽, etc.
  const escapedMatch = section.match(/\\([a-zA-Z])(?:[_ )]*$|(?=\\[⁽⁾¹²³⁴]))/);
  if (escapedMatch && escapedMatch[1] !== "(" && escapedMatch[1] !== ")") {
    return escapedMatch[1];
  }

  // Check for quoted literal: "Mo.", "Years", etc.
  const quotedSuffix = section.match(/"([^"]+)"\s*(?:[_ )]*$)/);
  if (quotedSuffix && !/^[$£€¥-]+$/.test(quotedSuffix[1]) && !/^-+$/.test(quotedSuffix[1])) {
    return quotedSuffix[1];
  }

  // Check for quoted prefix: "S + "0.0%
  const quotedPrefix = section.match(/^(?:[_ (]*)"([^"]+)"/);
  if (quotedPrefix && !/^[$£€¥-]+$/.test(quotedPrefix[1])) {
    return quotedPrefix[1];
  }

  return null;
}

/**
 * Infer unit_class from value_type when format is General.
 */
function inferFromValueType(valueType?: string): "currency" | "percent" | "multiple" | "count" | "ratio" | "date" | "text" {
  if (!valueType) return "count";
  switch (valueType) {
    case "date": return "date";
    case "text": case "string": return "text";
    case "boolean": return "text";
    default: return "count";
  }
}

// ---------------------------------------------------------------------------
// R4: Display value renderer
// ---------------------------------------------------------------------------

/**
 * Format a raw numeric value the way Excel would display it.
 *
 * This renders the number per its format code — commas, decimals, percent
 * multiply, currency symbols, negative-in-parens, zero-as-dash.
 * Returns null when the format code isn't recognised (never a fallback
 * to the raw number).
 */
export function formatDisplayValue(value: number | null, fmt: string | null): string | null {
  if (value === null || value === undefined) return null;
  if (!fmt || fmt === "General") {
    // General: Excel's default — show as-is with reasonable precision
    if (Number.isInteger(value)) return String(value);
    return value.toPrecision(10).replace(/\.?0+$/, "");
  }

  const sections = splitFormatSections(fmt);
  // Select section: positive;negative;zero;text
  let section: string;
  if (value > 0) {
    section = sections[0];
  } else if (value < 0) {
    section = sections.length > 1 ? sections[1] : sections[0];
  } else {
    section = sections.length > 2 ? sections[2] : sections[0];
  }

  if (!section) return null;

  // --- Zero section: literal text like "--", "–", " - " ---
  if (value === 0) {
    // Extract quoted literal from zero section
    const zeroLit = extractQuotedText(section);
    if (zeroLit !== null) return zeroLit;
  }

  // --- Determine if percent format ---
  const isPercent = containsUnescaped(section, "%");
  let num = isPercent ? value * 100 : value;

  // For negative section, work with absolute value (parens/minus in format)
  const isNeg = num < 0;
  if (isNeg && sections.length > 1) num = Math.abs(num);

  // --- Count trailing comma scale in format (display-level, not storage) ---
  // Already accounted for in value_raw by Phase 4, so don't re-apply.
  // Format trailing commas affect what we show, but value_raw is pre-scaled.

  // --- Count decimal places from format ---
  const decimals = countDecimals(section);

  // --- Format the number ---
  // Check for comma grouping
  const hasComma = containsUnescaped(section, ",");
  let formatted: string;
  if (hasComma) {
    // Comma-separated with fixed decimals
    const parts = Math.abs(num).toFixed(decimals).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    formatted = parts.join(".");
  } else {
    formatted = Math.abs(num).toFixed(decimals);
  }

  // --- Prefix: currency symbol ---
  let prefix = "";
  // "$" or [$$] or "£" etc.
  const dollarMatch = section.match(/(?:"\$"|\[\$\$[^\]]*\])/);
  if (dollarMatch) prefix = "$";
  else if (containsUnescaped(section, "£")) prefix = "£";
  else if (containsUnescaped(section, "€")) prefix = "€";

  // --- Suffix ---
  let suffix = "";
  if (isPercent) suffix = "%";
  // Literal suffix like "x"
  const litSuf = extractLiteralSuffix(section);
  if (litSuf && !isPercent) suffix = litSuf;

  // --- Negative display ---
  if (isNeg) {
    if (hasParenNeg(section) || (sections.length > 1 && section.includes("("))) {
      formatted = `(${prefix}${formatted}${suffix})`;
    } else {
      formatted = `-${prefix}${formatted}${suffix}`;
    }
  } else {
    formatted = `${prefix}${formatted}${suffix}`;
  }

  return formatted;
}

/**
 * Extract quoted literal text from a format section.
 * Used for zero-display like "--", "–", " - ".
 */
function extractQuotedText(section: string): string | null {
  const parts: string[] = [];
  let i = 0;
  let hasQuoted = false;
  while (i < section.length) {
    if (section[i] === '"') {
      hasQuoted = true;
      i++;
      let lit = "";
      while (i < section.length && section[i] !== '"') {
        lit += section[i];
        i++;
      }
      if (lit.trim()) parts.push(lit);
      i++; // skip closing quote
    } else if (section[i] === '\\' && i + 1 < section.length) {
      // Escaped literal: \- becomes -
      parts.push(section[i + 1]);
      hasQuoted = true;
      i += 2;
    } else {
      i++;
    }
  }
  if (!hasQuoted) return null;
  const result = parts.join("").trim();
  return result || null;
}
