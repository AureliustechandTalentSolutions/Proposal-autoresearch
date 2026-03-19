/**
 * Autoresearch loop engine.
 *
 * Orchestrates the iterative hypothesis-generate -> modify -> score -> decide
 * loop.  Every LLM operation runs inside an OpenShell sandbox managed by
 * NemoClaw; OPA scoring runs locally (no sandbox overhead); audit records
 * stream to MinIO from the main process.
 */

import { SandboxManager } from "../nemoclaw/sandbox";
import { PrivacyRouter } from "../nemoclaw/privacy-router";
import { SecurityLogger } from "../nemoclaw/security-logger";
import { OPAEvaluator, scoreArtifact, isImprovement } from "./scorer";
import { AuditTrail, MinIOClient } from "./audit";
import { LearningsStore } from "./learnings";
import { generateHypotheses } from "./hypothesis";
import { modifyArtifact } from "./modifier";
import type {
  RunConfig,
  RunResult,
  IterationResult,
  HaltReason,
  AuditEntry,
} from "./types";

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class AutoresearchLoop {
  private readonly sandbox: SandboxManager;
  private readonly router: PrivacyRouter;
  private readonly security: SecurityLogger;
  private readonly opa: OPAEvaluator;
  private readonly minio: MinIOClient;
  private readonly learnings: LearningsStore;
  private readonly config: RunConfig;

  constructor(
    sandbox: SandboxManager,
    router: PrivacyRouter,
    security: SecurityLogger,
    opa: OPAEvaluator,
    minio: MinIOClient,
    learnings: LearningsStore,
    config: RunConfig,
  ) {
    this.sandbox = sandbox;
    this.router = router;
    this.security = security;
    this.opa = opa;
    this.minio = minio;
    this.learnings = learnings;
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async run(): Promise<RunResult> {
    const runId = generateRunId();
    const startMs = Date.now();
    const iterations: IterationResult[] = [];

    const audit = new AuditTrail(this.minio, this.security, {
      bucket: this.config.minio_bucket,
      keyPrefix: "audit/runs/",
      fallbackLocal: this.config.minio_fallback_local,
    });

    // 1. Read target artifact -----------------------------------------------
    let artifact: string;
    try {
      artifact = await this.readArtifact(this.config.artifact_path);
    } catch (err) {
      this.security.critical("Failed to read target artifact", {
        path: this.config.artifact_path,
        error: String(err),
      });
      return this.buildResult(runId, startMs, iterations, 0, 0, "critical_error", audit);
    }

    await this.auditEvent(audit, runId, -1, "run_started", {
      artifact_path: this.config.artifact_path,
      max_iterations: this.config.max_iterations,
      target_threshold: this.config.target_threshold,
    });

    // 2. Score baseline via OPA (local, instant) ----------------------------
    let baselineScore: number;
    try {
      const baseline = await scoreArtifact(
        { opa: this.opa, security: this.security, constraints: this.config.constraints },
        artifact,
      );
      baselineScore = baseline.score;

      if (baseline.hasCriticalViolation) {
        this.security.critical("Baseline artifact has critical violations", {
          violations: baseline.violations,
        });
        await this.auditEvent(audit, runId, -1, "baseline_critical_violation", {
          score: baseline.score,
          violations: baseline.violations,
        });
        return this.buildResult(runId, startMs, iterations, baselineScore, baselineScore, "constraint_violation", audit);
      }
    } catch (err) {
      this.security.critical("Baseline scoring failed", { error: String(err) });
      return this.buildResult(runId, startMs, iterations, 0, 0, "critical_error", audit);
    }

    await this.auditEvent(audit, runId, -1, "baseline_scored", {
      score: baselineScore,
    });

    this.security.info("Loop starting", {
      runId,
      baselineScore,
      maxIterations: this.config.max_iterations,
      targetThreshold: this.config.target_threshold,
    });

    // 3. Main loop ----------------------------------------------------------
    let currentArtifact = artifact;
    let currentScore = baselineScore;
    let consecutivePlateau = 0;
    let haltReason: HaltReason = "max_iterations";

    for (let i = 0; i < this.config.max_iterations; i++) {
      const iterStart = Date.now();
      const iterResult: Partial<IterationResult> = {
        iteration: i,
        started_at: iterStart,
        sandbox_ids: [],
      };

      try {
        // (a-d) Generate hypotheses in sandbox ------------------------------
        const { hypotheses, sandboxHandle: hGenHandle } =
          await generateHypotheses(
            {
              sandbox: this.sandbox,
              router: this.router,
              security: this.security,
              config: this.config,
            },
            currentArtifact,
            currentScore,
            this.learnings.getRecent(10),
          );

        iterResult.sandbox_ids!.push(hGenHandle.id);
        iterResult.routing_path = "sandbox:" + hGenHandle.id;

        // (d) Terminate hypothesis sandbox
        await this.safeTerminate(hGenHandle);

        if (hypotheses.length === 0) {
          this.security.warn("No hypotheses generated, DISCARDing iteration", {
            iteration: i,
          });
          iterResult.hypothesis = "(none)";
          iterResult.score_before = currentScore;
          iterResult.score_after = currentScore;
          iterResult.decision = "DISCARD";
          iterResult.finished_at = Date.now();
          iterations.push(iterResult as IterationResult);
          consecutivePlateau++;

          if (consecutivePlateau >= (this.config.plateau_window || 3)) {
            haltReason = "plateau";
            break;
          }
          continue;
        }

        const topHypothesis = hypotheses[0];
        iterResult.hypothesis = topHypothesis.text;
        iterResult.score_before = currentScore;

        // (e-g) Modify artifact in separate sandbox -------------------------
        const { patch, sandboxHandle: modHandle } = await modifyArtifact(
          {
            sandbox: this.sandbox,
            router: this.router,
            security: this.security,
            config: this.config,
          },
          currentArtifact,
          topHypothesis,
        );

        iterResult.sandbox_ids!.push(modHandle.id);

        // (g) Terminate modifier sandbox
        await this.safeTerminate(modHandle);

        if (!patch) {
          this.security.warn("Modifier returned no patch, DISCARDing", {
            iteration: i,
            hypothesisId: topHypothesis.id,
          });
          iterResult.score_after = currentScore;
          iterResult.decision = "DISCARD";
          iterResult.finished_at = Date.now();
          iterations.push(iterResult as IterationResult);
          consecutivePlateau++;

          if (consecutivePlateau >= (this.config.plateau_window || 3)) {
            haltReason = "plateau";
            break;
          }
          continue;
        }

        // (h) Score via OPA (local, no sandbox) -----------------------------
        const scoreResult = await scoreArtifact(
          { opa: this.opa, security: this.security, constraints: this.config.constraints },
          patch.modified_artifact,
          { iteration: i, hypothesis_id: topHypothesis.id },
        );

        iterResult.score_after = scoreResult.score;

        // Check for critical constraint violation
        if (scoreResult.hasCriticalViolation) {
          this.security.critical("Constraint violation at iteration", {
            iteration: i,
            violations: scoreResult.violations,
          });
          iterResult.decision = "DISCARD";
          iterResult.error = "critical constraint violation";
          iterResult.finished_at = Date.now();
          iterations.push(iterResult as IterationResult);

          await this.auditEvent(audit, runId, i, "constraint_violation", {
            score: scoreResult.score,
            violations: scoreResult.violations,
          });

          haltReason = "constraint_violation";
          break;
        }

        // (i) KEEP / DISCARD decision --------------------------------------
        if (isImprovement(currentScore, scoreResult.score)) {
          iterResult.decision = "KEEP";
          currentArtifact = patch.modified_artifact;
          currentScore = scoreResult.score;
          consecutivePlateau = 0;

          this.security.info("Iteration KEEP", {
            iteration: i,
            scoreDelta: scoreResult.score - iterResult.score_before!,
            newScore: currentScore,
          });
        } else {
          iterResult.decision = "DISCARD";
          consecutivePlateau++;

          this.security.info("Iteration DISCARD", {
            iteration: i,
            scoreDelta: scoreResult.score - iterResult.score_before!,
          });
        }

        iterResult.finished_at = Date.now();
        iterations.push(iterResult as IterationResult);

        // (j) Record to MinIO audit trail -----------------------------------
        await this.auditEvent(audit, runId, i, "iteration_complete", {
          hypothesis: topHypothesis.text,
          decision: iterResult.decision,
          score_before: iterResult.score_before,
          score_after: iterResult.score_after,
        });

        // (k) Update learnings ----------------------------------------------
        this.learnings.record({
          runId,
          iteration: i,
          hypothesis: topHypothesis.text,
          decision: iterResult.decision!,
          scoreDelta: scoreResult.score - iterResult.score_before!,
          tags: [topHypothesis.id],
        });

        // (l) Check halt conditions -----------------------------------------
        if (currentScore >= this.config.target_threshold) {
          haltReason = "threshold_reached";
          this.security.info("Target threshold reached", {
            score: currentScore,
            threshold: this.config.target_threshold,
          });
          break;
        }

        if (consecutivePlateau >= (this.config.plateau_window || 3)) {
          haltReason = "plateau";
          this.security.info("Plateau detected", {
            consecutiveNonImproving: consecutivePlateau,
          });
          break;
        }
      } catch (err) {
        // ---- Error handling ------------------------------------------------
        const errorMsg = String(err);

        if (isSecurityViolation(err)) {
          this.security.critical("Security violation during iteration", {
            iteration: i,
            error: errorMsg,
          });
          // Terminate all active sandboxes
          await this.terminateAllActive();
          iterResult.error = errorMsg;
          iterResult.score_after = currentScore;
          iterResult.decision = "DISCARD";
          iterResult.finished_at = Date.now();
          iterations.push(iterResult as IterationResult);

          await this.auditEvent(audit, runId, i, "security_violation", {
            error: errorMsg,
          });

          haltReason = "critical_error";
          break;
        }

        if (isLLMTimeout(err)) {
          this.security.error("LLM timeout, terminating sandboxes", {
            iteration: i,
            error: errorMsg,
          });
          // Terminate sandboxes spawned for this iteration
          for (const sid of iterResult.sandbox_ids ?? []) {
            await this.safeTerminate({ id: sid, role: "", spawnedAt: 0, status: "running" });
          }
          iterResult.error = errorMsg;
          iterResult.score_after = currentScore;
          iterResult.decision = "DISCARD";
          iterResult.finished_at = Date.now();
          iterations.push(iterResult as IterationResult);
          consecutivePlateau++;

          if (consecutivePlateau >= (this.config.plateau_window || 3)) {
            haltReason = "plateau";
            break;
          }
          continue;
        }

        // Generic error -- log and DISCARD
        this.security.error("Unhandled error in iteration", {
          iteration: i,
          error: errorMsg,
        });
        iterResult.error = errorMsg;
        iterResult.score_after = currentScore;
        iterResult.decision = "DISCARD";
        iterResult.finished_at = Date.now();
        iterations.push(iterResult as IterationResult);
        consecutivePlateau++;

        if (consecutivePlateau >= (this.config.plateau_window || 3)) {
          haltReason = "plateau";
          break;
        }
      }
    }

    // 4. Finalize -----------------------------------------------------------
    await this.learnings.flush();
    await this.auditEvent(audit, runId, iterations.length, "run_completed", {
      haltReason,
      finalScore: currentScore,
      iterations: iterations.length,
    });

    return this.buildResult(
      runId,
      startMs,
      iterations,
      baselineScore!,
      currentScore,
      haltReason,
      audit,
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async readArtifact(path: string): Promise<string> {
    if (typeof globalThis.Bun !== "undefined") {
      return globalThis.Bun.file(path).text();
    }
    const fs = await import("node:fs/promises");
    return fs.readFile(path, "utf-8");
  }

  private async safeTerminate(handle: { id: string; role: string; spawnedAt: number; status: string }): Promise<void> {
    try {
      await this.sandbox.terminate(handle as any);
    } catch (err) {
      this.security.warn("Sandbox termination failed (non-fatal)", {
        sandboxId: handle.id,
        error: String(err),
      });
    }
  }

  private async terminateAllActive(): Promise<void> {
    try {
      const active = await this.sandbox.listActive();
      for (const h of active) {
        await this.safeTerminate(h);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private async auditEvent(
    audit: AuditTrail,
    runId: string,
    iteration: number,
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const entry: AuditEntry = {
      run_id: runId,
      iteration,
      timestamp: Date.now(),
      event,
      detail,
    };

    try {
      await audit.record(entry);
    } catch (err) {
      // MinIO failure is non-fatal when fallback is enabled (handled by
      // AuditTrail internally).  If fallback is disabled and it threw,
      // we log but do not crash the loop.
      this.security.warn("Audit record write failed", {
        event,
        error: String(err),
      });
    }
  }

  private async buildResult(
    runId: string,
    startMs: number,
    iterations: IterationResult[],
    baselineScore: number,
    finalScore: number,
    haltReason: HaltReason,
    audit: AuditTrail,
  ): Promise<RunResult> {
    const auditTrailKey = await audit.finalize(runId);

    return {
      run_id: runId,
      success: haltReason !== "critical_error",
      halt_reason: haltReason,
      baseline_score: baselineScore,
      final_score: finalScore,
      iterations,
      duration_ms: Date.now() - startMs,
      audit_trail_key: auditTrailKey,
      buffered_audit_count: audit.bufferedCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `run_${ts}_${rand}`;
}

function isSecurityViolation(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === "SecurityViolation" ||
      err.message.includes("SECURITY_VIOLATION") ||
      err.message.includes("policy_denied")
    );
  }
  return false;
}

function isLLMTimeout(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === "TimeoutError" ||
      err.message.includes("TIMEOUT") ||
      err.message.includes("timed out")
    );
  }
  return false;
}
