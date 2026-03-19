/**
 * OPA scoring wrapper.
 *
 * Evaluates artifacts against Open Policy Agent policies *locally* (no
 * sandbox required). Provides both raw numeric scores and constraint
 * violation detection used by the loop engine's halt logic.
 */

import type { SecurityLogger } from "../nemoclaw/security-logger";

// ---------------------------------------------------------------------------
// External dependency interfaces
// ---------------------------------------------------------------------------

/** Minimal interface for the OPA evaluator dependency. */
export interface OPAEvaluator {
  /**
   * Evaluate an artifact against loaded policies and return a numeric
   * score in [0, 1] plus any constraint violations.
   */
  evaluate(input: OPAInput): Promise<OPAOutput>;

  /** Reload policy bundle from disk (hot-reload after policy edits). */
  reloadPolicies(bundlePath?: string): Promise<void>;
}

export interface OPAInput {
  artifact: string;
  metadata?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
}

export interface OPAOutput {
  /** Aggregate score in [0, 1]. */
  score: number;

  /** Per-dimension sub-scores (e.g. coherence, accuracy, style). */
  dimensions: Record<string, number>;

  /** Constraint violations detected during evaluation. */
  violations: ConstraintViolation[];
}

export interface ConstraintViolation {
  rule: string;
  message: string;
  severity: "warn" | "error" | "critical";
}

// ---------------------------------------------------------------------------
// Scorer wrapper
// ---------------------------------------------------------------------------

export interface ScorerDeps {
  opa: OPAEvaluator;
  security: SecurityLogger;
  constraints?: Record<string, unknown>;
}

export interface ScoreResult {
  score: number;
  dimensions: Record<string, number>;
  violations: ConstraintViolation[];
  hasCriticalViolation: boolean;
  durationMs: number;
}

/**
 * Score an artifact locally via OPA.
 *
 * This deliberately runs in the main process -- OPA evaluation is
 * deterministic and fast, so sandboxing adds overhead with no security
 * benefit.
 */
export async function scoreArtifact(
  deps: ScorerDeps,
  artifact: string,
  metadata?: Record<string, unknown>,
): Promise<ScoreResult> {
  const { opa, security, constraints } = deps;
  const start = Date.now();

  try {
    const output = await opa.evaluate({
      artifact,
      metadata,
      constraints,
    });

    const hasCriticalViolation = output.violations.some(
      (v) => v.severity === "critical",
    );

    if (hasCriticalViolation) {
      security.critical("OPA critical constraint violation", {
        violations: output.violations.filter((v) => v.severity === "critical"),
      });
    } else if (output.violations.length > 0) {
      security.warn("OPA constraint violations detected", {
        count: output.violations.length,
        violations: output.violations,
      });
    }

    const durationMs = Date.now() - start;

    security.info("OPA scoring complete", {
      score: output.score,
      dimensions: output.dimensions,
      violationCount: output.violations.length,
      durationMs,
    });

    return {
      score: output.score,
      dimensions: output.dimensions,
      violations: output.violations,
      hasCriticalViolation,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    security.error("OPA scoring failed", { error: String(err), durationMs });
    throw err;
  }
}

/**
 * Determine whether a score delta constitutes "improvement" given a
 * small epsilon tolerance to avoid floating-point noise.
 */
export function isImprovement(
  scoreBefore: number,
  scoreAfter: number,
  epsilon = 1e-6,
): boolean {
  return scoreAfter - scoreBefore > epsilon;
}
