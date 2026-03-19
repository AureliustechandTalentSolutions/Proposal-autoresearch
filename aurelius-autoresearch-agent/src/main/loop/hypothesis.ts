/**
 * Hypothesis generation module.
 *
 * Runs the hypothesis-generator agent inside an OpenShell sandbox,
 * routes the LLM call through the privacy router, and returns a ranked
 * list of hypotheses for the current artifact state.
 *
 * Supports two modes:
 * 1. Sandboxed: Full privacy-routed execution via OpenShell containers
 * 2. Direct: LLM API call without sandboxing (for local/dev mode)
 */

import type { Hypothesis, LearningRecord, RunConfig } from "./types";

// ---------------------------------------------------------------------------
// Sandbox-based interfaces (production mode)
// ---------------------------------------------------------------------------

export interface SandboxManager {
  spawn(role: string, opts: { timeoutMs: number; maxMemoryMb: number }): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, cmd: { command: string; payload: unknown; timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  terminate(handle: SandboxHandle): Promise<void>;
}

export interface SandboxHandle {
  id: string;
  role: string;
  status: "running" | "terminated" | "error";
}

export interface PrivacyRouter {
  route(req: { model: string; prompt: string; sandboxId: string }): Promise<{
    path: "local" | "federated" | "cloud_sanitized" | "blocked";
    endpoint: string;
    sanitizedPrompt: string;
  }>;
}

export interface SecurityLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  critical(msg: string, ctx?: Record<string, unknown>): void;
}

export interface HypothesisGeneratorDeps {
  sandbox: SandboxManager;
  router: PrivacyRouter;
  security: SecurityLogger;
  config: RunConfig;
}

// ---------------------------------------------------------------------------
// Sandboxed generation (production)
// ---------------------------------------------------------------------------

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
// Direct LLM generation (dev/local mode)
// ---------------------------------------------------------------------------

export interface DirectLLMConfig {
  provider: "anthropic" | "ollama";
  apiKey?: string;
  endpoint: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

/**
 * Generate hypotheses via direct LLM API call (no sandbox).
 * Uses Bun's native fetch for HTTP requests.
 *
 * Supports:
 * - Anthropic Claude API
 * - Ollama local API
 */
export async function generateHypothesesDirect(
  llmConfig: DirectLLMConfig,
  artifact: string,
  currentScore: number,
  priorLearnings: LearningRecord[],
): Promise<Hypothesis[]> {
  const prompt = buildPrompt(artifact, currentScore, priorLearnings);
  const startMs = Date.now();

  let responseText: string;

  if (llmConfig.provider === "anthropic") {
    responseText = await callAnthropic(llmConfig, prompt);
  } else if (llmConfig.provider === "ollama") {
    responseText = await callOllama(llmConfig, prompt);
  } else {
    throw new Error(`Unsupported LLM provider: ${llmConfig.provider}`);
  }

  const hypotheses = parseHypotheses(responseText);
  const durationMs = Date.now() - startMs;

  console.log(
    `[Hypothesis] Generated ${hypotheses.length} hypotheses via ${llmConfig.provider} in ${durationMs}ms`,
  );

  return hypotheses;
}

async function callAnthropic(config: DirectLLMConfig, prompt: string): Promise<string> {
  if (!config.apiKey) throw new Error("Anthropic API key required");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  return json.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

async function callOllama(config: DirectLLMConfig, prompt: string): Promise<string> {
  const endpoint = config.endpoint || "http://localhost:11434";

  const response = await fetch(`${endpoint}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      prompt,
      stream: false,
      options: {
        temperature: config.temperature,
        num_predict: config.maxTokens,
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { response: string };
  return json.response;
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

    // Try to find JSON array in the response
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed: unknown = JSON.parse(jsonMatch[0]);
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
        confidence: Math.max(0, Math.min(1, h.confidence as number)),
      }))
      .sort((a, b) => b.confidence - a.confidence);
  } catch {
    return [];
  }
}
