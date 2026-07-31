/**
 * Checkpoint State Machine
 * 
 * Defines explicit states for pipeline checkpoints and validation rules
 * for determining when a checkpoint is safe to reuse.
 * 
 * States:
 *   pending         → work has been queued but not started
 *   in_progress     → work is actively being processed in this invocation
 *   partial         → work completed but response was truncated (max_tokens) or incomplete
 *   complete        → work completed successfully with all expected outputs
 *   failed_retryable → work failed with a transient error (timeout, rate-limit, network)
 *   failed_terminal  → work failed with a non-retryable error (invalid input, auth failure)
 *   manifest        → meta-checkpoint recording round-level completion state
 * 
 * A checkpoint is reusable ONLY when:
 *   1. status === 'complete'
 *   2. All expected work is accounted for (no missing children/outputs)
 *   3. Source content hash matches (content hasn't changed)
 *   4. Schema/prompt version matches (or is forward-compatible)
 *   5. Output is not truncated
 */

export type CheckpointStatus =
  | "pending"
  | "in_progress"
  | "partial"
  | "complete"
  | "failed_retryable"
  | "failed_terminal"
  | "manifest";

/**
 * Determines if a checkpoint status represents a terminal failure
 * (should not be retried without user intervention or config change).
 */
export function isTerminalFailure(status: CheckpointStatus): boolean {
  return status === "failed_terminal";
}

/**
 * Determines if a checkpoint status represents a retryable state.
 * Both partial and failed_retryable are eligible for retry.
 */
export function isRetryable(status: CheckpointStatus): boolean {
  return status === "partial" || status === "failed_retryable" || status === "pending";
}

/**
 * Determines if a checkpoint is safe to reuse as authoritative data.
 */
export function isReusable(status: CheckpointStatus): boolean {
  return status === "complete";
}

/**
 * Validation context for determining checkpoint reusability.
 */
export interface CheckpointValidationContext {
  /** The status field from the checkpoint row */
  status: CheckpointStatus | string;
  /** Source content hash at write time (if available) */
  sourceHash?: string | null;
  /** Current source content hash for comparison */
  currentSourceHash?: string | null;
  /** Pipeline/prompt version at write time */
  promptVersion?: string | null;
  /** Current pipeline/prompt version */
  currentPromptVersion?: string | null;
  /** Whether the checkpoint output was truncated */
  truncated?: boolean;
  /** Expected child count (for manifest validation) */
  expectedChildren?: number;
  /** Actual completed children found */
  completedChildren?: number;
}

export interface CheckpointValidationResult {
  reusable: boolean;
  reason: string;
  suggestedAction: "reuse" | "retry" | "skip" | "fail";
}

/**
 * Validates whether a checkpoint can be safely reused.
 * This is the SINGLE source of truth for "is this checkpoint good enough to skip?"
 */
export function validateCheckpoint(ctx: CheckpointValidationContext): CheckpointValidationResult {
  const status = ctx.status as CheckpointStatus;

  // Rule 1: Only 'complete' status is reusable
  if (status !== "complete") {
    if (isRetryable(status)) {
      return { reusable: false, reason: `Status is '${status}' (retryable)`, suggestedAction: "retry" };
    }
    if (isTerminalFailure(status)) {
      return { reusable: false, reason: `Status is '${status}' (terminal)`, suggestedAction: "fail" };
    }
    return { reusable: false, reason: `Status is '${status}' (not complete)`, suggestedAction: "skip" };
  }

  // Rule 2: Source content must not have changed
  if (ctx.sourceHash && ctx.currentSourceHash && ctx.sourceHash !== ctx.currentSourceHash) {
    return {
      reusable: false,
      reason: `Source content changed (was ${ctx.sourceHash.slice(0, 8)}, now ${ctx.currentSourceHash.slice(0, 8)})`,
      suggestedAction: "retry",
    };
  }

  // Rule 3: Output must not be truncated
  if (ctx.truncated) {
    return { reusable: false, reason: "Output was truncated (max_tokens)", suggestedAction: "retry" };
  }

  // Rule 4: Schema/prompt version compatibility
  // For now, warn on mismatch but allow reuse (forward-compatible)
  // Future: strict mode where version mismatch invalidates
  if (ctx.promptVersion && ctx.currentPromptVersion && ctx.promptVersion !== ctx.currentPromptVersion) {
    // Log warning but allow reuse — the checkpoint data itself is valid
    console.warn(
      `[checkpoint-validation] Version mismatch: checkpoint written by ${ctx.promptVersion}, ` +
      `current is ${ctx.currentPromptVersion}. Allowing reuse (data valid, but results may differ).`
    );
  }

  // Rule 5: Manifest completeness check
  if (ctx.expectedChildren !== undefined && ctx.completedChildren !== undefined) {
    if (ctx.completedChildren < ctx.expectedChildren) {
      return {
        reusable: false,
        reason: `Incomplete: ${ctx.completedChildren}/${ctx.expectedChildren} children completed`,
        suggestedAction: "retry",
      };
    }
  }

  return { reusable: true, reason: "All validation checks passed", suggestedAction: "reuse" };
}

/**
 * Maps a raw status string from the database to a typed CheckpointStatus.
 * Handles null/undefined (legacy rows) by defaulting to 'complete' for
 * backward compatibility with pre-state-machine checkpoints.
 */
export function parseCheckpointStatus(raw: string | null | undefined): CheckpointStatus {
  if (!raw) return "complete"; // Legacy rows without status column
  const normalized = raw.toLowerCase().trim();
  const VALID_STATUSES: Set<string> = new Set([
    "pending", "in_progress", "partial", "complete",
    "failed_retryable", "failed_terminal", "manifest", "error",
  ]);
  if (VALID_STATUSES.has(normalized)) {
    // Map legacy 'error' to 'failed_retryable' for backward compat
    if (normalized === "error") return "failed_retryable";
    return normalized as CheckpointStatus;
  }
  console.warn(`[checkpoint-state-machine] Unknown status '${raw}' — treating as 'pending'`);
  return "pending";
}

/**
 * Determines whether a checkpoint write failure should stop the current invocation.
 * Critical checkpoints (merge results, extraction results) must halt on write failure.
 * Non-critical checkpoints (progress updates, heartbeats) can be logged and skipped.
 */
export function isCheckpointWriteCritical(checkpointType: "extraction" | "analysis" | "merge" | "manifest" | "progress"): boolean {
  return checkpointType === "extraction" || checkpointType === "analysis" || checkpointType === "merge";
}
