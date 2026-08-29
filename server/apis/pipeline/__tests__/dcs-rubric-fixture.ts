/**
 * DCS Rubric Fixture — pure-function test vectors.
 *
 * Imports ONLY pure exports from dcs-rubric. No Superblocks SDK,
 * no database integration, no model integration, no application API.
 * Not registered in server/apis/index.ts.
 */
import {
  classifyDocClass,
  computeDimensionState,
  computeHeadlineScore,
  SCORE_VALUES,
} from "../dcs-rubric.js";

import type { DocClass } from "../dcs-rubric.js";

// ── Result type ──────────────────────────────────────────────────

interface CaseResult {
  case: string;
  expected: string;
  actual: string;
  pass: boolean;
}

// ── classifyDocClass (7 cases) ───────────────────────────────────

const classifyDocClassCases: [string, string, string][] = [
  ["classifyDocClass: ic_memo", "narrative", "ic_memo"],
  ["classifyDocClass: cim", "narrative", "cim"],
  ["classifyDocClass: legal", "workproduct", "legal"],
  ["classifyDocClass: financial_model", "workproduct", "financial_model"],
  ["classifyDocClass: other", "narrative", "other"],
  ["classifyDocClass: totally_unknown_tag", "narrative", "totally_unknown_tag"],
  ["classifyDocClass: empty string", "narrative", ""],
];

const classifyResults: CaseResult[] = classifyDocClassCases.map(
  ([label, expected, input]) => {
    const actual = classifyDocClass(input);
    return { case: label, expected, actual, pass: actual === expected };
  },
);

// ── computeDimensionState (6 cases) ──────────────────────────────

type Row = { doc_class: DocClass; is_substantive: boolean };

const dimensionStateCases: [string, string, Row[]][] = [
  ["A: empty array", "absent", []],
  [
    "B: one narrative substantive",
    "asserted",
    [{ doc_class: "narrative", is_substantive: true }],
  ],
  [
    "C: three narrative substantive",
    "asserted",
    [
      { doc_class: "narrative", is_substantive: true },
      { doc_class: "narrative", is_substantive: true },
      { doc_class: "narrative", is_substantive: true },
    ],
  ],
  [
    "D: one workproduct non-substantive",
    "asserted",
    [{ doc_class: "workproduct", is_substantive: false }],
  ],
  [
    "E: one workproduct substantive",
    "evidenced",
    [{ doc_class: "workproduct", is_substantive: true }],
  ],
  [
    "F: narrative substantive + workproduct substantive",
    "evidenced",
    [
      { doc_class: "narrative", is_substantive: true },
      { doc_class: "workproduct", is_substantive: true },
    ],
  ],
];

const dimensionStateResults: CaseResult[] = dimensionStateCases.map(
  ([label, expected, input]) => {
    const actual = computeDimensionState(input);
    return { case: label, expected, actual, pass: actual === expected };
  },
);

// ── computeHeadlineScore (4 cases) ───────────────────────────────

const ev = SCORE_VALUES.evidenced; // 1.0
const as_ = SCORE_VALUES.asserted; // 0.5
const ab = SCORE_VALUES.absent; // 0

const headlineScoreCases: [string, string, { score_value: number }[]][] = [
  ["G: 10 evidenced", "10", Array(10).fill({ score_value: ev })],
  [
    "H: 6 evidenced, 2 asserted, 2 absent",
    "7",
    [
      ...Array(6).fill({ score_value: ev }),
      ...Array(2).fill({ score_value: as_ }),
      ...Array(2).fill({ score_value: ab }),
    ],
  ],
  ["I: 10 asserted", "5", Array(10).fill({ score_value: as_ })],
  ["J: 10 absent", "0", Array(10).fill({ score_value: ab })],
];

const headlineScoreResults: CaseResult[] = headlineScoreCases.map(
  ([label, expected, input]) => {
    const actual = computeHeadlineScore(input).toString();
    return { case: label, expected, actual, pass: actual === expected };
  },
);

// ── Aggregate ────────────────────────────────────────────────────

export const results: CaseResult[] = [
  ...classifyResults,
  ...dimensionStateResults,
  ...headlineScoreResults,
];

export const allPass: boolean = results.every((r) => r.pass);
