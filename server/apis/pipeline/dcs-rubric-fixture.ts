/**
 * DCS Rubric Fixture — exercises classifyDocClass, computeDimensionState,
 * and computeHeadlineScore with prescribed test vectors.
 * Reports raw actual values for each case.
 */
import { api, z } from "@superblocksteam/sdk-api";
import {
  classifyDocClass,
  computeDimensionState,
  computeHeadlineScore,
  SCORE_VALUES,
  type DocClass,
} from "./dcs-rubric.js";

const CaseResult = z.object({
  case: z.string(),
  expected: z.string(),
  actual: z.string(),
  match: z.boolean(),
});

export default api({
  name: "DcsRubricFixture",
  description: "Fixture verification for dcs-rubric pure functions",

  input: z.object({}),

  output: z.object({
    classifyDocClass: z.array(CaseResult),
    computeDimensionState: z.array(CaseResult),
    computeHeadlineScore: z.array(CaseResult),
    allPass: z.boolean(),
  }),

  async run() {
    const results = {
      classifyDocClass: [] as z.infer<typeof CaseResult>[],
      computeDimensionState: [] as z.infer<typeof CaseResult>[],
      computeHeadlineScore: [] as z.infer<typeof CaseResult>[],
    };

    // ── classifyDocClass ──────────────────────────────────────────
    const docClassCases: [string, string, string][] = [
      ["ic_memo", "narrative", "ic_memo"],
      ["cim", "narrative", "cim"],
      ["legal", "workproduct", "legal"],
      ["financial_model", "workproduct", "financial_model"],
      ["other", "narrative", "other"],
      ["totally_unknown_tag", "narrative", "totally_unknown_tag"],
      ["empty_string", "narrative", ""],
    ];
    for (const [label, expected, input] of docClassCases) {
      const actual = classifyDocClass(input);
      results.classifyDocClass.push({
        case: label,
        expected,
        actual,
        match: actual === expected,
      });
    }

    // ── computeDimensionState ─────────────────────────────────────
    type Row = { doc_class: DocClass; is_substantive: boolean };

    const dimStateCases: [string, string, Row[]][] = [
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
        "F: narrative true + workproduct true",
        "evidenced",
        [
          { doc_class: "narrative", is_substantive: true },
          { doc_class: "workproduct", is_substantive: true },
        ],
      ],
    ];
    for (const [label, expected, input] of dimStateCases) {
      const actual = computeDimensionState(input);
      results.computeDimensionState.push({
        case: label,
        expected,
        actual,
        match: actual === expected,
      });
    }

    // ── computeHeadlineScore ──────────────────────────────────────
    const ev = SCORE_VALUES.evidenced;  // 1.0
    const as = SCORE_VALUES.asserted;   // 0.5
    const ab = SCORE_VALUES.absent;     // 0

    const scoreCases: [string, string, { score_value: number }[]][] = [
      [
        "G: 10 evidenced",
        "10",
        Array(10).fill({ score_value: ev }),
      ],
      [
        "H: 6 evidenced, 2 asserted, 2 absent",
        "7",
        [
          ...Array(6).fill({ score_value: ev }),
          ...Array(2).fill({ score_value: as }),
          ...Array(2).fill({ score_value: ab }),
        ],
      ],
      [
        "I: 0 evidenced, 10 asserted",
        "5",
        Array(10).fill({ score_value: as }),
      ],
      [
        "J: 10 absent",
        "0",
        Array(10).fill({ score_value: ab }),
      ],
    ];
    for (const [label, expected, input] of scoreCases) {
      const actual = computeHeadlineScore(input).toString();
      results.computeHeadlineScore.push({
        case: label,
        expected,
        actual,
        match: actual === expected,
      });
    }

    const allPass = [
      ...results.classifyDocClass,
      ...results.computeDimensionState,
      ...results.computeHeadlineScore,
    ].every((r) => r.match);

    return { ...results, allPass };
  },
});
