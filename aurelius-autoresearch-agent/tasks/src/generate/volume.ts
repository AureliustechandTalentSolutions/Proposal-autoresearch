/**
 * Volume Generation Task
 *
 * Generates proposal volume drafts from templates, outlines, and
 * compliance requirements. Produces structured documents ready for
 * human review and refinement.
 */

import { task, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { TASK_DEFAULTS, MINIO_CONFIG } from "../client";
import { callLLM } from "../llm/provider";

const VolumePayload = z.object({
  /** Volume type */
  volumeType: z.enum([
    "technical",
    "management",
    "past_performance",
    "cost",
    "staffing",
    "transition",
  ]),
  /** Solicitation number for reference */
  solicitationNumber: z.string(),
  /** Outline or template key in MinIO */
  outlineKey: z.string().optional(),
  /** Requirements extracted from RFP */
  requirements: z.array(z.string()).default([]),
  /** Page limit for the volume */
  pageLimit: z.number().min(1).default(50),
  /** Company-specific context for generation */
  companyContext: z.record(z.unknown()).optional(),
  /** Whether this is a draft or final generation */
  isDraft: z.boolean().default(true),
});

export type VolumePayload = z.infer<typeof VolumePayload>;

export interface GeneratedVolume {
  volumeType: string;
  solicitationNumber: string;
  sections: VolumeSection[];
  estimatedPages: number;
  generatedAt: string;
  isDraft: boolean;
}

export interface VolumeSection {
  number: string;
  title: string;
  content: string;
  estimatedPages: number;
  requirementsCovered: string[];
}

export const generateVolume = task({
  id: "generate-volume",
  retry: {
    maxAttempts: TASK_DEFAULTS.maxRetries,
  },
  run: async (payload: unknown) => {
    const params = VolumePayload.parse(payload);

    logger.info("Generating volume", {
      volumeType: params.volumeType,
      solicitationNumber: params.solicitationNumber,
      pageLimit: params.pageLimit,
    });

    // Fetch outline if provided
    let outline = "";
    if (params.outlineKey) {
      const outlineResponse = await fetch(
        `${MINIO_CONFIG.endpoint}/templates/${params.outlineKey}`,
      );
      if (outlineResponse.ok) {
        outline = await outlineResponse.text();
      }
    }

    // Generate volume structure
    const structurePrompt = buildStructurePrompt(params, outline);
    const structureResponse = await callLLM({
      messages: [
        {
          role: "system",
          content:
            "You are an expert federal proposal writer. Generate a detailed volume structure. Return JSON.",
        },
        { role: "user", content: structurePrompt },
      ],
      maxTokens: 2048,
      temperature: 0.5,
    });

    const structure = parseSectionStructure(structureResponse.content);

    // Generate content for each section
    const sections: VolumeSection[] = [];
    let totalTokens = structureResponse.tokensUsed;

    for (const section of structure) {
      logger.info(`Generating section: ${section.number} ${section.title}`);

      const sectionPrompt = buildSectionPrompt(params, section, outline);
      const sectionResponse = await callLLM({
        messages: [
          {
            role: "system",
            content:
              "You are an expert federal proposal writer. Generate professional proposal content for the given section. Use formal tone appropriate for government evaluation.",
          },
          { role: "user", content: sectionPrompt },
        ],
        maxTokens: 4096,
        temperature: 0.6,
      });

      totalTokens += sectionResponse.tokensUsed;

      sections.push({
        number: section.number,
        title: section.title,
        content: sectionResponse.content,
        estimatedPages: Math.ceil(sectionResponse.content.length / 3000), // ~3000 chars/page
        requirementsCovered: section.requirements,
      });
    }

    const totalPages = sections.reduce((sum, s) => sum + s.estimatedPages, 0);

    const volume: GeneratedVolume = {
      volumeType: params.volumeType,
      solicitationNumber: params.solicitationNumber,
      sections,
      estimatedPages: totalPages,
      generatedAt: new Date().toISOString(),
      isDraft: params.isDraft,
    };

    // Store the generated volume
    const volumeKey = `${params.solicitationNumber}/${params.volumeType}_volume.json`;
    await fetch(`${MINIO_CONFIG.endpoint}/volumes/${volumeKey}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(volume),
    });

    // Also store as plain text for readability
    const textContent = sections
      .map((s) => `\n${"#".repeat(2)} ${s.number} ${s.title}\n\n${s.content}`)
      .join("\n\n");
    const textKey = `${params.solicitationNumber}/${params.volumeType}_volume.md`;
    await fetch(`${MINIO_CONFIG.endpoint}/volumes/${textKey}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: `# ${params.volumeType.charAt(0).toUpperCase() + params.volumeType.slice(1)} Volume\n\nSolicitation: ${params.solicitationNumber}\nGenerated: ${volume.generatedAt}\nStatus: ${params.isDraft ? "DRAFT" : "FINAL"}\n\n${textContent}`,
    });

    logger.info("Volume generated", {
      sections: sections.length,
      estimatedPages: totalPages,
      pageLimit: params.pageLimit,
    });

    return {
      success: true,
      output: {
        volumeType: params.volumeType,
        sectionCount: sections.length,
        estimatedPages: totalPages,
        withinPageLimit: totalPages <= params.pageLimit,
      },
      metrics: {
        sections: sections.length,
        estimatedPages: totalPages,
        tokensUsed: totalTokens,
      },
      artifacts: [`volumes/${volumeKey}`, `volumes/${textKey}`],
    };
  },
});

function buildStructurePrompt(params: VolumePayload, outline: string): string {
  let prompt = `Generate a section structure for a ${params.volumeType} volume.\n`;
  prompt += `Solicitation: ${params.solicitationNumber}\n`;
  prompt += `Page limit: ${params.pageLimit} pages\n`;
  prompt += `Requirements to address:\n`;
  for (const req of params.requirements) {
    prompt += `  - ${req}\n`;
  }
  if (outline) {
    prompt += `\nTemplate/Outline:\n${outline.slice(0, 4000)}\n`;
  }
  prompt += `\nReturn a JSON array of sections: [{number, title, requirements: []}]`;
  return prompt;
}

function buildSectionPrompt(
  params: VolumePayload,
  section: { number: string; title: string; requirements: string[] },
  outline: string,
): string {
  return [
    `Write section ${section.number}: "${section.title}" for a ${params.volumeType} proposal volume.`,
    ``,
    `Requirements this section must address:`,
    ...section.requirements.map((r) => `  - ${r}`),
    ``,
    params.companyContext
      ? `Company context:\n${JSON.stringify(params.companyContext, null, 2)}`
      : "",
    ``,
    `Write ${params.isDraft ? "a draft" : "final"} version. Use professional federal proposal language.`,
    `Target approximately ${Math.floor(params.pageLimit / 10)} pages for this section.`,
  ].join("\n");
}

function parseSectionStructure(
  content: string,
): Array<{ number: string; title: string; requirements: string[] }> {
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]);
  } catch {
    return [{ number: "1.0", title: "Introduction", requirements: [] }];
  }
}
