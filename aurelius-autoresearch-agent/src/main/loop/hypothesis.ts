/**
 * Hypothesis generation module.
 *
 * Runs the hypothesis-generator agent inside an OpenShell sandbox,
 * routes the LLM call through the privacy router, and returns a ranked
 * list of hypotheses for the current artifact state.
 */

import type { SandboxManager, SandboxHandle } from "../nemoclaw/sandbox";
import type { PrivacyRouter } from "../nemoclaw/privacy-router";
import type { SecurityLogger } from "../nemoclaw/security-logger";
import type { Hypothesis, LearningRecord, RunConfig } from "./types";

export interface HypothesisGeneratorDeps {
  sandbox: SandboxManager;
  router: PrivacyRouter;
  security: SecurityLogger;
  config: RunConfig;
}

/**
 * Spawn a sandboxed hypothesis-generator, execute LLM inference through the
 * privacy router, parse the response, and return ranked hypotheses.
 *
 * The caller is responsible for terminating the returned sandbox handle
 * (even on error) to avoid resource leaks.
 */
export async function generateHypotheses(
  deps: HypothesisGeneratorDeps,
  artifact: string,
  currentScore: number,
  priorLearnings: LearningRecord[],
): Promise<{ hypotheses: Hypothesis[]; sandboxHandle: SandboxHandle }> {
  const { sandbox, router, security, config } = deps;

  // 1. Spawn sandbox --------------------------------------------------------
  let handle: SandboxHandle;
  try {
    handle = await sandbox.spawn("hypothesis-generator", {
      timeoutMs: config.llm_timeout_ms,
      maxMemoryMb: 512,
    });
  } catch (err) {
    // Retry once on sandbox spawn failure
    security.warn("hypothesis-generator sandbox spawn failed, retrying", {
      error: String(err),
    });
    handle = await sandbox.spawn("hypothesis-generator", {
      timeoutMs: config.llm_timeout_ms,
      maxMemoryMb: 512,
    });
  }

  try {
    // 2. Build prompt -------------------------------------------------------
    const prompt = buildPrompt(artifact, currentScore, priorLearnings);

    // 3. Route LLM call through privacy router ------------------------------
    const route = await router.route({
      model: config.model_id,
      prompt,
      sandboxId: handle.id,
    });

    security.info("hypothesis LLM routed", {
      sandboxId: handle.id,
      route: route.path,
    });

    // 4. Execute inside sandbox ---------------------------------------------
    const raw = await sandbox.exec(handle, {
      command: "llm-inference",
      payload: {
        prompt: route.sanitizedPrompt,
        endpoint: route.endpoint,
        model: config.model_id,
      },
      timeoutMs: config.llm_timeout_ms,
    });

    // 5. Parse response -----------------------------------------------------
    const hypotheses = parseHypotheses(raw.stdout);

    security.info("hypotheses generated", {
      sandboxId: handle.id,
      count: hypotheses.length,
    });

    return { hypotheses, sandboxHandle: handle };
  } catch (err) {
    // On any error we still return the handle so the caller can terminate it
    security.error("hypothesis generation failed", {
      sandboxId: handle.id,
      error: String(err),
    });
    return { hypotheses: [], sandboxHandle: handle };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPrompt(
  artifact: string,
  currentScore: number,
  learnings: LearningRecord[],
): string {
  const learningsBlock =
    learnings.length > 0
      ? learnings
          .slice(-10) // last 10 learnings for context window efficiency
          .map(
            (l) =>
              `- [${l.decision}] score_delta=${l.score_delta.toFixed(3)}: ${l.hypothesis}`,
          )
          .join("\n")
      : "(no prior learnings)";

  return [
    "You are a research hypothesis generator.",
    "Given the current artifact and its evaluation score, propose 3-5 specific,",
    "actionable hypotheses to improve the artifact. Rank by expected impact.",
    "",
    "## Current score",
    currentScore.toFixed(4),
    "",
    "## Prior learnings",
    learningsBlock,
    "",
    "## Artifact",
    artifact,
    "",
    "## Response format",
    "Return a JSON array of objects with fields: id, text, rationale, confidence (0-1).",
    "Order by descending confidence.",
  ].join("\n");
}

function parseHypotheses(raw: string): Hypothesis[] {
  try {
    // Strip markdown fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (h: Record<string, unknown>) =>
          typeof h.id === "string" &&
          typeof h.text === "string" &&
          typeof h.rationale === "string" &&
          typeof h.confidence === "number",
      )
      .map((h: Record<string, unknown>) => ({
        id: h.id as string,
        text: h.text as string,
        rationale: h.rationale as string,
        confidence: h.confidence as number,
      }))
      .sort((a, b) => b.confidence - a.confidence);
  } catch {
    return [];
  }
}
