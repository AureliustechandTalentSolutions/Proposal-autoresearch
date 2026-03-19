/**
 * Artifact modification module.
 *
 * Applies a chosen hypothesis to the current artifact inside an OpenShell
 * sandbox, producing a modified artifact and a diff for audit purposes.
 */

import type { SandboxManager, SandboxHandle } from "../nemoclaw/sandbox";
import type { PrivacyRouter } from "../nemoclaw/privacy-router";
import type { SecurityLogger } from "../nemoclaw/security-logger";
import type { Hypothesis, ArtifactPatch, RunConfig } from "./types";

export interface ArtifactModifierDeps {
  sandbox: SandboxManager;
  router: PrivacyRouter;
  security: SecurityLogger;
  config: RunConfig;
}

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
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    if (
      typeof parsed.modified_artifact !== "string" ||
      typeof parsed.diff !== "string"
    ) {
      return null;
    }

    return {
      hypothesis_id: hypothesisId,
      diff: parsed.diff as string,
      modified_artifact: parsed.modified_artifact as string,
    };
  } catch {
    return null;
  }
}
