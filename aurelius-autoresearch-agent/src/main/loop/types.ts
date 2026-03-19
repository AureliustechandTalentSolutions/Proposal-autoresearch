/**
 * Loop engine types for the Aurelius Autoresearch Agent.
 *
 * Defines the configuration, result, and control-flow types used by
 * AutoresearchLoop and its supporting modules.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Top-level run configuration supplied by the orchestrator / CLI. */
export interface RunConfig {
  /** Filesystem path (or MinIO key) to the artifact under improvement. */
  artifact_path: string;

  /** Maximum loop iterations before forced halt. */
  max_iterations: number;

  /** Target OPA score (0-1).  Loop halts when reached. */
  target_threshold: number;

  /** Number of consecutive non-improving iterations before plateau halt. */
  plateau_window: number;

  /** Per-LLM-call timeout in milliseconds. */
  llm_timeout_ms: number;

  /** Maximum concurrent sandboxes (guards host resources). */
  max_concurrent_sandboxes: number;

  /** Model identifier passed to the privacy router for LLM selection. */
  model_id: string;

  /** Optional OPA policy bundle path override. */
  opa_policy_path?: string;

  /** MinIO bucket for audit trail storage. */
  minio_bucket: string;

  /** If true, buffer audit records locally when MinIO is unreachable. */
  minio_fallback_local: boolean;

  /** Additional constraints forwarded to the OPA evaluator. */
  constraints?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Outcome of a single keep/discard decision inside the loop. */
export type Decision = "KEEP" | "DISCARD";

/** Why the loop terminated. */
export type HaltReason =
  | "threshold_reached"
  | "max_iterations"
  | "plateau"
  | "constraint_violation"
  | "critical_error";

/** Detailed record for one iteration. */
export interface IterationResult {
  /** Zero-based iteration index. */
  iteration: number;

  /** Unix-ms timestamp when the iteration started. */
  started_at: number;

  /** Unix-ms timestamp when the iteration finished. */
  finished_at: number;

  /** Generated hypothesis text (summary). */
  hypothesis: string;

  /** OPA score *before* this iteration's modification. */
  score_before: number;

  /** OPA score *after* this iteration's modification. */
  score_after: number;

  /** Whether the modification was kept or discarded. */
  decision: Decision;

  /** Sandbox IDs used during this iteration. */
  sandbox_ids: string[];

  /** Privacy routing path chosen for the LLM call. */
  routing_path: string;

  /** If the iteration ended in an error, the message is captured here. */
  error?: string;
}

/** Aggregate result returned by `AutoresearchLoop.run()`. */
export interface RunResult {
  /** Unique run identifier. */
  run_id: string;

  /** Whether the run completed successfully (even if halted early). */
  success: boolean;

  /** Reason the loop stopped. */
  halt_reason: HaltReason;

  /** OPA score of the initial (unmodified) artifact. */
  baseline_score: number;

  /** OPA score of the final artifact. */
  final_score: number;

  /** Per-iteration details. */
  iterations: IterationResult[];

  /** Total wall-clock duration in milliseconds. */
  duration_ms: number;

  /** MinIO key where the full audit trail was persisted (if available). */
  audit_trail_key?: string;

  /** Number of audit records buffered locally due to MinIO failure. */
  buffered_audit_count: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Hypothesis produced by the hypothesis-generator sandbox. */
export interface Hypothesis {
  id: string;
  text: string;
  rationale: string;
  confidence: number;
}

/** Patch descriptor produced by the artifact-modifier sandbox. */
export interface ArtifactPatch {
  hypothesis_id: string;
  diff: string;
  modified_artifact: string;
}

/** A single entry in the audit trail stored in MinIO. */
export interface AuditEntry {
  run_id: string;
  iteration: number;
  timestamp: number;
  event: string;
  detail: Record<string, unknown>;
}

/** Persisted learning record for cross-run knowledge transfer. */
export interface LearningRecord {
  run_id: string;
  iteration: number;
  hypothesis: string;
  decision: Decision;
  score_delta: number;
  tags: string[];
  created_at: number;
}
