/**
 * TestConcurrencyGuards — Verifies checkpoint write safety invariants.
 *
 * Exercises all 5 concurrency fixes against a temporary test node:
 *   A. pipeline-core partial/error writes respect WHERE status <> 'complete'
 *   B. CAS write ownership (checkpoint_version match required)
 *   C. Atomic node claiming (claimed_by guard)
 *   D. Stale-claim expiry (expired claims can be reclaimed)
 *   E. Completion immutability (complete nodes cannot be overwritten)
 *
 * Uses a synthetic run_id & node to avoid touching production data.
 * All test rows are cleaned up at the end regardless of pass/fail.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const TEST_RUN_ID = "00000000-0000-0000-0000-c0c0c0c0c0c0";
const TEST_LEVEL = 99;
const TEST_NODE = 99;

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

export default api({
  name: "TestConcurrencyGuards",
  description: "Exercises checkpoint write concurrency guards A-E against synthetic test rows",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    results: z.array(z.object({
      name: z.string(),
      passed: z.boolean(),
      detail: z.string(),
    })),
    allPassed: z.boolean(),
  }),

  async run(ctx) {
    const results: TestResult[] = [];

    // ---------------------------------------------------------------------------
    // Cleanup helper — ensures no test debris
    // ---------------------------------------------------------------------------
    const cleanup = async () => {
      await ctx.integrations.db.execute(
        `DELETE FROM merge_checkpoints WHERE module_run_id = $1`,
        [TEST_RUN_ID],
        { label: "Test cleanup" }
      );
    };

    try {
      await cleanup();

      // ─── Test A: pipeline-core WHERE guard blocks overwrite of 'complete' ───
      // 1. Insert a 'complete' checkpoint
      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status, checkpoint_version, payload_hash)
         VALUES ($1, $2, $3, '{"findings":["testA"]}'::jsonb, 'test-model', 'v1', 'complete', 1, md5(('{"findings":["testA"]}'::jsonb)::text))`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test A: seed complete checkpoint" }
      );

      // 2. Attempt pipeline-core-style overwrite with partial status (should be blocked)
      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
         VALUES ($1, $2, $3, '{"findings":["overwritten"]}'::jsonb, 'attacker-model', 'v2', 'partial')
         ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = '{"findings":["overwritten"]}'::jsonb, status = 'partial'
           WHERE merge_checkpoints.status <> 'complete'`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test A: attempt overwrite of complete with partial" }
      );

      // 3. Verify the original is preserved
      const checkA = await ctx.integrations.db.query(
        `SELECT status, merged_json::text AS payload FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
        z.object({ status: z.string(), payload: z.string() }),
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test A: verify" }
      );

      const testAPass = checkA.length === 1 && checkA[0].status === "complete" && checkA[0].payload.includes("testA");
      results.push({
        name: "A: Completion immutability (pipeline-core WHERE guard)",
        passed: testAPass,
        detail: testAPass
          ? "Complete checkpoint preserved despite partial overwrite attempt"
          : `FAILED: status=${checkA[0]?.status}, payload=${checkA[0]?.payload?.slice(0, 100)}`,
      });

      // ─── Test B: CAS write ownership (version mismatch rejected) ───────────
      await cleanup();

      // 1. Insert a claimed node with version=1
      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status, checkpoint_version, claimed_by, claimed_at)
         VALUES ($1, $2, $3, '{}'::jsonb, 'test', 'v1', 'claimed', 1, 'worker_alpha', now())`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test B: seed claimed checkpoint v1" }
      );

      // 2. CAS finalize with WRONG version (expect 2, actual 1) — should fail
      const casFail = await ctx.integrations.db.query(
        `UPDATE merge_checkpoints
         SET merged_json = '{"findings":["stale"]}'::jsonb, status = 'complete',
             claimed_by = NULL, claimed_at = NULL, checkpoint_version = checkpoint_version + 1
         WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3
           AND claimed_by = $4 AND checkpoint_version = $5
         RETURNING checkpoint_version`,
        z.object({ checkpoint_version: z.coerce.number() }),
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE, "worker_alpha", 2],
        { label: "Test B: CAS with wrong version" }
      );

      // 3. CAS finalize with CORRECT version (1) — should succeed
      const casOk = await ctx.integrations.db.query(
        `UPDATE merge_checkpoints
         SET merged_json = '{"findings":["correct"]}'::jsonb, status = 'complete',
             claimed_by = NULL, claimed_at = NULL, checkpoint_version = checkpoint_version + 1
         WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3
           AND claimed_by = $4 AND checkpoint_version = $5
         RETURNING checkpoint_version`,
        z.object({ checkpoint_version: z.coerce.number() }),
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE, "worker_alpha", 1],
        { label: "Test B: CAS with correct version" }
      );

      const testBPass = casFail.length === 0 && casOk.length === 1 && casOk[0].checkpoint_version === 2;
      results.push({
        name: "B: CAS write ownership (version mismatch rejected)",
        passed: testBPass,
        detail: testBPass
          ? "Wrong version rejected (0 rows), correct version accepted (v2)"
          : `FAILED: wrongVersionRows=${casFail.length}, rightVersionRows=${casOk.length}, newVersion=${casOk[0]?.checkpoint_version}`,
      });

      // ─── Test C: Atomic node claiming (only unclaimed/expired can be claimed) ─
      await cleanup();

      // 1. Insert a node with active claim (recent claimed_at)
      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status, checkpoint_version, claimed_by, claimed_at)
         VALUES ($1, $2, $3, '{}'::jsonb, 'test', 'v1', 'partial', 1, 'worker_alpha', now())`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test C: seed actively claimed node" }
      );

      // 2. Second worker attempts claim — should fail (active claim not expired)
      const claimReject = await ctx.integrations.db.query(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, status, claimed_by, claimed_at, checkpoint_version)
         VALUES ($1, $2, $3, '{}'::jsonb, 'claimed', 'worker_beta', now(), 1)
         ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE
           SET claimed_by = 'worker_beta', claimed_at = now(), checkpoint_version = merge_checkpoints.checkpoint_version + 1
           WHERE merge_checkpoints.status <> 'complete'
             AND (merge_checkpoints.claimed_by IS NULL OR merge_checkpoints.claimed_at < now() - interval '10 minutes')
             AND merge_checkpoints.checkpoint_version = $4
         RETURNING checkpoint_version`,
        z.object({ checkpoint_version: z.coerce.number() }),
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE, 1],
        { label: "Test C: second worker claim attempt" }
      );

      const testCPass = claimReject.length === 0;
      results.push({
        name: "C: Atomic node claiming (active claim blocks concurrent claim)",
        passed: testCPass,
        detail: testCPass
          ? "Second worker correctly rejected — active claim still held"
          : `FAILED: second claim returned ${claimReject.length} rows`,
      });

      // ─── Test D: Stale-claim expiry (expired claims can be reclaimed) ──────
      await cleanup();

      // 1. Insert a node with EXPIRED claim (claimed_at in distant past)
      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status, checkpoint_version, claimed_by, claimed_at)
         VALUES ($1, $2, $3, '{}'::jsonb, 'test', 'v1', 'partial', 1, 'worker_dead', now() - interval '15 minutes')`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test D: seed expired claim" }
      );

      // 2. New worker attempts claim — should succeed (old claim expired)
      const expiredClaim = await ctx.integrations.db.query(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, status, claimed_by, claimed_at, checkpoint_version)
         VALUES ($1, $2, $3, '{}'::jsonb, 'claimed', 'worker_new', now(), 1)
         ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE
           SET claimed_by = 'worker_new', claimed_at = now(), checkpoint_version = merge_checkpoints.checkpoint_version + 1
           WHERE merge_checkpoints.status <> 'complete'
             AND (merge_checkpoints.claimed_by IS NULL OR merge_checkpoints.claimed_at < now() - interval '10 minutes')
             AND merge_checkpoints.checkpoint_version = $4
         RETURNING checkpoint_version`,
        z.object({ checkpoint_version: z.coerce.number() }),
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE, 1],
        { label: "Test D: reclaim expired node" }
      );

      const testDPass = expiredClaim.length === 1 && expiredClaim[0].checkpoint_version === 2;
      results.push({
        name: "D: Stale-claim expiry (expired claims reclaimable)",
        passed: testDPass,
        detail: testDPass
          ? "Expired claim successfully reclaimed by new worker (v2)"
          : `FAILED: rows=${expiredClaim.length}, version=${expiredClaim[0]?.checkpoint_version}`,
      });

      // ─── Test E: Error write blocked by complete status ────────────────────
      await cleanup();

      // 1. Insert a 'complete' checkpoint
      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status, checkpoint_version, payload_hash)
         VALUES ($1, $2, $3, '{"findings":["production"]}'::jsonb, 'prod-model', 'v3', 'complete', 5, md5(('{"findings":["production"]}'::jsonb)::text))`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test E: seed complete node" }
      );

      // 2. Attempt error overwrite (like pipeline-core error path)
      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
         VALUES ($1, $2, $3, '{"error":"should not persist"}'::jsonb, 'err-model', 'v2', 'error')
         ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = '{"error":"should not persist"}'::jsonb, status = 'error'
           WHERE merge_checkpoints.status <> 'complete'`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test E: attempt error overwrite of complete" }
      );

      // 3. Verify original preserved
      const checkE = await ctx.integrations.db.query(
        `SELECT status, merged_json::text AS payload, checkpoint_version FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
        z.object({ status: z.string(), payload: z.string(), checkpoint_version: z.coerce.number() }),
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test E: verify" }
      );

      const testEPass = checkE.length === 1 && checkE[0].status === "complete" && checkE[0].payload.includes("production") && checkE[0].checkpoint_version === 5;
      results.push({
        name: "E: Error write blocked by complete status",
        passed: testEPass,
        detail: testEPass
          ? "Complete checkpoint preserved, error write rejected, version unchanged (5)"
          : `FAILED: status=${checkE[0]?.status}, version=${checkE[0]?.checkpoint_version}, payload=${checkE[0]?.payload?.slice(0, 80)}`,
      });

      // ─── Test F: ResumeStalePipelines exclusion (NOT EXISTS subquery logic) ────
      // Verifies the SQL predicate correctly excludes runs with active claims.
      // We test this using just the subquery pattern against merge_checkpoints
      // (avoids FK constraints on module_runs table).
      await cleanup();

      // Create a checkpoint with an active claim for our test run
      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, status, claimed_by, claimed_at, checkpoint_version)
         VALUES ($1, $2, $3, '{}'::jsonb, 'claimed', 'recovery_active', now(), 1)`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test F: seed active claim" }
      );

      // The NOT EXISTS subquery should return TRUE (i.e. claim exists, so NOT EXISTS = false)
      const hasActiveClaim = await ctx.integrations.db.query(
        `SELECT EXISTS (
           SELECT 1 FROM merge_checkpoints mc
           WHERE mc.module_run_id = $1
             AND mc.claimed_by IS NOT NULL
             AND mc.claimed_at > now() - interval '7 minutes'
         ) AS has_claim`,
        z.object({ has_claim: z.boolean() }),
        [TEST_RUN_ID],
        { label: "Test F: check active claim exists" }
      );

      // Also verify expired claims DON'T block (insert an expired claim row)
      await ctx.integrations.db.execute(
        `UPDATE merge_checkpoints SET claimed_at = now() - interval '15 minutes'
         WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test F: expire the claim" }
      );

      const hasExpiredClaim = await ctx.integrations.db.query(
        `SELECT EXISTS (
           SELECT 1 FROM merge_checkpoints mc
           WHERE mc.module_run_id = $1
             AND mc.claimed_by IS NOT NULL
             AND mc.claimed_at > now() - interval '7 minutes'
         ) AS has_claim`,
        z.object({ has_claim: z.boolean() }),
        [TEST_RUN_ID],
        { label: "Test F: check expired claim doesn't block" }
      );

      const testFPass = hasActiveClaim[0]?.has_claim === true && hasExpiredClaim[0]?.has_claim === false;
      results.push({
        name: "F: ResumeStalePipelines exclusion (active claim blocks, expired allows)",
        passed: testFPass,
        detail: testFPass
          ? "Active claim blocks pickup (has_claim=true), expired claim allows pickup (has_claim=false)"
          : `FAILED: activeClaim=${hasActiveClaim[0]?.has_claim}, expiredClaim=${hasExpiredClaim[0]?.has_claim}`,
      });

      // ─── Test G: Canonical JSON hashing (payload_hash = md5((jsonb)::text)) ────
      // Proves the canonical hashing invariant: payload_hash is the MD5 of the
      // PostgreSQL-canonicalized jsonb text representation. Prior bug: `md5($4)`
      // passed raw jsonb type to md5() → "function md5(jsonb) does not exist".
      //
      // Assertions:
      //   G1. Different whitespace, same JSON content → same hash
      //   G2. Different key ordering, same JSON content → same hash
      //   G3. Substantive value change → different hash
      //   G4. Production INSERT stored hash == md5(merged_json::text) read back
      //   G5. NULL payload fails closed (no hash generated)
      await cleanup();

      // --- G1: Whitespace normalization ---
      // These are the same JSON value with different whitespace:
      const compact = '{"a":1,"b":2}';
      const spacey  = '{  "a" : 1 ,  "b" : 2  }';

      const g1 = await ctx.integrations.db.query(
        `SELECT md5(($1::jsonb)::text) AS h1, md5(($2::jsonb)::text) AS h2`,
        z.object({ h1: z.string(), h2: z.string() }),
        [compact, spacey],
        { label: "Test G1: whitespace normalization" }
      );
      const g1Pass = g1[0]?.h1 === g1[0]?.h2;

      // --- G2: Key ordering normalization ---
      const keysAB = '{"a":1,"b":2}';
      const keysBA = '{"b":2,"a":1}';

      const g2 = await ctx.integrations.db.query(
        `SELECT md5(($1::jsonb)::text) AS h1, md5(($2::jsonb)::text) AS h2`,
        z.object({ h1: z.string(), h2: z.string() }),
        [keysAB, keysBA],
        { label: "Test G2: key order normalization" }
      );
      const g2Pass = g2[0]?.h1 === g2[0]?.h2;

      // --- G3: Substantive value change → different hash ---
      const original = '{"findings":["alpha","beta"]}';
      const mutated  = '{"findings":["alpha","gamma"]}';

      const g3 = await ctx.integrations.db.query(
        `SELECT md5(($1::jsonb)::text) AS h_orig, md5(($2::jsonb)::text) AS h_mut`,
        z.object({ h_orig: z.string(), h_mut: z.string() }),
        [original, mutated],
        { label: "Test G3: value change → different hash" }
      );
      const g3Pass = g3[0]?.h_orig !== g3[0]?.h_mut;

      // --- G4: Production INSERT stored hash == md5(merged_json::text) read-back ---
      // Simulates the exact CAS finalize expression: md5(($4::jsonb)::text)
      const prodPayload = '{ "findings": ["test_g4"] , "meta": {"v":1} }';

      await ctx.integrations.db.execute(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status, checkpoint_version, payload_hash)
         VALUES ($1, $2, $3, $4::jsonb, 'test', 'v1', 'complete', 1, md5(($4::jsonb)::text))`,
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE, prodPayload],
        { label: "Test G4: insert with canonical md5(($4::jsonb)::text)" }
      );

      const g4 = await ctx.integrations.db.query(
        `SELECT
           payload_hash AS stored_hash,
           md5(merged_json::text) AS recomputed,
           pg_typeof(merged_json::text) AS cast_type
         FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
        z.object({ stored_hash: z.string(), recomputed: z.string(), cast_type: z.string() }),
        [TEST_RUN_ID, TEST_LEVEL, TEST_NODE],
        { label: "Test G4: verify stored == recomputed" }
      );
      const g4Pass = g4[0] != null
        && g4[0].stored_hash === g4[0].recomputed
        && g4[0].cast_type === "text";

      // --- G5: NULL or invalid JSON fails closed ---
      // md5((NULL::jsonb)::text) should return NULL, not a hash.
      // Invalid JSON should raise an error (caught), not produce a hash.
      const g5Null = await ctx.integrations.db.query(
        `SELECT md5((NULL::jsonb)::text) AS null_hash`,
        z.object({ null_hash: z.string().nullable() }),
        [],
        { label: "Test G5: NULL jsonb → NULL hash" }
      );
      const nullProducesNull = g5Null[0]?.null_hash === null;

      let invalidJsonThrows = false;
      try {
        await ctx.integrations.db.query(
          `SELECT md5(($1::jsonb)::text) AS bad_hash`,
          z.object({ bad_hash: z.string() }),
          ["{not valid json!!!}"],
          { label: "Test G5: invalid JSON should throw" }
        );
      } catch {
        invalidJsonThrows = true;
      }
      const g5Pass = nullProducesNull && invalidJsonThrows;

      // --- Aggregate ---
      const allGPass = g1Pass && g2Pass && g3Pass && g4Pass && g5Pass;
      const details = [
        `G1(whitespace)=${g1Pass}[${g1[0]?.h1?.slice(0,8)}==${g1[0]?.h2?.slice(0,8)}]`,
        `G2(keyOrder)=${g2Pass}[${g2[0]?.h1?.slice(0,8)}==${g2[0]?.h2?.slice(0,8)}]`,
        `G3(valueDiff)=${g3Pass}[${g3[0]?.h_orig?.slice(0,8)}!=${g3[0]?.h_mut?.slice(0,8)}]`,
        `G4(storedEqRecomputed)=${g4Pass}[${g4[0]?.stored_hash?.slice(0,8)}==${g4[0]?.recomputed?.slice(0,8)},type=${g4[0]?.cast_type}]`,
        `G5(failClosed)=${g5Pass}[null→null=${nullProducesNull},invalidThrows=${invalidJsonThrows}]`,
      ].join("; ");

      results.push({
        name: "G: Canonical JSON hashing (md5((jsonb)::text) invariants)",
        passed: allGPass,
        detail: allGPass ? `All sub-assertions pass: ${details}` : `FAILED: ${details}`,
      });

    } finally {
      // Always clean up test data
      await cleanup();
    }

    const allPassed = results.every(r => r.passed);
    return { results, allPassed };
  },
});