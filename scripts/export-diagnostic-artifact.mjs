#!/usr/bin/env node
/**
 * export-diagnostic-artifact.mjs
 *
 * Deterministic exporter that calls StreamExportArtifact in a loop and writes
 * the returned bytes directly to disk. Each chunk is base64-decoded and verified
 * against its per-chunk SHA-256 before appending.
 *
 * Environment:
 *   SUPERBLOCKS_API_URL    — Base URL for Superblocks API execution
 *                            (e.g. https://app.superblocks.com/api/v1/apis/execute)
 *   SUPERBLOCKS_API_TOKEN  — Bearer token for authentication
 *   SUPERBLOCKS_APP_ID     — Application ID containing the APIs
 *
 * Usage:
 *   node scripts/export-diagnostic-artifact.mjs \
 *     --run-id "33a88bb1-d2b6-4ee8-81f7-335573c28c73" \
 *     --artifact-type json \
 *     --output "docs/diagnostic-reports/saint-l3-raw-findings-2026-07-31.json" \
 *     --expected-count 273
 *
 *   node scripts/export-diagnostic-artifact.mjs \
 *     --run-id "33a88bb1-d2b6-4ee8-81f7-335573c28c73" \
 *     --artifact-type mapping \
 *     --output "docs/diagnostic-reports/saint-l3-to-diagnostic-final-mapping-2026-07-31.json" \
 *     --expected-count 273
 */

import { createHash } from "node:crypto";
import { writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

// ─── CLI argument parsing ─────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    "run-id":         { type: "string" },
    "artifact-type":  { type: "string" },
    "output":         { type: "string" },
    "expected-count": { type: "string" },
    "chunk-size":     { type: "string", default: "18000" },
  },
});

const runId         = args["run-id"];
const artifactType  = args["artifact-type"];
const outputPath    = args["output"];
const expectedCount = parseInt(args["expected-count"] ?? "273", 10);
const chunkSize     = parseInt(args["chunk-size"] ?? "18000", 10);

if (!runId || !artifactType || !outputPath) {
  console.error("Usage: node scripts/export-diagnostic-artifact.mjs --run-id <id> --artifact-type <json|mapping> --output <path> [--expected-count <n>]");
  process.exit(1);
}

if (!["json", "mapping"].includes(artifactType)) {
  console.error(`Invalid artifact-type: ${artifactType}. Must be "json" or "mapping".`);
  process.exit(1);
}

// ─── Environment ──────────────────────────────────────────────────────────────

const API_URL   = process.env.SUPERBLOCKS_API_URL;
const API_TOKEN = process.env.SUPERBLOCKS_API_TOKEN;
const APP_ID    = process.env.SUPERBLOCKS_APP_ID;

if (!API_URL || !API_TOKEN || !APP_ID) {
  console.error("Missing environment variables: SUPERBLOCKS_API_URL, SUPERBLOCKS_API_TOKEN, SUPERBLOCKS_APP_ID");
  process.exit(1);
}

// ─── API caller ───────────────────────────────────────────────────────────────

async function callApi(apiName, inputs) {
  const response = await fetch(`${API_URL}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({
      applicationId: APP_ID,
      apiName,
      inputs,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${apiName} failed (${response.status}): ${text}`);
  }

  const result = await response.json();
  if (result.error) {
    throw new Error(`API ${apiName} returned error: ${JSON.stringify(result.error)}`);
  }
  return result.output ?? result.outputs ?? result;
}

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ─── Step 1: Validate via AssembleExportArtifact ──────────────────────────────

console.log(`\n═══ Export Diagnostic Artifact ═══`);
console.log(`  Run ID:         ${runId}`);
console.log(`  Artifact Type:  ${artifactType}`);
console.log(`  Output:         ${outputPath}`);
console.log(`  Expected Count: ${expectedCount}`);
console.log(`  Chunk Size:     ${chunkSize} bytes\n`);

console.log("Step 1: Running AssembleExportArtifact for validation...");
const assembleResult = await callApi("AssembleExportArtifact", {
  runId,
  artifact_type: artifactType,
});

console.log(`  Status:       ${assembleResult.status}`);
console.log(`  Total Bytes:  ${assembleResult.total_bytes}`);
console.log(`  SHA-256:      ${assembleResult.sha256}`);
console.log(`  Findings:     ${assembleResult.finding_count}`);
console.log(`  Unique IDs:   ${assembleResult.unique_ids}`);
console.log(`  Duplicates:   ${assembleResult.duplicate_ids}`);

