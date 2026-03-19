/**
 * MinIO RPC Handler
 *
 * Manages artifact storage, retrieval, and listing via the official MinIO
 * JavaScript client (`minio` npm package). Provides an S3-compatible
 * object-storage layer for proposal documents, compliance artifacts,
 * generated volumes, and export packages.
 */

import * as Minio from "minio";
import { Readable } from "stream";
import type {
  Artifact,
  ArtifactMetadata,
  RPCResponse,
} from "../../shared/types";

// ── Public request/response shapes ──────────────────────────────────────

export interface UploadRequest {
  bucket: string;
  key: string;
  data: Uint8Array | string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface DownloadRequest {
  bucket: string;
  key: string;
}

export interface ListRequest {
  bucket: string;
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListResult {
  objects: ArtifactMetadata[];
  truncated: boolean;
  continuationToken?: string;
}

// ── MinIO RPC class ─────────────────────────────────────────────────────

export class MinioRPC {
  private client: Minio.Client;

  constructor(opts?: {
    endPoint?: string;
    port?: number;
    useSSL?: boolean;
    accessKey?: string;
    secretKey?: string;
  }) {
    const endPoint =
      opts?.endPoint ??
      (process.env.MINIO_ENDPOINT?.replace(/^https?:\/\//, "") ?? "localhost");
    const port = opts?.port ?? parseInt(process.env.MINIO_PORT ?? "9000", 10);
    const useSSL = opts?.useSSL ?? process.env.MINIO_USE_SSL === "true";
    const accessKey = opts?.accessKey ?? process.env.MINIO_USER ?? "aurelius";
    const secretKey =
      opts?.secretKey ?? process.env.MINIO_PASSWORD ?? "changeme123";

    this.client = new Minio.Client({
      endPoint,
      port,
      useSSL,
      accessKey,
      secretKey,
    });
  }

  // ── Upload ──────────────────────────────────────────────────────────

  /**
   * Upload an artifact to a MinIO bucket.
   * Automatically creates the bucket if it does not exist.
   */
  async upload(req: UploadRequest): Promise<RPCResponse<ArtifactMetadata>> {
    try {
      await this.ensureBucket(req.bucket);

      const body =
        typeof req.data === "string"
          ? Buffer.from(req.data, "utf-8")
          : Buffer.from(req.data);
      const contentType = req.contentType ?? "application/octet-stream";

      // Build metadata map (MinIO client expects plain object)
      const metaData: Record<string, string> = {
        "Content-Type": contentType,
        ...(req.metadata ?? {}),
      };

      const uploadResult = await this.client.putObject(
        req.bucket,
        req.key,
        body,
        body.length,
        metaData,
      );

      const metadata: ArtifactMetadata = {
        bucket: req.bucket,
        key: req.key,
        size: body.length,
        contentType,
        etag: (uploadResult.etag ?? "").replace(/"/g, ""),
        lastModified: Date.now(),
        userMetadata: req.metadata ?? {},
      };

      return { ok: true, data: metadata };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Download ────────────────────────────────────────────────────────

  /**
   * Download an artifact from a MinIO bucket.
   */
  async download(req: DownloadRequest): Promise<RPCResponse<Artifact>> {
    try {
      const stream = await this.client.getObject(req.bucket, req.key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const data = new Uint8Array(Buffer.concat(chunks));

      // Retrieve object metadata for content-type / etag
      const stat = await this.client.statObject(req.bucket, req.key);

      return {
        ok: true,
        data: {
          bucket: req.bucket,
          key: req.key,
          data,
          contentType: stat.metaData?.["content-type"] ?? "application/octet-stream",
          size: data.byteLength,
          etag: (stat.etag ?? "").replace(/"/g, ""),
        },
      };
    } catch (error: any) {
      if (error?.code === "NoSuchKey" || error?.code === "NotFound") {
        return { ok: false, error: `Object not found: ${req.bucket}/${req.key}` };
      }
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── List ────────────────────────────────────────────────────────────

  /**
   * List objects in a bucket with optional prefix filtering.
   */
  async list(req: ListRequest): Promise<RPCResponse<ListResult>> {
    try {
      const objects: ArtifactMetadata[] = [];
      const maxKeys = req.maxKeys ?? 1000;

      const stream = this.client.listObjectsV2(
        req.bucket,
        req.prefix ?? "",
        true, // recursive
      );

      let count = 0;
      for await (const obj of stream) {
        if (count >= maxKeys) break;

        objects.push({
          bucket: req.bucket,
          key: obj.name ?? "",
          size: obj.size,
          contentType: "application/octet-stream", // listObjects doesn't return content-type
          etag: (obj.etag ?? "").replace(/"/g, ""),
          lastModified: obj.lastModified
            ? new Date(obj.lastModified).getTime()
            : Date.now(),
          userMetadata: {},
        });
        count++;
      }

      return {
        ok: true,
        data: {
          objects,
          truncated: count >= maxKeys,
          continuationToken: undefined,
        },
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────

  /**
   * Delete an object from a bucket.
   */
  async delete(req: DownloadRequest): Promise<RPCResponse<void>> {
    try {
      await this.client.removeObject(req.bucket, req.key);
      return { ok: true, data: undefined };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Exists ──────────────────────────────────────────────────────────

  /**
   * Check whether an object exists in a bucket.
   */
  async exists(req: DownloadRequest): Promise<RPCResponse<boolean>> {
    try {
      await this.client.statObject(req.bucket, req.key);
      return { ok: true, data: true };
    } catch (error: any) {
      if (error?.code === "NotFound" || error?.code === "NoSuchKey") {
        return { ok: true, data: false };
      }
      return { ok: true, data: false };
    }
  }

  // ── Presigned URL ───────────────────────────────────────────────────

  /**
   * Generate a presigned GET URL for temporary access.
   */
  async presignUrl(
    req: DownloadRequest & { expiresInSeconds?: number },
  ): Promise<RPCResponse<string>> {
    try {
      const expires = req.expiresInSeconds ?? 3600;
      const url = await this.client.presignedGetObject(
        req.bucket,
        req.key,
        expires,
      );
      return { ok: true, data: url };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Bucket management ──────────────────────────────────────────────

  /**
   * Ensure a bucket exists, creating it if necessary.
   */
  async ensureBucket(bucket: string): Promise<RPCResponse<void>> {
    try {
      const exists = await this.client.bucketExists(bucket);
      if (!exists) {
        await this.client.makeBucket(bucket);
      }
      return { ok: true, data: undefined };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /**
   * List all buckets.
   */
  async listBuckets(): Promise<RPCResponse<string[]>> {
    try {
      const buckets = await this.client.listBuckets();
      return { ok: true, data: buckets.map((b) => b.name) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Health check ───────────────────────────────────────────────────

  /**
   * Verify MinIO connectivity by listing buckets.
   */
  async healthCheck(): Promise<RPCResponse<{ healthy: boolean }>> {
    try {
      await this.client.listBuckets();
      return { ok: true, data: { healthy: true } };
    } catch {
      return { ok: true, data: { healthy: false } };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
