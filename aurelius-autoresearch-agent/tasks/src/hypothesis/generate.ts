/**
 * Hypothesis Generation Task
 *
 * Generates improvement hypotheses for proposal artifacts using LLM analysis.
 * Examines current artifact state, compliance gaps, and evaluation rubric
 * results to propose targeted modifications.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import * as Minio from "minio";
import { TASK_DEFAULTS, MINIO_CONFIG } from "../client";
import { callLLM } from "../llm/provider";

const HypothesisPayload = z.object({
  /** Artifact key in MinIO to analyze */
  artifactKey: z.string(),
  /** Bucket containing the artifact */
  bucket: z.string().default("proposals"),
  /** Compliance findings to address */
  complianceFindings: z.record(z.unknown()).optional(),
  /** Evaluation rubric scores to improve */
  rubricScores: z.record(z.number()).optional(),
  /** Maximum number of hypotheses to generate */
  maxHypotheses: z.number().min(1).max(20).default(5),
  /** Focus area for hypothesis generation */
  focusArea: z.enum([
    "compliance",
    "readability",
    "technical_depth",
    "cost_realism",
    "past_performance",
    "general",
  ]).default("general"),
});

export type HypothesisPayload = z.infer<typeof HypothesisPayload>;

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  targetSection: string;
  expectedImpact: "low" | "medium" | "high";
  category: string;
  suggestedChanges: string[];
  confidence: number;
}

const minioClient = new Minio.Client(MINIO_CONFIG);

export const generateHypotheses = task({
  id: "hypothesis-generate",
  retry: {
    maxAttempts: TASK_DEFAULTS.maxRetries,
    factor: TASK_DEFAULTS.retryBackoffFactor,
    minTimeoutInMs: TASK_DEFAULTS.retryMinDelaySeconds * 1000,
    maxTimeoutInMs: TASK_DEFAULTS.retryMaxDelaySeconds * 1000,
  },
  run: async (payload: unknown) => {
    const params = HypothesisPayload.parse(payload);

    logger.info("Generating hypotheses", {
      artifactKey: params.artifactKey,
      focusArea: params.focusArea,
      maxHypotheses: params.maxHypotheses,
    });

    // Fetch the artifact content from MinIO using the official client
    const artifactStream = await minioClient.getObject(params.bucket, params.artifactKey);
    const chunks: Buffer[] = [];
    for await (const chunk of artifactStream) {
      chunks.push(Buffer.from(chunk));
    }
    const artifactContent = Buffer.concat(chunks).toString("utf-8");

    // Build the analysis prompt
    const prompt = buildHypothesisPrompt({
      content: artifactContent,
      focusArea: params.focusArea,
      complianceFindings: params.complianceFindings,
      rubricScores: params.rubricScores,
      maxHypotheses: params.maxHypotheses,
    });

    // Generate hypotheses via LLM
    const response = await callLLM({
      messages: [
        {
          role: "system",
          content:
            "You are an expert federal proposal analyst. Generate specific, actionable improvement hypotheses for the given proposal artifact. Return valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      maxTokens: 4096,
      temperature: 0.7,
    });

    // Parse the LLM response into structured hypotheses
    const hypotheses = parseHypotheses(response.content, params.maxHypotheses);

    logger.info("Hypotheses generated", { count: hypotheses.length });

    // Store hypotheses as an artifact using MinIO client
    const hypothesesJson = JSON.stringify({
      sourceArtifact: params.artifactKey,
      generatedAt: new Date().toISOString(),
      focusArea: params.focusArea,
      hypotheses,
    });
    const hypothesesBuffer = Buffer.from(hypothesesJson, "utf-8");

    // Ensure the hypotheses bucket exists
    const bucketExists = await minioClient.bucketExists("hypotheses");
    if (!bucketExists) {
      await minioClient.makeBucket("hypotheses");
    }

    await minioClient.putObject(
      "hypotheses",
      `${params.artifactKey}.hypotheses.json`,
      hypothesesBuffer,
      hypothesesBuffer.length,
      { "Content-Type": "application/json" },
    );

    return {
      success: true,
      output: { hypotheses },
      metrics: {
        hypothesesGenerated: hypotheses.length,
        tokensUsed: response.tokensUsed,
        latencyMs: response.latencyMs,
      },
      artifacts: [`hypotheses/${params.artifactKey}.hypotheses.json`],
    };
  },
});

function buildHypothesisPrompt(params: {
  content: string;
  focusArea: string;
  complianceFindings?: Record<string, unknown>;
  rubricScores?: Record<string, number>;
  maxHypotheses: number;
}): string {
  let prompt = `Analyze the following proposal artifact and generate up to ${params.maxHypotheses} improvement hypotheses.\n\n`;
  prompt += `Focus area: ${params.focusArea}\n\n`;
  prompt += `--- ARTIFACT CONTENT (truncated) ---\n${params.content.slice(0, 8000)}\n---\n\n`;

  if (params.complianceFindings) {
    prompt += `Compliance findings:\n${JSON.stringify(params.complianceFindings, null, 2)}\n\n`;
  }

  if (params.rubricScores) {
    prompt += `Current rubric scores:\n${JSON.stringify(params.rubricScores, null, 2)}\n\n`;
  }

  prompt += `Return a JSON array of hypothesis objects with fields: id, title, description, targetSection, expectedImpact (low/medium/high), category, suggestedChanges (array), confidence (0-1).`;

  return prompt;
}

function parseHypotheses(content: string, max: number): Hypothesis[] {
  try {
    // Extract JSON array from LLM response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn("No JSON array found in LLM response");
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as Hypothesis[];
    return parsed.slice(0, max);
  } catch (error) {
    logger.error("Failed to parse hypotheses from LLM response", { error });
    return [];
  }
}
