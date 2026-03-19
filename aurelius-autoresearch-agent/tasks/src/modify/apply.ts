/**
 * Artifact Modification Task
 *
 * Applies a hypothesis-driven modification to a proposal artifact.
 * Fetches the original artifact, generates modified content via LLM,
 * validates the modification against constraints, and stores the result.
 */

import { task, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { client, TASK_DEFAULTS, MINIO_CONFIG, OPA_CONFIG } from "../client";
import { callLLM } from "../llm/provider";

const ModifyPayload = z.object({
  /** Source artifact key */
  artifactKey: z.string(),
  /** Bucket containing the artifact */
  bucket: z.string().default("proposals"),
  /** Hypothesis to apply */
  hypothesis: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    targetSection: z.string(),
    suggestedChanges: z.array(z.string()),
  }),
  /** Whether to create a new version or overwrite */
  createVersion: z.boolean().default(true),
  /** Maximum modification scope (characters changed) */
  maxDeltaChars: z.number().default(5000),
});

export type ModifyPayload = z.infer<typeof ModifyPayload>;

export interface ModificationResult {
  originalKey: string;
  modifiedKey: string;
  hypothesisId: string;
  sectionsModified: string[];
  deltaCharCount: number;
  constraintsPassed: boolean;
}

export const applyModification = task({
  id: "modify-apply",
  retry: {
    maxAttempts: TASK_DEFAULTS.maxRetries,
  },
  run: async (payload: unknown) => {
    const params = ModifyPayload.parse(payload);

    logger.info("Applying modification", {
      artifactKey: params.artifactKey,
      hypothesisId: params.hypothesis.id,
      targetSection: params.hypothesis.targetSection,
    });

    // Fetch original artifact
    const originalResponse = await fetch(
      `${MINIO_CONFIG.endpoint}/${params.bucket}/${params.artifactKey}`,
    );

    if (!originalResponse.ok) {
      throw new Error(`Failed to fetch artifact: ${originalResponse.statusText}`);
    }

    const originalContent = await originalResponse.text();

    // Generate modification via LLM
    const prompt = buildModificationPrompt(originalContent, params.hypothesis, params.maxDeltaChars);

    const response = await callLLM({
      messages: [
        {
          role: "system",
          content:
            "You are an expert federal proposal editor. Apply the requested modification to the proposal text. Preserve formatting, tone, and structure. Return only the modified text.",
        },
        { role: "user", content: prompt },
      ],
      maxTokens: 8192,
      temperature: 0.3,
    });

    const modifiedContent = response.content;

    // Validate against safety constraints
    const constraintCheck = await fetch(`${OPA_CONFIG.endpoint}/v1/data/constraints/safety`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          operation: "modify_artifact",
          source: "trigger-worker",
          target: params.artifactKey,
          parameters: {
            delta_chars: Math.abs(modifiedContent.length - originalContent.length),
          },
        },
      }),
    });

    const constraintResult = (await constraintCheck.json()) as { result: { allow: boolean } };
    const constraintsPassed = constraintResult.result?.allow ?? true;

    if (!constraintsPassed) {
      logger.warn("Modification failed constraint check", {
        artifactKey: params.artifactKey,
        hypothesisId: params.hypothesis.id,
      });
      return {
        success: false,
        output: { error: "Modification failed safety constraint check" },
        metrics: { tokensUsed: response.tokensUsed, latencyMs: response.latencyMs },
      };
    }

    // Store modified artifact
    const versionSuffix = params.createVersion
      ? `.v${Date.now()}`
      : "";
    const modifiedKey = `${params.artifactKey}${versionSuffix}`;

    await fetch(`${MINIO_CONFIG.endpoint}/${params.bucket}/${modifiedKey}`, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
        "x-amz-meta-hypothesis-id": params.hypothesis.id,
        "x-amz-meta-original-key": params.artifactKey,
      },
      body: modifiedContent,
    });

    const result: ModificationResult = {
      originalKey: params.artifactKey,
      modifiedKey,
      hypothesisId: params.hypothesis.id,
      sectionsModified: [params.hypothesis.targetSection],
      deltaCharCount: Math.abs(modifiedContent.length - originalContent.length),
      constraintsPassed,
    };

    logger.info("Modification applied", result);

    return {
      success: true,
      output: result,
      metrics: {
        deltaChars: result.deltaCharCount,
        tokensUsed: response.tokensUsed,
        latencyMs: response.latencyMs,
      },
      artifacts: [`${params.bucket}/${modifiedKey}`],
    };
  },
});

function buildModificationPrompt(
  originalContent: string,
  hypothesis: ModifyPayload["hypothesis"],
  maxDelta: number,
): string {
  return [
    `Apply the following improvement hypothesis to the proposal artifact.`,
    ``,
    `Hypothesis: ${hypothesis.title}`,
    `Description: ${hypothesis.description}`,
    `Target Section: ${hypothesis.targetSection}`,
    `Suggested Changes:`,
    ...hypothesis.suggestedChanges.map((c, i) => `  ${i + 1}. ${c}`),
    ``,
    `Constraints:`,
    `- Maximum ${maxDelta} characters of change`,
    `- Preserve all section headers and numbering`,
    `- Maintain professional federal proposal tone`,
    `- Do not remove existing compliant content`,
    ``,
    `--- ORIGINAL ARTIFACT ---`,
    originalContent.slice(0, 12_000),
    `--- END ---`,
    ``,
    `Return the complete modified text.`,
  ].join("\n");
}
