/**
 * OPA scoring wrapper.
 *
 * Evaluates artifacts against Open Policy Agent policies *locally* (no
 * sandbox required). Provides both raw numeric scores and constraint
 * violation detection used by the loop engine's halt logic.
 *
 * Supports two modes:
 * 1. OPA evaluator dependency injection (for sandboxed/production use)
 * 2. Direct HTTP OPA evaluation (for local/dev mode using OPA REST API)
 */

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

export interface SecurityLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  critical(msg: string, ctx?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Scorer wrapper (dependency-injected OPA)
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

// ---------------------------------------------------------------------------
// Direct OPA HTTP evaluation (dev/local mode)
// ---------------------------------------------------------------------------

export interface DirectOPAConfig {
  /** OPA REST API endpoint (default: http://localhost:8181) */
  endpoint: string;
  /** Policy path for evaluation (e.g., "v1/data/proposal/eval_rubric") */
  policyPath: string;
  /** Request timeout in ms */
  timeoutMs?: number;
}

/**
 * Score an artifact by calling OPA's REST API directly via HTTP.
 * Uses Bun's native fetch for zero-dependency HTTP calls.
 */
export async function scoreArtifactDirect(
  config: DirectOPAConfig,
  artifact: string,
  metadata?: Record<string, unknown>,
  constraints?: Record<string, unknown>,
): Promise<ScoreResult> {
  const start = Date.now();
  const endpoint = config.endpoint.replace(/\/$/, "");
  const url = `${endpoint}/${config.policyPath}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          artifact,
          metadata: metadata ?? {},
          constraints: constraints ?? {},
        },
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });

    if (!response.ok) {
      throw new Error(`OPA HTTP error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as {
      result?: {
        score?: number;
        dimensions?: Record<string, number>;
        violations?: Array<{ rule: string; message: string; severity: string }>;
      };
    };

    const result = json.result ?? {};
    const score = Math.max(0, Math.min(1, result.score ?? 0));
    const dimensions = result.dimensions ?? {};
    const violations: ConstraintViolation[] = (result.violations ?? []).map((v) => ({
      rule: v.rule ?? "unknown",
      message: v.message ?? "",
      severity: (v.severity ?? "warn") as "warn" | "error" | "critical",
    }));

    const hasCriticalViolation = violations.some((v) => v.severity === "critical");
    const durationMs = Date.now() - start;

    return { score, dimensions, violations, hasCriticalViolation, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;

    // If OPA is unreachable, return a default score with warning
    if (err instanceof TypeError && String(err).includes("fetch")) {
      console.warn(`[Scorer] OPA unreachable at ${url}, returning default score`);
      return {
        score: 0,
        dimensions: {},
        violations: [{
          rule: "system.opa_unreachable",
          message: `OPA server unreachable at ${endpoint}`,
          severity: "error",
        }],
        hasCriticalViolation: false,
        durationMs,
      };
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Multi-policy batch scoring
// ---------------------------------------------------------------------------

/**
 * Score an artifact against multiple OPA policies and aggregate results.
 */
export async function scoreArtifactBatch(
  config: { endpoint: string; timeoutMs?: number },
  policyPaths: string[],
  artifact: string,
  metadata?: Record<string, unknown>,
): Promise<{
  overallScore: number;
  results: Map<string, ScoreResult>;
  aggregateViolations: ConstraintViolation[];
}> {
  const results = new Map<string, ScoreResult>();
  const allViolations: ConstraintViolation[] = [];

  const promises = policyPaths.map(async (policyPath) => {
    try {
      const result = await scoreArtifactDirect(
        { endpoint: config.endpoint, policyPath, timeoutMs: config.timeoutMs },
        artifact,
        metadata,
      );
      results.set(policyPath, result);
      allViolations.push(...result.violations);
    } catch (err) {
      results.set(policyPath, {
        score: 0,
        dimensions: {},
        violations: [{
          rule: `system.eval_error.${policyPath}`,
          message: String(err),
          severity: "error",
        }],
        hasCriticalViolation: false,
        durationMs: 0,
      });
    }
  });

  await Promise.allSettled(promises);

  // Compute overall score as weighted average
  const scores = Array.from(results.values()).map((r) => r.score);
  const overallScore = scores.length > 0
    ? scores.reduce((sum, s) => sum + s, 0) / scores.length
    : 0;

  return { overallScore, results, aggregateViolations: allViolations };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

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

/**
 * Detect score plateau: returns true if the last N scores show no
 * meaningful improvement.
 */
export function isPlateaued(
  scores: number[],
  windowSize: number,
  epsilon = 1e-4,
): boolean {
  if (scores.length < windowSize) return false;

  const window = scores.slice(-windowSize);
  const min = Math.min(...window);
  const max = Math.max(...window);

  return (max - min) < epsilon;
}
