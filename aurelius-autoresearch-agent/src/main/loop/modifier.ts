/**
 * Artifact modification module.
 *
 * Applies a chosen hypothesis to the current artifact inside an OpenShell
 * sandbox, producing a modified artifact and a diff for audit purposes.
 *
 * Supports two modes:
 * 1. Sandboxed: Full privacy-routed execution via OpenShell containers
 * 2. Direct: LLM API call without sandboxing (for local/dev mode)
 */

import type { Hypothesis, ArtifactPatch, RunConfig } from "./types";
import type {
  SandboxManager,
  SandboxHandle,
  PrivacyRouter,
  SecurityLogger,
  DirectLLMConfig,
} from "./hypothesis";

export interface ArtifactModifierDeps {
  sandbox: SandboxManager;
  router: PrivacyRouter;
  security: SecurityLogger;
  config: RunConfig;
}

// ---------------------------------------------------------------------------
// Sandboxed modification (production)
// ---------------------------------------------------------------------------

/**
 * Spawn a sandboxed artifact-modifier agent, apply the top hypothesis,
 * and return the resulting patch.
 *
 * The caller is responsible for terminating the returned sandbox handle.
 */
export async function modifyArtifact(
  deps: ArtifactModifierDeps,
  artifact: string,
  hypothesis: Hypothesis,
): Promise<{ patch: ArtifactPatch | null; sandboxHandle: SandboxHandle }> {
  const { sandbox, router, security, config } = deps;

  // 1. Spawn sandbox --------------------------------------------------------
  let handle: SandboxHandle;
  try {
    handle = await sandbox.spawn("artifact-modifier", {
      timeoutMs: config.llm_timeout_ms,
      maxMemoryMb: 1024,
    });
  } catch (err) {
    security.warn("artifact-modifier sandbox spawn failed, retrying", {
      error: String(err),
    });
    handle = await sandbox.spawn("artifact-modifier", {
      timeoutMs: config.llm_timeout_ms,
      maxMemoryMb: 1024,
    });
  }

  try {
    // 2. Build prompt -------------------------------------------------------
    const prompt = buildModificationPrompt(artifact, hypothesis);

    // 3. Route through privacy router ---------------------------------------
    const route = await router.route({
      model: config.model_id,
      prompt,
      sandboxId: handle.id,
    });

    security.info("modifier LLM routed", {
      sandboxId: handle.id,
      route: route.path,
      hypothesisId: hypothesis.id,
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
    const patch = parsePatch(raw.stdout, hypothesis.id);

    if (patch) {
      security.info("artifact modified", {
        sandboxId: handle.id,
        hypothesisId: hypothesis.id,
        diffLength: patch.diff.length,
      });
    } else {
      security.warn("modifier returned unparseable output", {
        sandboxId: handle.id,
        hypothesisId: hypothesis.id,
      });
    }

    return { patch, sandboxHandle: handle };
  } catch (err) {
    security.error("artifact modification failed", {
      sandboxId: handle.id,
      error: String(err),
    });
    return { patch: null, sandboxHandle: handle };
  }
}

// ---------------------------------------------------------------------------
// Direct LLM modification (dev/local mode)
// ---------------------------------------------------------------------------

/**
 * Modify an artifact via direct LLM API call (no sandbox).
 * Uses Bun's native fetch for HTTP requests.
 */
export async function modifyArtifactDirect(
  llmConfig: DirectLLMConfig,
  artifact: string,
  hypothesis: Hypothesis,
): Promise<ArtifactPatch | null> {
  const prompt = buildModificationPrompt(artifact, hypothesis);
  const startMs = Date.now();

  let responseText: string;

  if (llmConfig.provider === "anthropic") {
    responseText = await callAnthropic(llmConfig, prompt);
  } else if (llmConfig.provider === "ollama") {
    responseText = await callOllama(llmConfig, prompt);
  } else {
    throw new Error(`Unsupported LLM provider: ${llmConfig.provider}`);
  }

  const patch = parsePatch(responseText, hypothesis.id);
  const durationMs = Date.now() - startMs;

  if (patch) {
    console.log(
      `[Modifier] Applied hypothesis ${hypothesis.id} via ${llmConfig.provider} in ${durationMs}ms (diff: ${patch.diff.length} chars)`,
    );
  } else {
    console.warn(`[Modifier] Failed to parse patch from ${llmConfig.provider} response`);
  }

  return patch;
}

/**
 * Compute a simple unified diff between two text strings.
 * Used when the LLM returns modified_artifact without a diff.
 */
export function computeSimpleDiff(original: string, modified: string): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const diffLines: string[] = [];

  diffLines.push("--- original");
  diffLines.push("+++ modified");

  const maxLen = Math.max(origLines.length, modLines.length);
  let chunkStart = -1;
  let chunkOrig: string[] = [];
  let chunkMod: string[] = [];

  for (let i = 0; i <= maxLen; i++) {
    const origLine = i < origLines.length ? origLines[i] : undefined;
    const modLine = i < modLines.length ? modLines[i] : undefined;

    if (origLine !== modLine) {
      if (chunkStart === -1) chunkStart = i;
      if (origLine !== undefined) chunkOrig.push(`-${origLine}`);
      if (modLine !== undefined) chunkMod.push(`+${modLine}`);
    } else {
      if (chunkStart !== -1) {
        diffLines.push(`@@ -${chunkStart + 1},${chunkOrig.length} +${chunkStart + 1},${chunkMod.length} @@`);
        diffLines.push(...chunkOrig, ...chunkMod);
        chunkStart = -1;
        chunkOrig = [];
        chunkMod = [];
      }
      if (origLine !== undefined) {
        diffLines.push(` ${origLine}`);
      }
    }
  }

  // Flush final chunk
  if (chunkStart !== -1) {
    diffLines.push(`@@ -${chunkStart + 1},${chunkOrig.length} +${chunkStart + 1},${chunkMod.length} @@`);
    diffLines.push(...chunkOrig, ...chunkMod);
  }

  return diffLines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM API calls
// ---------------------------------------------------------------------------

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

function buildModificationPrompt(
  artifact: string,
  hypothesis: Hypothesis,
): string {
  return [
    "You are an artifact modifier. Apply the given hypothesis to improve the artifact.",
    "",
    "## Hypothesis",
    `ID: ${hypothesis.id}`,
    `Text: ${hypothesis.text}`,
    `Rationale: ${hypothesis.rationale}`,
    "",
    "## Current artifact",
    artifact,
    "",
    "## Instructions",
    "1. Apply the hypothesis to the artifact.",
    "2. Return your response as a JSON object with fields:",
    '   - "modified_artifact": the full updated artifact text',
    '   - "diff": a unified diff showing what changed',
    "3. Preserve all content not addressed by the hypothesis.",
    "4. Do NOT wrap the JSON in markdown fences.",
  ].join("\n");
}

function parsePatch(
  raw: string,
  hypothesisId: string,
): ArtifactPatch | null {
  try {
    // Strip markdown fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    // Try to find JSON object in the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    if (typeof parsed.modified_artifact !== "string") {
      return null;
    }

    // Generate diff if not provided
    const diff = typeof parsed.diff === "string" ? parsed.diff : "[diff not provided by LLM]";

    return {
      hypothesis_id: hypothesisId,
      diff,
      modified_artifact: parsed.modified_artifact as string,
    };
  } catch {
    return null;
  }
}
