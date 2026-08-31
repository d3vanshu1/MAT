/**
 * mast-register-assemble.ts
 *
 * MAST v2 — register_assemble stage.
 *
 * Reads every mast_assumptions row for the current run, assigns dedup_group_id
 * according to Rules A, B, and D, then writes back the column.  Rule C is
 * deferred to the reliance_links stage.
 *
 * Runs as a single-shot (not in LOOP_STAGES).  Idempotent — resets all
 * dedup_group_ids for the run before computing.
 *
 * ── GROUPING RULES ──────────────────────────────────────────────────────────
 *
 * Rule A (model_explicit only):
 *   Same sheet (parsed from origin_locator), same value, same period,
 *   non-empty label portion of proposition.  Minimum cluster size 3.
 *   Canonical = row with lowest origin_locator.
 *
 * Rule B (model_implicit + model_explicit, applied after A):
 *   Parse sheet and row number from A1 address in origin_locator.
 *   Same sheet + same row → group.  model_implicit is canonical.
 *   If a model_explicit row already belongs to a Rule A cluster, the
 *   entire Rule A cluster is absorbed into the Rule B group.
 *
 * Rule C: not implemented here — handled by reliance_links stage.
 *
 * Rule D (memo_prose only):
 *   Normalize proposition text (lowercase, non-alnum → space, collapse,
 *   trim).  Exact match → group.  Canonical = lowest origin_locator.
 *
 * ── FAIL CLOSED ─────────────────────────────────────────────────────────────
 *   If any of the three origin_types (model_explicit, model_implicit,
 *   memo_prose) has zero rows, throw naming the missing type.
 */

import { z } from "@superblocksteam/sdk-api";
import type {
  StageContext,
  StageResult,
  StageHandler,
} from "./mast-contract.js";

const LOG_PREFIX = "[MAST-ASSEMBLE]";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AssumptionRowSchema = z.object({
  id: z.string(),
  origin_type: z.string(),
  origin_locator: z.string().nullable(),
  proposition: z.string(),
  value: z.any().nullable(),
  period: z.string().nullable(),
});

type AssumptionRow = z.infer<typeof AssumptionRowSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Same normalize as memo gate:
 * lowercase, replace every non-letter/digit/space with a single space,
 * collapse all whitespace runs to one space, trim.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse an origin_locator like "Sheet1!B14" into { sheet, row }.
 * Returns null if the locator cannot be parsed.
 */
