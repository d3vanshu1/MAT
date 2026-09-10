/**
 * excelDisplayRenderer.ts — Phase 4.3
 *
 * Renders value_raw + number_format into the string Excel shows a human.
 * Scoped to the top ~20 format codes observed in the CheckedUp workbooks.
 * Unresolvable formats return null with a reason — never the raw number.
 *
 * Rules:
 * - value_raw is NEVER modified
 * - percent: multiply for display only (0.045 → "4.5%")
 * - custom zero section: "--" or "–" for zero
 * - text substitution: "Yes"/"No"
 * - literal suffixes: 0.0"x"
 * - dates: per format code, in the workbook's date system
 * - fallback to raw number is NEVER allowed
 */

import { BUILTIN_NUM_FMTS } from "./excelBuiltinFormats.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DisplayResult {
  displayValue: string | null;
  reason: string | null;  // null when displayValue is set; set when displayValue is null
}

// ---------------------------------------------------------------------------
// Format string parser
// ---------------------------------------------------------------------------

/** Split a format string into up to 4 sections: positive, negative, zero, text */
function splitSections(fmt: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === ";" && !inQuote) {
      sections.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  sections.push(current);
  return sections;
}

/** Pick the right section for a value */
function pickSection(sections: string[], value: number): string {
  if (sections.length === 1) return sections[0];
  if (sections.length === 2) {
    return value >= 0 ? sections[0] : sections[1];
  }
  // 3 or 4 sections: positive, negative, zero, [text]
  if (value > 0) return sections[0];
  if (value < 0) return sections[1];
  return sections[2] ?? sections[0];
}

/**
 * Count decimal places in a format section.
 * Looks for digits after "." in the numeric portion.
 */
function countDecimals(section: string): number {
  // Strip quoted strings and escape sequences
  const stripped = section.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  const dotIdx = stripped.indexOf(".");
  if (dotIdx < 0) return 0;
  let count = 0;
  for (let i = dotIdx + 1; i < stripped.length; i++) {
    if (stripped[i] === "0" || stripped[i] === "#") count++;
    else break;
  }
  return count;
}

/** Check if section has percent */
function hasPercent(section: string): boolean {
  const stripped = section.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return stripped.includes("%");
}

