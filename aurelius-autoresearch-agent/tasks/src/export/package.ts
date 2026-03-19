/**
 * Export Packaging Task
 *
 * Assembles final proposal packages from individual volumes and
 * supporting documents. Creates submission-ready ZIP archives with
 * proper directory structure and file naming conventions.
 */

import { task, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { TASK_DEFAULTS, MINIO_CONFIG, OPA_CONFIG } from "../client";

const ExportPayload = z.object({
  /** Solicitation number */
  solicitationNumber: z.string(),
  /** Volumes to include in the package */
  volumes: z.array(
    z.object({
      type: z.string(),
      key: z.string(),
      filename: z.string(),
    }),
  ),
  /** Supporting documents to include */
  supportingDocs: z.array(
    z.object({
      key: z.string(),
      filename: z.string(),
      category: z.string(),
    }),
  ).default([]),
  /** Package format */
  format: z.enum(["zip", "tar.gz"]).default("zip"),
  /** Whether to run final compliance checks before packaging */
  runComplianceCheck: z.boolean().default(true),
  /** Output bucket */
  outputBucket: z.string().default("exports"),
});

export type ExportPayload = z.infer<typeof ExportPayload>;

export interface PackageResult {
  packageKey: string;
  packageSize: number;
  fileCount: number;
  complianceCheckPassed: boolean | null;
  contents: string[];
  createdAt: string;
}

export const exportPackage = task({
  id: "export-package",
  retry: {
    maxAttempts: TASK_DEFAULTS.maxRetries,
  },
  run: async (payload: unknown) => {
    const params = ExportPayload.parse(payload);

    logger.info("Packaging proposal export", {
      solicitationNumber: params.solicitationNumber,
      volumeCount: params.volumes.length,
      supportingDocCount: params.supportingDocs.length,
    });

    // Run compliance check if requested
    let complianceCheckPassed: boolean | null = null;

    if (params.runComplianceCheck) {
      complianceCheckPassed = await runPreExportChecks(params);
      if (!complianceCheckPassed) {
        logger.warn("Pre-export compliance check failed");
      }
    }

    // Collect all files
    const files: Array<{ path: string; data: Buffer }> = [];

    // Fetch volumes
    for (const volume of params.volumes) {
      const response = await fetch(
        `${MINIO_CONFIG.endpoint}/volumes/${volume.key}`,
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch volume: ${volume.key}`);
      }

      const data = Buffer.from(await response.arrayBuffer());
      files.push({
        path: `${params.solicitationNumber}/volumes/${volume.filename}`,
        data,
      });
    }

    // Fetch supporting documents
    for (const doc of params.supportingDocs) {
      const response = await fetch(
        `${MINIO_CONFIG.endpoint}/proposals/${doc.key}`,
      );

      if (!response.ok) {
        logger.warn(`Failed to fetch supporting doc: ${doc.key}`);
        continue;
      }

      const data = Buffer.from(await response.arrayBuffer());
      files.push({
        path: `${params.solicitationNumber}/supporting/${doc.category}/${doc.filename}`,
        data,
      });
    }

    // Create manifest
    const manifest = {
      solicitationNumber: params.solicitationNumber,
      createdAt: new Date().toISOString(),
      complianceCheckPassed,
      contents: files.map((f) => f.path),
    };

    files.push({
      path: `${params.solicitationNumber}/MANIFEST.json`,
      data: Buffer.from(JSON.stringify(manifest, null, 2)),
    });

    // Create archive using archiver
    const archiver = (await import("archiver")).default;
    const { Writable } = await import("stream");

    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        chunks.push(chunk);
        callback();
      },
    });

    const archive = archiver(params.format === "zip" ? "zip" : "tar", {
      gzip: params.format === "tar.gz",
      zlib: { level: 9 },
    });

    const archivePromise = new Promise<void>((resolve, reject) => {
      writable.on("finish", resolve);
      archive.on("error", reject);
    });

    archive.pipe(writable);

    for (const file of files) {
      archive.append(file.data, { name: file.path });
    }

    await archive.finalize();
    await archivePromise;

    const packageBuffer = Buffer.concat(chunks);
    const extension = params.format === "zip" ? "zip" : "tar.gz";
    const packageKey = `${params.solicitationNumber}/proposal_package.${extension}`;

    // Upload package to MinIO
    await fetch(`${MINIO_CONFIG.endpoint}/${params.outputBucket}/${packageKey}`, {
      method: "PUT",
      headers: {
        "Content-Type":
          params.format === "zip"
            ? "application/zip"
            : "application/gzip",
      },
      body: packageBuffer,
    });

    const result: PackageResult = {
      packageKey,
      packageSize: packageBuffer.length,
      fileCount: files.length,
      complianceCheckPassed,
      contents: files.map((f) => f.path),
      createdAt: new Date().toISOString(),
    };

    logger.info("Export package created", {
      packageKey,
      packageSize: packageBuffer.length,
      fileCount: files.length,
    });

    return {
      success: true,
      output: result,
      metrics: {
        fileCount: files.length,
        packageSizeBytes: packageBuffer.length,
      },
      artifacts: [`${params.outputBucket}/${packageKey}`],
    };
  },
});

async function runPreExportChecks(params: ExportPayload): Promise<boolean> {
  try {
    const response = await fetch(
      `${OPA_CONFIG.endpoint}/v1/data/constraints/federal_proposal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: {
            operation: "export_package",
            proposal: {
              solicitation_number: params.solicitationNumber,
              volume_count: params.volumes.length,
            },
          },
        }),
      },
    );

    const result = (await response.json()) as { result: { allow: boolean } };
    return result.result?.allow ?? false;
  } catch (error) {
    logger.warn("Pre-export compliance check failed", { error });
    return false;
  }
}