if (assembleResult.validation_errors?.length > 0) {
  console.error("\n  ❌ Validation errors:");
  for (const err of assembleResult.validation_errors) {
    console.error(`     - ${err}`);
  }
  process.exit(2);
}

if (assembleResult.finding_count !== expectedCount) {
  console.error(`\n  ❌ Expected ${expectedCount} findings, got ${assembleResult.finding_count}`);
  process.exit(2);
}

console.log("  ✓ Validation passed\n");

// ─── Step 2: Stream chunks ────────────────────────────────────────────────────

const totalBytes   = assembleResult.total_bytes;
const expectedSha  = assembleResult.sha256;
const totalChunks  = Math.ceil(totalBytes / chunkSize);
const tempPath     = resolve(outputPath + ".tmp");
const finalPath    = resolve(outputPath);

console.log(`Step 2: Streaming ${totalChunks} chunks (${totalBytes} bytes)...`);

const chunks = [];
let receivedBytes = 0;
let lastFullSha = null;

for (let i = 0; i < totalChunks; i++) {
  process.stdout.write(`  Chunk ${i + 1}/${totalChunks}...`);

  const result = await callApi("StreamExportArtifact", {
    runId,
    artifact_type: artifactType,
    chunk_index: i,
    chunk_size: chunkSize,
  });

  // Verify chunk metadata
  if (result.chunk_index !== i) {
    console.error(`\n  ❌ Out-of-order chunk: expected ${i}, got ${result.chunk_index}`);
    process.exit(3);
  }

  if (result.total_bytes !== totalBytes) {
    console.error(`\n  ❌ Total bytes mismatch: expected ${totalBytes}, got ${result.total_bytes}`);
    process.exit(3);
  }

  // Decode base64 and verify chunk SHA-256
  const chunkBuffer = Buffer.from(result.chunk_base64, "base64");

  if (chunkBuffer.length !== result.chunk_byte_length) {
    console.error(`\n  ❌ Chunk byte length mismatch: decoded ${chunkBuffer.length}, expected ${result.chunk_byte_length}`);
    process.exit(3);
  }

  const chunkSha = sha256(chunkBuffer);
  if (chunkSha !== result.chunk_sha256) {
    console.error(`\n  ❌ Chunk SHA-256 mismatch at chunk ${i}:`);
    console.error(`     Expected: ${result.chunk_sha256}`);
    console.error(`     Got:      ${chunkSha}`);
    process.exit(3);
  }

  // Verify no overlap/gap
  if (receivedBytes !== i * chunkSize) {
    console.error(`\n  ❌ Offset mismatch: expected start at ${i * chunkSize}, accumulated ${receivedBytes}`);
    process.exit(3);
  }

  chunks.push(chunkBuffer);
  receivedBytes += chunkBuffer.length;
  lastFullSha = result.full_sha256;

  const hasMoreExpected = i + 1 < totalChunks;
  if (result.has_more !== hasMoreExpected) {
    console.error(`\n  ❌ has_more mismatch at chunk ${i}: expected ${hasMoreExpected}, got ${result.has_more}`);
    process.exit(3);
  }

  process.stdout.write(` ✓ (${chunkBuffer.length} bytes, sha=${chunkSha.slice(0, 8)})\n`);
}

// ─── Step 3: Assemble and validate ───────────────────────────────────────────

console.log(`\nStep 3: Assembling final file...`);

const fullBuffer = Buffer.concat(chunks);
console.log(`  Assembled bytes: ${fullBuffer.length}`);

if (fullBuffer.length !== totalBytes) {
  console.error(`  ❌ Total byte mismatch: assembled ${fullBuffer.length}, expected ${totalBytes}`);
  process.exit(4);
}

// Verify full-file SHA-256
const fullSha = sha256(fullBuffer);
console.log(`  Full SHA-256:    ${fullSha}`);

if (fullSha !== expectedSha) {
  console.error(`  ❌ Full-file SHA-256 mismatch:`);
  console.error(`     Expected (from AssembleExportArtifact): ${expectedSha}`);
  console.error(`     Got (from assembled chunks):            ${fullSha}`);
  process.exit(4);
}

if (lastFullSha && lastFullSha !== expectedSha) {
  console.error(`  ❌ Stream SHA-256 inconsistency:`);
  console.error(`     AssembleExportArtifact: ${expectedSha}`);
  console.error(`     StreamExportArtifact:   ${lastFullSha}`);
  process.exit(4);
}

console.log(`  ✓ SHA-256 verified\n`);

