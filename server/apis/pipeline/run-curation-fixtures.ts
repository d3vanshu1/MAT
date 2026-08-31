/**
 * Run DCS curation pure fixtures.
 * Executes the 13 deterministic tests and returns results.
 * No database access required — all tests are pure.
 */
import { api, z } from "@superblocksteam/sdk-api";
import { fixtureResults } from "./dcs-curation-fixtures.js";

export default api({
  name: "RunCurationFixtures",
  description: "Executes 13 pure curation fixtures and returns results",

  input: z.object({}),

  output: z.object({
    passed: z.number(),
    failed: z.number(),
    total: z.number(),
    allPassed: z.boolean(),
    results: z.array(
      z.object({
        fixture: z.number(),
        name: z.string(),
        pass: z.boolean(),
        detail: z.string(),
      }),
    ),
  }),

  async run() {
    return fixtureResults;
  },
});