/** Check if section has thousands separator (comma between # and 0) */
function hasThousandsSep(section: string): boolean {
  const stripped = section.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return /[#0],[#0]/.test(stripped);
}

/** Count trailing commas (scaling) */
function trailingCommas(section: string): number {
  const stripped = section.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  // Find the last digit placeholder
  let lastDigit = -1;
  for (let i = stripped.length - 1; i >= 0; i--) {
    if (stripped[i] === "0" || stripped[i] === "#") { lastDigit = i; break; }
  }
  if (lastDigit < 0) return 0;
  let commas = 0;
  for (let i = lastDigit + 1; i < stripped.length; i++) {
    if (stripped[i] === ",") commas++;
    else break;
  }
  return commas;
}

/** Format a number with thousands separator */
function formatWithCommas(n: number): string {
  const parts = n.toString().split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts.join(".");
}

/** Extract prefix/suffix literals from a section */
function extractLiterals(section: string): { prefix: string; suffix: string } {
  let prefix = "";
  let suffix = "";

  // Strip padding characters _X (where X is any char)
  let clean = section.replace(/_./g, "");

  // Extract leading literals (before first digit placeholder)
  let i = 0;
  while (i < clean.length) {
    if (clean[i] === '"') {
      const end = clean.indexOf('"', i + 1);
      if (end >= 0) {
        prefix += clean.substring(i + 1, end);
        i = end + 1;
      } else break;
    } else if (clean[i] === "\\") {
      prefix += clean[i + 1] ?? "";
      i += 2;
    } else if ("#0.,;%".includes(clean[i])) {
      break;
    } else if (clean[i] === "[" && clean[i + 1] === "$") {
      // Locale code like [$USD-409] or [$$] or [$$-380A]
      const end = clean.indexOf("]", i);
      if (end >= 0) {
        const inner = clean.substring(i + 2, end);
        const dash = inner.indexOf("-");
        const symbol = dash >= 0 ? inner.substring(0, dash) : inner;
        prefix += symbol || "$";
        i = end + 1;
      } else break;
    } else {
      i++;
    }
  }

  // Extract trailing literals (after last digit placeholder)
  const lastDigit = Math.max(clean.lastIndexOf("0"), clean.lastIndexOf("#"));
  if (lastDigit >= 0) {
    let j = lastDigit + 1;
    // Skip trailing commas (scaling)
    while (j < clean.length && clean[j] === ",") j++;
    // Skip percent (handled separately)
    while (j < clean.length) {
      if (clean[j] === '"') {
        const end = clean.indexOf('"', j + 1);
        if (end >= 0) {
          suffix += clean.substring(j + 1, end);
          j = end + 1;
        } else break;
      } else if (clean[j] === "\\") {
        suffix += clean[j + 1] ?? "";
        j += 2;
      } else if (clean[j] === "%") {
        suffix += "%";
        j++;
      } else {
        j++;
      }
    }
  }

  return { prefix, suffix };
}

/** Check if a section is a "wrap in parens" negative format */
function isParenNegative(section: string): boolean {
  const stripped = section.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return stripped.includes("(") && stripped.includes(")");
}

// ---------------------------------------------------------------------------
// Date rendering
// ---------------------------------------------------------------------------

/** Excel serial → JS Date (1900 date system, with leap year quirk at serial 60) */
function excelSerialToDate(serial: number, dateSystem1904: boolean): Date {
  if (dateSystem1904) {
    // 1904 system: day 0 = 1904-01-01
    return new Date(1904, 0, 1 + serial);
  }
  // 1900 system: day 1 = 1900-01-01, but Excel has a leap year bug at serial 60
  if (serial <= 60) {
    return new Date(1900, 0, serial);
  }
  return new Date(1900, 0, serial - 1);
}

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function renderDate(value: number, section: string, dateSystem1904: boolean): string {
  let d: Date;
  // Check if value looks like an ISO date string stored as a number (unlikely but defensive)
  if (value > 30000 && value < 80000) {
    d = excelSerialToDate(Math.floor(value), dateSystem1904);
  } else {
    // Value might already be a timestamp
    d = new Date(value);
    if (isNaN(d.getTime())) {
      d = excelSerialToDate(Math.floor(value), dateSystem1904);
    }
  }

  const yyyy = d.getFullYear();
  const yy = yyyy % 100;
  const mm = d.getMonth(); // 0-indexed
  const dd = d.getDate();

  // Simple format code rendering
  let result = section;
  // Strip padding and color codes
  result = result.replace(/_./g, "").replace(/\[.*?\]/g, "");

  result = result.replace(/yyyy/gi, yyyy.toString());
  result = result.replace(/yy/gi, yy.toString().padStart(2, "0"));
  result = result.replace(/mmmm/gi, MONTH_NAMES_FULL[mm]);
  result = result.replace(/mmm/gi, MONTH_NAMES_SHORT[mm]);
  result = result.replace(/mm/gi, (mm + 1).toString().padStart(2, "0"));
  result = result.replace(/(?<![hH])m(?![ms])/gi, (mm + 1).toString());
  result = result.replace(/dd/gi, dd.toString().padStart(2, "0"));
  result = result.replace(/(?<![d])d(?![d])/gi, dd.toString());

  // Clean up remaining format chars
  result = result.replace(/\\/g, "").replace(/;@/g, "");
  return result.trim();
}

/** Check if a format code is a date format */
function isDateFormat(fmt: string): boolean {
  const stripped = fmt.replace(/"[^"]*"/g, "").replace(/\\./g, "").toLowerCase();
  return /[ymd]/.test(stripped) && !/[#0]/.test(stripped);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a cell value using its Excel number format code.
 *
 * @param valueRaw - The raw numeric value from the cell (NEVER modified)
 * @param numberFormat - The Excel format string (null = General)
 * @param valueType - The cell's value_type ('number', 'date', 'string', etc.)
 * @param dateSystem1904 - Whether the workbook uses the 1904 date system
 * @returns DisplayResult with either displayValue or reason (never both, never raw fallback)
 */
export function renderDisplayValue(
  valueRaw: number,
  numberFormat: string | null,
  valueType: string | null,
  dateSystem1904: boolean = false,
): DisplayResult {
  // number_format stores the resolved format CODE string, not the numFmtId.
  // "0" means integer format, not built-in ID 0.
  let fmt = numberFormat;
  if (fmt === null || fmt === "General") {
    return { displayValue: null, reason: "general_format" };
  }

  // Year annotation formats: General"E"_), General"A"_), yyyy"A"_), yyyy"E"_)
  // These are period labels (2029E, 2025A), not date/numeric formats
  const yearAnnotation = fmt.match(/^(?:General|yyyy)"([^"]*)"(.*)$/);
  if (yearAnnotation) {
    return { displayValue: Math.round(valueRaw).toString() + yearAnnotation[1], reason: null };
  }

  // Hidden format
  if (fmt === ";;;") {
    return { displayValue: "", reason: null };
  }

  // Date format
  if (isDateFormat(fmt)) {
    try {
      const display = renderDate(valueRaw, fmt, dateSystem1904);
      return { displayValue: display, reason: null };
    } catch {
      return { displayValue: null, reason: "date_render_failed" };
    }
  }

  // Split into sections
  const sections = splitSections(fmt);
  const section = pickSection(sections, valueRaw);

  // Check for pure text/literal section (zero section like "--" or "–")
  if (valueRaw === 0 && sections.length >= 3) {
    // Extract the zero section's text content
    const zeroSection = sections[2];
    const textContent = zeroSection
      .replace(/_./g, "")
      .replace(/\\(.)/g, "$1")
      .replace(/"([^"]*)"/g, "$1")
      .replace(/[#0.,;%@]/g, "")
      .trim();
    if (textContent && !/[#0]/.test(zeroSection.replace(/"[^"]*"/g, ""))) {
      return { displayValue: textContent, reason: null };
    }
  }

  // Text substitution format (e.g., "Yes";"Yes";"No")
  const stripped = section.replace(/_./g, "");
  if (!/[#0]/.test(stripped.replace(/"[^"]*"/g, "").replace(/\\./g, ""))) {
    // No digit placeholders — pure text section
    const text = stripped
      .replace(/\\(.)/g, "$1")
      .replace(/"([^"]*)"/g, "$1")
      .replace(/@/g, "")
      .trim();
    if (text) {
      return { displayValue: text, reason: null };
    }
  }

  // Numeric rendering
  try {
    const isPercent = hasPercent(section);
    const decimals = countDecimals(section);
    const useCommas = hasThousandsSep(section);
    const trailing = trailingCommas(section);
    const isNeg = isParenNegative(section) && valueRaw < 0;
    const { prefix, suffix } = extractLiterals(section);

    let num = Math.abs(valueRaw);

    // Percent: multiply for display
    if (isPercent) num *= 100;

    // Trailing comma scaling
    if (trailing > 0) num /= Math.pow(1000, trailing);

    // Format the number
    let numStr = num.toFixed(decimals);

    // Add thousands separator
    if (useCommas) {
      const parts = numStr.split(".");
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      numStr = parts.join(".");
    }

    // Build the display string
    let display = prefix + numStr + suffix;

    // Negative in parens
    if (isNeg) {
      display = "(" + display + ")";
    } else if (valueRaw < 0 && !isPercent) {
      // Non-paren negative: add minus
      display = "-" + display;
    }

    return { displayValue: display, reason: null };
  } catch {
    return { displayValue: null, reason: "render_failed" };
  }
}
