/**
 * PDF Parsing Task
 *
 * Extracts text, metadata, and structure from PDF documents.
 * Supports RFP documents, proposal drafts, and compliance artifacts.
 * Stores extracted content in MinIO for downstream processing.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import * as Minio from "minio";
import { TASK_DEFAULTS, MINIO_CONFIG } from "../client";

const ParsePdfPayload = z.object({
  /** PDF file key in MinIO */
  fileKey: z.string(),
  /** Source bucket */
  bucket: z.string().default("rfp-inbox"),
  /** Output bucket for extracted content */
  outputBucket: z.string().default("proposals"),
  /** Whether to extract document structure (headings, sections) */
  extractStructure: z.boolean().default(true),
  /** Whether to extract tables */
  extractTables: z.boolean().default(true),
  /** Page range to extract (null = all) */
  pageRange: z.object({
    start: z.number().min(1),
    end: z.number().min(1),
  }).optional(),
});

export type ParsePdfPayload = z.infer<typeof ParsePdfPayload>;

export interface ParsedDocument {
  fileKey: string;
  pageCount: number;
  text: string;
  metadata: DocumentMetadata;
  sections: DocumentSection[];
  tables: DocumentTable[];
}

export interface DocumentMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  creator: string | null;
  creationDate: string | null;
  pageCount: number;
  fileSize: number;
}

export interface DocumentSection {
  title: string;
  level: number;
  pageStart: number;
  content: string;
}

export interface DocumentTable {
  pageNumber: number;
  rows: string[][];
  caption?: string;
}

const minioClient = new Minio.Client(MINIO_CONFIG);

export const parsePdf = task({
  id: "parse-pdf",
  retry: {
    maxAttempts: TASK_DEFAULTS.maxRetries,
    factor: TASK_DEFAULTS.retryBackoffFactor,
    minTimeoutInMs: TASK_DEFAULTS.retryMinDelaySeconds * 1000,
    maxTimeoutInMs: TASK_DEFAULTS.retryMaxDelaySeconds * 1000,
  },
  run: async (payload: unknown) => {
    const params = ParsePdfPayload.parse(payload);

    logger.info("Parsing PDF", {
      fileKey: params.fileKey,
      bucket: params.bucket,
      extractStructure: params.extractStructure,
    });

    // Fetch PDF from MinIO using the official client
    const pdfStream = await minioClient.getObject(params.bucket, params.fileKey);
    const pdfChunks: Buffer[] = [];
    for await (const chunk of pdfStream) {
      pdfChunks.push(Buffer.from(chunk));
    }
    const pdfBuffer = Buffer.concat(pdfChunks);
    const fileSize = pdfBuffer.length;

    // Parse PDF using pdf-parse
    // Dynamic import to handle the CommonJS module
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(pdfBuffer, {
      pagerender: undefined,
      max: params.pageRange?.end ?? 0,
    });

    const metadata: DocumentMetadata = {
      title: parsed.info?.Title ?? null,
      author: parsed.info?.Author ?? null,
      subject: parsed.info?.Subject ?? null,
      creator: parsed.info?.Creator ?? null,
      creationDate: parsed.info?.CreationDate ?? null,
      pageCount: parsed.numpages,
      fileSize,
    };

    // Extract document structure from text
    const sections = params.extractStructure
      ? extractSections(parsed.text)
      : [];

    // Extract tables (simplified heuristic)
    const tables = params.extractTables
      ? extractTables(parsed.text)
      : [];

    const result: ParsedDocument = {
      fileKey: params.fileKey,
      pageCount: parsed.numpages,
      text: parsed.text,
      metadata,
      sections,
      tables,
    };

    // Ensure output bucket exists
    const outputBucketExists = await minioClient.bucketExists(params.outputBucket);
    if (!outputBucketExists) {
      await minioClient.makeBucket(params.outputBucket);
    }

    // Store extracted content
    const outputKey = params.fileKey.replace(/\.pdf$/i, ".parsed.json");
    const resultJson = Buffer.from(JSON.stringify(result), "utf-8");
    await minioClient.putObject(
      params.outputBucket,
      outputKey,
      resultJson,
      resultJson.length,
      { "Content-Type": "application/json" },
    );

    // Store raw text separately for search/indexing
    const textKey = params.fileKey.replace(/\.pdf$/i, ".txt");
    const textBuffer = Buffer.from(parsed.text, "utf-8");
    await minioClient.putObject(
      params.outputBucket,
      textKey,
      textBuffer,
      textBuffer.length,
      { "Content-Type": "text/plain" },
    );

    logger.info("PDF parsed", {
      pageCount: parsed.numpages,
      textLength: parsed.text.length,
      sections: sections.length,
      tables: tables.length,
    });

    return {
      success: true,
      output: {
        pageCount: parsed.numpages,
        textLength: parsed.text.length,
        sectionCount: sections.length,
        tableCount: tables.length,
        metadata,
      },
      metrics: {
        pages: parsed.numpages,
        characters: parsed.text.length,
        fileSizeBytes: fileSize,
      },
      artifacts: [
        `${params.outputBucket}/${outputKey}`,
        `${params.outputBucket}/${textKey}`,
      ],
    };
  },
});

/**
 * Extract section structure from parsed text using heading patterns.
 */
function extractSections(text: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const lines = text.split("\n");

  // Common heading patterns in federal documents
  const headingPatterns = [
    { regex: /^(\d+\.)\s+(.+)$/, level: 1 },
    { regex: /^(\d+\.\d+)\s+(.+)$/, level: 2 },
    { regex: /^(\d+\.\d+\.\d+)\s+(.+)$/, level: 3 },
    { regex: /^([A-Z][A-Z\s]{3,})$/, level: 1 },
    { regex: /^(Section\s+\d+[.:]\s*)(.+)/i, level: 1 },
  ];

  let currentSection: DocumentSection | null = null;
  let contentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let matched = false;
    for (const pattern of headingPatterns) {
      const match = line.match(pattern.regex);
      if (match) {
        // Save previous section
        if (currentSection) {
          currentSection.content = contentLines.join("\n").trim();
          sections.push(currentSection);
        }

        currentSection = {
          title: match[2] ?? match[1],
          level: pattern.level,
          pageStart: Math.floor(i / 50) + 1, // Approximate page number
          content: "",
        };
        contentLines = [];
        matched = true;
        break;
      }
    }

    if (!matched) {
      contentLines.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.content = contentLines.join("\n").trim();
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Extract table-like structures from text using alignment heuristics.
 */
function extractTables(text: string): DocumentTable[] {
  const tables: DocumentTable[] = [];
  const lines = text.split("\n");

  let tableRows: string[][] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect table-like rows (multiple whitespace-separated columns)
    const columns = line.split(/\s{2,}/).filter((c) => c.trim());

    if (columns.length >= 3) {
      if (!inTable) inTable = true;
      tableRows.push(columns);
    } else if (inTable && columns.length < 3) {
      if (tableRows.length >= 2) {
        tables.push({
          pageNumber: Math.floor(i / 50) + 1,
          rows: tableRows,
        });
      }
      tableRows = [];
      inTable = false;
    }
  }

  // Capture trailing table
  if (tableRows.length >= 2) {
    tables.push({
      pageNumber: Math.floor(lines.length / 50) + 1,
      rows: tableRows,
    });
  }

  return tables;
}