// ─── Step 4: Validate JSON content ───────────────────────────────────────────

console.log(`Step 4: Validating JSON content...`);

const content = fullBuffer.toString("utf8");
let parsed;
try {
  parsed = JSON.parse(content);
  console.log("  ✓ Valid JSON");
} catch (e) {
  console.error(`  ❌ Invalid JSON: ${e.message}`);
  process.exit(5);
}

// Validate record count
if (artifactType === "json") {
  const findings = parsed.findings ?? [];
  const ids = findings.map(f => f.finding_id).filter(Boolean);
  const uniqueIds = new Set(ids);
  console.log(`  Findings:     ${findings.length}`);
  console.log(`  Unique IDs:   ${uniqueIds.size}`);
  console.log(`  Duplicates:   ${ids.length - uniqueIds.size}`);

  if (findings.length !== expectedCount) {
    console.error(`  ❌ Expected ${expectedCount} findings, got ${findings.length}`);
    process.exit(5);
  }

  // Verify no fabricated content
  for (const f of findings) {
    if (f.finding_id?.includes("dup-guard") || f.finding_id?.includes("placeholder")) {
      console.error(`  ❌ Fabricated record detected: ${f.finding_id}`);
      process.exit(5);
    }
    if (f.title === "placeholder" || f.detail === "placeholder") {
      console.error(`  ❌ Placeholder content in: ${f.finding_id}`);
      process.exit(5);
    }
  }

  // Node reconciliation
  const nodeMap = {};
  for (const f of findings) {
    const key = `L3:N${f._l3_node_index}`;
    nodeMap[key] = (nodeMap[key] ?? 0) + 1;
  }
  const nodeSum = Object.values(nodeMap).reduce((a, b) => a + b, 0);
  console.log(`  Node recon:   ${JSON.stringify(nodeMap)} (sum=${nodeSum})`);

  if (nodeSum !== expectedCount) {
    console.error(`  ❌ Node sum ${nodeSum} ≠ expected ${expectedCount}`);
    process.exit(5);
  }

  console.log("  ✓ Content validation passed");

} else {
  // mapping
  const mappings = parsed.mappings ?? [];
  const ids = mappings.map(m => m.raw_finding_id).filter(Boolean);
  const uniqueIds = new Set(ids);
  console.log(`  Mappings:     ${mappings.length}`);
  console.log(`  Unique IDs:   ${uniqueIds.size}`);
  console.log(`  Duplicates:   ${ids.length - uniqueIds.size}`);

  if (mappings.length !== expectedCount) {
    console.error(`  ❌ Expected ${expectedCount} mapping records, got ${mappings.length}`);
    process.exit(5);
  }

  // Verify all have a disposition field (even if null — not absent)
  const missingDisposition = mappings.filter(m => !("disposition" in m));
  if (missingDisposition.length > 0) {
    console.error(`  ❌ ${missingDisposition.length} mappings missing disposition field`);
    process.exit(5);
  }

  console.log("  ✓ Content validation passed");
}

// ─── Step 5: Write to disk (atomic) ──────────────────────────────────────────

console.log(`\nStep 5: Writing to disk...`);

// Write to temp file first
writeFileSync(tempPath, fullBuffer);
console.log(`  Wrote temp: ${tempPath} (${fullBuffer.length} bytes)`);

// Atomic rename
renameSync(tempPath, finalPath);
console.log(`  Renamed to: ${finalPath}`);
console.log(`  ✓ File written successfully\n`);

// ─── Step 6: Output manifest ─────────────────────────────────────────────────

const manifest = {
  artifact_type: artifactType,
  run_id: runId,
  output_path: outputPath,
  total_bytes: fullBuffer.length,
  sha256: fullSha,
  record_count: artifactType === "json" ? parsed.findings?.length : parsed.mappings?.length,
  unique_ids: artifactType === "json"
    ? new Set(parsed.findings?.map(f => f.finding_id).filter(Boolean)).size
    : new Set(parsed.mappings?.map(m => m.raw_finding_id).filter(Boolean)).size,
  chunks_transferred: totalChunks,
  chunk_size: chunkSize,
  export_timestamp: new Date().toISOString(),
  generated_at: assembleResult.generated_at,
};

console.log("═══ Export Complete ═══");
console.log(JSON.stringify(manifest, null, 2));

// Output as JSON for programmatic consumption
process.stdout.write(`\n__MANIFEST_JSON__${JSON.stringify(manifest)}__END_MANIFEST__\n`);