function parseLocator(
  locator: string | null,
): { sheet: string; row: number; raw: string } | null {
  if (!locator) return null;
  // Expected format:  SheetName!CellRef   e.g. "Revenue!B14"
  const bangIdx = locator.lastIndexOf("!");
  if (bangIdx < 0) return null;
  const sheet = locator.slice(0, bangIdx);
  const cellRef = locator.slice(bangIdx + 1);
  // Extract numeric row from A1 ref (e.g. "B14" → 14, "AA3" → 3)
  const m = cellRef.match(/(\d+)$/);
  if (!m) return null;
  return { sheet, row: parseInt(m[1], 10), raw: locator };
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const registerAssemble: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, runId, dealId } = ctx;

  // ── 1. Reset all dedup_group_ids for this run (idempotent) ──────────
  await db.execute(
    `UPDATE mast_assumptions SET dedup_group_id = NULL WHERE run_id = $1`,
    [runId],
    { label: `${LOG_PREFIX} reset dedup_group_ids` },
  );

  // ── 2. Read all rows in batches of 5000, ordered by id ─────────────
  const allRows: AssumptionRow[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  const BATCH_SIZE = 5000;

  while (true) {
    const batch = await db.query(
      `SELECT id, origin_type, origin_locator, proposition, value, period
         FROM mast_assumptions
        WHERE run_id = $1 AND id > $2
        ORDER BY id
        LIMIT $3`,
      AssumptionRowSchema,
      [runId, lastId, BATCH_SIZE],
      { label: `${LOG_PREFIX} fetch batch after ${lastId.slice(0, 8)}` },
    );
    if (batch.length === 0) break;
    allRows.push(...batch);
    lastId = batch[batch.length - 1].id;
    if (batch.length < BATCH_SIZE) break;
  }

  console.log(`${LOG_PREFIX} Total rows: ${allRows.length}`);

  // ── 3. Partition by origin_type ────────────────────────────────────
  const modelExplicit: AssumptionRow[] = [];
  const modelImplicit: AssumptionRow[] = [];
  const memoProse: AssumptionRow[] = [];

  for (const row of allRows) {
    switch (row.origin_type) {
      case "model_explicit":
        modelExplicit.push(row);
        break;
      case "model_implicit":
        modelImplicit.push(row);
        break;
      case "memo_prose":
        memoProse.push(row);
        break;
      // other types ignored for grouping
    }
  }

  console.log(
    `${LOG_PREFIX} model_explicit=${modelExplicit.length}  model_implicit=${modelImplicit.length}  memo_prose=${memoProse.length}`,
  );

  // ── Fail closed: every expected origin_type must have rows ─────────
  const missingTypes: string[] = [];
  if (modelExplicit.length === 0) missingTypes.push("model_explicit");
  if (modelImplicit.length === 0) missingTypes.push("model_implicit");
  if (memoProse.length === 0) missingTypes.push("memo_prose");
  if (missingTypes.length > 0) {
    throw new Error(
      `${LOG_PREFIX} Fail-closed: origin_type(s) with zero rows: ${missingTypes.join(", ")}. ` +
        `Cannot assemble dedup groups without all three origin types.`,
    );
  }

  // ── Map: rowId → assigned groupId ──────────────────────────────────
  const groupAssignment = new Map<string, string>();

  // ── 4. Rule A — model_explicit clustering ──────────────────────────
  //   Key: sheet + "|" + value + "|" + period + "|" + label(proposition)
  //   Min cluster size: 3.  Canonical = lowest origin_locator.

  // Build cluster map
  const ruleAClusters = new Map<
    string,
    { rows: AssumptionRow[]; locators: string[] }
  >();

  for (const row of modelExplicit) {
    const parsed = parseLocator(row.origin_locator);
    if (!parsed) continue;
    // Stringify value for grouping (NULL → "null")
    const valStr = row.value != null ? String(row.value) : "null";
    const periodStr = row.period ?? "null";
    const propText = row.proposition.trim();
    if (propText.length === 0) continue; // non-empty label required
    const key = `${parsed.sheet}|${valStr}|${periodStr}|${propText}`;
    let cluster = ruleAClusters.get(key);
    if (!cluster) {
      cluster = { rows: [], locators: [] };
      ruleAClusters.set(key, cluster);
    }
    cluster.rows.push(row);
    cluster.locators.push(row.origin_locator!);
  }

  // Assign groups for clusters with >= 3 members
  let ruleAGroupCount = 0;
  // Track which rowIds belong to which Rule A group → for Rule B absorption
  const ruleAGroupForRow = new Map<string, string>(); // rowId → groupId
  const ruleAGroupMembers = new Map<string, string[]>(); // groupId → rowIds

  for (const [, cluster] of ruleAClusters) {
    if (cluster.rows.length < 3) continue;
    ruleAGroupCount++;
    // Canonical = lowest origin_locator
    cluster.locators.sort();
    const canonicalId = cluster.rows.find(
      (r) => r.origin_locator === cluster.locators[0],
    )!.id;

    const memberIds: string[] = [];
    for (const row of cluster.rows) {
      groupAssignment.set(row.id, canonicalId);
      ruleAGroupForRow.set(row.id, canonicalId);
      memberIds.push(row.id);
    }
    ruleAGroupMembers.set(canonicalId, memberIds);
  }

  console.log(
    `${LOG_PREFIX} Rule A: ${ruleAGroupCount} groups formed from model_explicit`,
  );

  // ── 5. Rule B — model_implicit + model_explicit by sheet+row ───────
  //   Key: sheet + "|" + row.  model_implicit is canonical.
  //   If a model_explicit row already belongs to a Rule A cluster,
  //   the entire Rule A cluster joins the Rule B group.

  const ruleBClusters = new Map<
    string,
    { implicitRows: AssumptionRow[]; explicitRows: AssumptionRow[] }
  >();

  // Index model_implicit by sheet+row
  for (const row of modelImplicit) {
    const parsed = parseLocator(row.origin_locator);
    if (!parsed) continue;
    const key = `${parsed.sheet}|${parsed.row}`;
    let cluster = ruleBClusters.get(key);
    if (!cluster) {
      cluster = { implicitRows: [], explicitRows: [] };
      ruleBClusters.set(key, cluster);
    }
    cluster.implicitRows.push(row);
  }

  // Index model_explicit by sheet+row
  for (const row of modelExplicit) {
    const parsed = parseLocator(row.origin_locator);
    if (!parsed) continue;
    const key = `${parsed.sheet}|${parsed.row}`;
    let cluster = ruleBClusters.get(key);
    if (!cluster) {
      cluster = { implicitRows: [], explicitRows: [] };
      ruleBClusters.set(key, cluster);
    }
    cluster.explicitRows.push(row);
  }

  let ruleBGroupCount = 0;

  for (const [, cluster] of ruleBClusters) {
    // Need at least one implicit row for canonical
    if (cluster.implicitRows.length === 0) continue;
    // Need at least 2 total rows to form a group
    const totalRows =
      cluster.implicitRows.length + cluster.explicitRows.length;
    if (totalRows < 2) continue;

    ruleBGroupCount++;

    // Canonical = model_implicit with lowest origin_locator
    const implicitLocators = cluster.implicitRows
      .map((r) => r.origin_locator ?? "")
      .sort();
    const canonicalId = cluster.implicitRows.find(
      (r) => (r.origin_locator ?? "") === implicitLocators[0],
    )!.id;

    // Assign implicit rows
    for (const row of cluster.implicitRows) {
      groupAssignment.set(row.id, canonicalId);
    }

    // Assign explicit rows + absorb their Rule A clusters
    for (const row of cluster.explicitRows) {
      groupAssignment.set(row.id, canonicalId);

      // Absorption: if this explicit row was in a Rule A cluster,
      // pull the entire cluster into this Rule B group
      const ruleAGroupId = ruleAGroupForRow.get(row.id);
      if (ruleAGroupId) {
        const clusterMembers = ruleAGroupMembers.get(ruleAGroupId);
        if (clusterMembers) {
          for (const memberId of clusterMembers) {
            groupAssignment.set(memberId, canonicalId);
          }
        }
      }
    }
  }

  console.log(
    `${LOG_PREFIX} Rule B: ${ruleBGroupCount} groups formed from model_implicit + model_explicit`,
  );

  // ── 6. Rule D — memo_prose clustering by normalized proposition ────
  const ruleDClusters = new Map<
    string,
    { rows: AssumptionRow[]; locators: string[] }
  >();

  for (const row of memoProse) {
    const key = normalize(row.proposition);
    if (key.length === 0) continue;
    let cluster = ruleDClusters.get(key);
    if (!cluster) {
      cluster = { rows: [], locators: [] };
      ruleDClusters.set(key, cluster);
    }
    cluster.rows.push(row);
    cluster.locators.push(row.origin_locator ?? "");
  }

  let ruleDGroupCount = 0;

  for (const [, cluster] of ruleDClusters) {
    if (cluster.rows.length < 2) {
      // Singletons still get a dedup_group_id pointing to themselves
      if (cluster.rows.length === 1) {
        groupAssignment.set(cluster.rows[0].id, cluster.rows[0].id);
      }
      continue;
    }
    ruleDGroupCount++;
    // Canonical = lowest origin_locator
    cluster.locators.sort();
    const canonicalId = cluster.rows.find(
      (r) => (r.origin_locator ?? "") === cluster.locators[0],
    )!.id;
    for (const row of cluster.rows) {
      groupAssignment.set(row.id, canonicalId);
    }
  }

  // Assign singletons that weren't grouped (self-reference)
  for (const row of allRows) {
    if (!groupAssignment.has(row.id)) {
      groupAssignment.set(row.id, row.id);
    }
  }

  console.log(
    `${LOG_PREFIX} Rule D: ${ruleDGroupCount} groups formed from memo_prose`,
  );

  // ── 7. Write back dedup_group_id in batches ───────────────────────
  const entries = Array.from(groupAssignment.entries());
  const WRITE_BATCH = 500;
  let writtenCount = 0;

  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    const batch = entries.slice(i, i + WRITE_BATCH);

    // Build a VALUES list for a bulk UPDATE
    const valuesClauses: string[] = [];
    const params: unknown[] = [];
    for (let j = 0; j < batch.length; j++) {
      const [rowId, groupId] = batch[j];
      const pIdx = j * 2;
      valuesClauses.push(`($${pIdx + 1}::uuid, $${pIdx + 2}::uuid)`);
      params.push(rowId, groupId);
    }

    await db.execute(
      `UPDATE mast_assumptions AS a
          SET dedup_group_id = v.group_id
         FROM (VALUES ${valuesClauses.join(", ")}) AS v(row_id, group_id)
        WHERE a.id = v.row_id`,
      params,
      {
        label: `${LOG_PREFIX} write dedup_group_id batch ${Math.floor(i / WRITE_BATCH) + 1}`,
      },
    );
    writtenCount += batch.length;
  }

  // ── 8. Summary logging ─────────────────────────────────────────────
  const canonicalCount = new Set(groupAssignment.values()).size;
  let largestGroupSize = 0;
  let largestGroupCanonical = "";
  const groupSizes = new Map<string, number>();
  for (const [, gid] of groupAssignment) {
    groupSizes.set(gid, (groupSizes.get(gid) ?? 0) + 1);
  }
  for (const [gid, size] of groupSizes) {
    if (size > largestGroupSize) {
      largestGroupSize = size;
      largestGroupCanonical = gid;
    }
  }

  // Look up the origin_locator for the largest group's canonical row
  let largestLocator = "unknown";
  if (largestGroupCanonical) {
    const found = allRows.find((r) => r.id === largestGroupCanonical);
    if (found) largestLocator = found.origin_locator ?? "null";
  }

  console.log(
    `${LOG_PREFIX} Summary: ${allRows.length} total rows, ` +
      `${canonicalCount} canonical groups, ` +
      `${writtenCount} dedup_group_ids written. ` +
      `Rule A=${ruleAGroupCount} Rule B=${ruleBGroupCount} Rule D=${ruleDGroupCount}. ` +
      `Largest group: ${largestGroupSize} rows (canonical: ${largestLocator}).`,
  );

  return {
    complete: true,
    itemsDone: allRows.length,
    itemsTotal: allRows.length,
    resumePosition: 0,
  };
};

export default registerAssemble;
