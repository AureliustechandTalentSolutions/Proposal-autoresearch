/**
 * External Scoring Task
 *
 * Evaluates an artifact against multiple scoring dimensions using
 * OPA policy checks and LLM-based qualitative assessment. Produces
 * a composite score with per-dimension breakdowns.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import * as Minio from "minio";
import { TASK_DEFAULTS, MINIO_CONFIG, OPA_CONFIG } from "../client";
import { callLLM } from "../llm/provider";

const ScorePayload = z.object({
  /** Artifact key to evaluate */
  artifactKey: z.string(),
  /** Bucket containing the artifact */
  bucket: z.string().default("proposals"),
  /** Scoring dimensions to evaluate */
  dimensions: z.array(
    z.enum([
      "compliance",
      "readability",
      "technical_depth",
      "cost_realism",
      "past_performance",
      "page_limits",
      "compliance_matrix",
    ]),
  ).default(["compliance", "readability", "technical_depth"]),
  /** Previous score for delta calculation */
  previousScore: z.record(z.number()).optional(),
});

export type ScorePayload = z.infer<typeof ScorePayload>;

export interface DimensionScore {
  dimension: string;
  score: number;
  maxScore: number;
  weight: number;
  findings: string[];
  delta?: number;
}

export interface CompositeScore {
  overall: number;
  dimensions: DimensionScore[];
  evaluatedAt: string;
  artifactKey: string;
}

const DIMENSION_WEIGHTS: Record<string, number> = {
  compliance: 30,
  readability: 15,
  technical_depth: 25,
  cost_realism: 15,
  past_performance: 10,
  page_limits: 5,
  compliance_matrix: 10,
};

const minioClient = new Minio.Client(MINIO_CONFIG);

export const evaluateScore = task({
  id: "score-evaluate",
  retry: {
    maxAttempts: TASK_DEFAULTS.maxRetries,
    factor: TASK_DEFAULTS.retryBackoffFactor,
    minTimeoutInMs: TASK_DEFAULTS.retryMinDelaySeconds * 1000,
    maxTimeoutInMs: TASK_DEFAULTS.retryMaxDelaySeconds * 1000,
  },
  run: async (payload: unknown) => {
    const params = ScorePayload.parse(payload);

    logger.info("Evaluating artifact score", {
      artifactKey: params.artifactKey,
      dimensions: params.dimensions,
    });

    // Fetch artifact from MinIO
    const artifactStream = await minioClient.getObject(params.bucket, params.artifactKey);
    const chunks: Buffer[] = [];
    for await (const chunk of artifactStream) {
      chunks.push(Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks).toString("utf-8");

    // Evaluate each dimension
    const dimensionScores: DimensionScore[] = [];

    for (const dimension of params.dimensions) {
      const score = await evaluateDimension(dimension, content, params);
      dimensionScores.push(score);
    }

    // Calculate weighted composite score
    const totalWeight = dimensionScores.reduce((sum, d) => sum + d.weight, 0);
    const weightedSum = dimensionScores.reduce(
      (sum, d) => sum + (d.score / d.maxScore) * d.weight,
      0,
    );
    const overall = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0;

    const composite: CompositeScore = {
      overall,
      dimensions: dimensionScores,
      evaluatedAt: new Date().toISOString(),
      artifactKey: params.artifactKey,
    };

    // Store score result in MinIO
    const scoreJson = JSON.stringify(composite);
    const scoreBuffer = Buffer.from(scoreJson, "utf-8");

    const bucketExists = await minioClient.bucketExists("scores");
    if (!bucketExists) {
      await minioClient.makeBucket("scores");
    }

    await minioClient.putObject(
      "scores",
      `${params.artifactKey}.score.json`,
      scoreBuffer,
      scoreBuffer.length,
      { "Content-Type": "application/json" },
    );

    logger.info("Score evaluation complete", {
      overall,
      dimensions: dimensionScores.map((d) => `${d.dimension}:${d.score}`),
    });

    return {
      success: true,
      output: composite,
      metrics: { overallScore: overall },
      artifacts: [`scores/${params.artifactKey}.score.json`],
    };
  },
});

async function evaluateDimension(
  dimension: string,
  content: string,
  params: ScorePayload,
): Promise<DimensionScore> {
  const weight = DIMENSION_WEIGHTS[dimension] ?? 10;

  // For policy-based dimensions, query OPA
  const policyDimensions = ["compliance", "readability", "page_limits", "compliance_matrix"];

  if (policyDimensions.includes(dimension)) {
    return evaluateViaPolicies(dimension, content, weight, params);
  }

  // For qualitative dimensions, use LLM evaluation
  return evaluateViaLLM(dimension, content, weight, params);
}

async function evaluateViaPolicies(
  dimension: string,
  content: string,
  weight: number,
  params: ScorePayload,
): Promise<DimensionScore> {
  const policyMap: Record<string, string> = {
    compliance: "proposal/eval_rubric",
    readability: "proposal/readability",
    page_limits: "proposal/page_limits",
    compliance_matrix: "proposal/compliance_matrix",
  };

  const policyPath = policyMap[dimension];
  if (!policyPath) {
    return { dimension, score: 0, maxScore: 100, weight, findings: ["No policy found"] };
  }

  try {
    const response = await fetch(`${OPA_CONFIG.endpoint}/v1/data/${policyPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { content: content.slice(0, 10_000), artifact_key: params.artifactKey },
      }),
    });

    const result = (await response.json()) as {
      result: { score?: number; findings?: Record<string, unknown> };
    };

    const score = result.result?.score ?? 0;
    const previousScore = params.previousScore?.[dimension];

    return {
      dimension,
      score,
      maxScore: 100,
      weight,
      findings: [],
      delta: previousScore !== undefined ? score - previousScore : undefined,
    };
  } catch (error) {
    logger.warn(`Policy evaluation failed for ${dimension}`, { error });
    return { dimension, score: 0, maxScore: 100, weight, findings: ["Policy evaluation failed"] };
  }
}

async function evaluateViaLLM(
  dimension: string,
  content: string,
  weight: number,
  params: ScorePayload,
): Promise<DimensionScore> {
  try {
    const response = await callLLM({
      messages: [
        {
          role: "system",
          content: `You are a federal proposal evaluator. Score the following proposal on the "${dimension}" dimension on a scale of 0-100. Return JSON: {"score": number, "findings": ["string"]}`,
        },
        {
          role: "user",
          content: content.slice(0, 8_000),
        },
      ],
      maxTokens: 1024,
      temperature: 0.2,
    });

    const parsed = JSON.parse(
      response.content.match(/\{[\s\S]*\}/)?.[0] ?? '{"score": 0, "findings": []}',
    );

    const previousScore = params.previousScore?.[dimension];

    return {
      dimension,
      score: Math.min(100, Math.max(0, parsed.score)),
      maxScore: 100,
      weight,
      findings: parsed.findings ?? [],
      delta: previousScore !== undefined ? parsed.score - previousScore : undefined,
    };
  } catch (error) {
    logger.warn(`LLM evaluation failed for ${dimension}`, { error });
    return { dimension, score: 0, maxScore: 100, weight, findings: ["LLM evaluation failed"] };
  }
}
